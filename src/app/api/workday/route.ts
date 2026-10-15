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
  try {
    const payload = await convexQuery<WorkdayPayload>("ta/workdays:dashboard", {
      actorId: user.id,
      detail: new URL(request.url).searchParams.get("detail") === "1",
      cursor: new URL(request.url).searchParams.get("cursor") || undefined,
      date: new URL(request.url).searchParams.get("date") || undefined,
      focusWorkday: new URL(request.url).searchParams.get("checkDay") || undefined,
    });
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: "Could not load workday checks. Retry before finishing work." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
