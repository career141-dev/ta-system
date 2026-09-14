import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/auth";
import { dataDir } from "@/data/dataDir";

/** A brief is minutes, not hours. Anything past this is not a brief. */
const MAX_BYTES = 40 * 1024 * 1024;

/**
 * Standalone storage for brief recordings: a file under .data/recordings.
 * Phase 8c points this at Cloudflare R2 — the rest of the flow stores only the
 * key, so nothing above this changes.
 */
export async function POST(req: Request) {
  // Only somebody signed in, who could open a role, can store a recording —
  // this endpoint wrote any upload from anyone to disk (audit finding 42).
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "signed_out" }, { status: 401 });
  if (!can(user, "opening.create").ok) return NextResponse.json({ error: "not_allowed" }, { status: 403 });

  const form = await req.formData();
  const file = form.get("audio");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "no audio" }, { status: 400 });
  }
  if (file.size === 0 || file.size > MAX_BYTES) {
    return NextResponse.json({ error: "size" }, { status: 413 });
  }
  if (file.type && !file.type.startsWith("audio/") && file.type !== "video/webm") {
    return NextResponse.json({ error: "not_audio" }, { status: 415 });
  }
  const dir = path.join(dataDir(), "recordings");
  fs.mkdirSync(dir, { recursive: true });
  const key = `rec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}.webm`;
  fs.writeFileSync(path.join(dir, key), Buffer.from(await file.arrayBuffer()));
  return NextResponse.json({ key });
}
