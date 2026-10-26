import { NextResponse } from "next/server";
import { primeStore } from "@/data/prime";
import { currentUser } from "@/lib/session";
import { convexQuery } from "@/lib/convexServer";
import type { WorkdayPayload } from "@/lib/workday";
import { canViewWorkday } from "@/lib/workdayRoles";

export async function GET(request: Request) {
  await primeStore({});
  const user = await currentUser();
  if (!user)
    return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  if (!canViewWorkday(user.role))
    return NextResponse.json(
      { error: "Workdays are not available for your role." },
      { status: 403 },
    );
  // Which backend call was running, for the log below.
  let step = "ta/workdays:dashboard";
  try {
    const payload = await convexQuery<WorkdayPayload>("ta/workdays:dashboard", {
      actorId: user.id,
      detail: new URL(request.url).searchParams.get("detail") === "1",
      cursor: new URL(request.url).searchParams.get("cursor") || undefined,
      taId: new URL(request.url).searchParams.get("ta") || undefined,
      date: new URL(request.url).searchParams.get("date") || undefined,
      focusWorkday: new URL(request.url).searchParams.get("checkDay") || undefined,
    });
    if (payload.canWork && new URL(request.url).searchParams.get("detail") === "1") {
      step = "ta/dailyEmails:sent";
      payload.sentEmails = await convexQuery("ta/dailyEmails:sent", { actorId: user.id });
    }
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (err) {
    // The panel shows only "Could not load workday checks"; reviewers saw a
    // 503 on every 20-second poll and the cause was nowhere (26 Oct). The
    // query string carries only the view asked for: date, page, TA and day ids.
    console.error("[api/workday]", step, `role=${user.role}`, new URL(request.url).search, err);
    return NextResponse.json(
      { error: "Could not load workday checks. Please retry." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
