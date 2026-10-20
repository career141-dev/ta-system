import { NextResponse, type NextRequest } from "next/server";
import { primeStore } from "@/data/prime";
import { currentUser } from "@/lib/session";
import { searchLookalikes } from "@/lib/lookalikeMatch";
import type { ReferenceCvBlueprint } from "@/lib/referenceCv";
import { safeErrorMessage } from "@/lib/userError";

export async function POST(req: NextRequest) {
  await primeStore({ allApplications: true });
  const user = await currentUser();
  if (!user) {
    return NextResponse.json({ ok: false, message: "Please sign in again." }, { status: 401 });
  }

  try {
    const body = await req.json();
    const blueprint = body.blueprint as ReferenceCvBlueprint;
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const limit = typeof body.limit === "number" && body.limit > 0 ? Math.min(body.limit, 100) : 50;

    if (!blueprint || !blueprint.targetTitle) {
      return NextResponse.json({ ok: false, message: "Invalid reference blueprint." }, { status: 400 });
    }

    const results = await searchLookalikes(blueprint, prompt, limit);
    return NextResponse.json({ ok: true, results });
  } catch (err) {
    console.error("[api/lookalike/search]", err);
    return NextResponse.json({ ok: false, message: safeErrorMessage(err, "The search could not run. Try again.") }, { status: 500 });
  }
}
