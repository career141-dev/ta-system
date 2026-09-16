import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/auth";
import { convexMutation } from "@/lib/convexServer";
import { primeStore } from "@/data/prime";

/** A brief is minutes, not hours. Anything past this is not a brief. */
const MAX_BYTES = 40 * 1024 * 1024;

/**
 * Brief recordings go to Convex file storage. The brief stores only the key
 * (`convex:<storageId>`), so nothing above this knows where the bytes are.
 */
export async function POST(req: Request) {
  // Only somebody signed in, who could open a role, can store a recording —
  // this endpoint wrote any upload from anyone to disk (audit finding 42).
  // Knowing who is signed in reads the users table, so load it first.
  await primeStore({});
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
  const uploadUrl = await convexMutation<string>("ta/storage:recordingUploadUrl", {});
  const put = await fetch(uploadUrl, {
    method: "POST",
    headers: { "content-type": file.type || "audio/webm" },
    body: Buffer.from(await file.arrayBuffer()),
  });
  if (!put.ok) return NextResponse.json({ error: "upload_failed" }, { status: 502 });
  const { storageId } = (await put.json()) as { storageId: string };
  return NextResponse.json({ key: `convex:${storageId}` });
}
