import { NextResponse } from "next/server";
import { currentUser } from "@/lib/session";
import { can } from "@/lib/auth";
import { convexMutation } from "@/lib/convexServer";
import { primeStore } from "@/data/prime";
import { transcribeAudio } from "@/lib/transcribe";

/** A brief is minutes, not hours. Anything past this is not a brief. */
const MAX_BYTES = 40 * 1024 * 1024;

/** Storing and transcribing a few minutes of audio can take a while. */
export const maxDuration = 300;

const TRANSCRIPT_PROBLEM: Record<string, string> = {
  no_key: "Transcription is not set up on this server (no OpenAI key), so type the key points instead.",
  too_large: "The recording is too long to transcribe in one go (over 25 MB). It is saved; type the key points.",
  empty: "No speech was picked up in the recording. Check the microphone, or type the key points.",
  spend_cap: "Transcription was not run: the test spending cap would be passed.",
  failed: "The recording is saved, but it could not be transcribed just now. Type the key points, or record again.",
};

/**
 * A spoken brief: stored, then turned into text.
 *
 * The recording goes to Convex file storage and the brief keeps only the key
 * (`convex:<storageId>`). The transcript is handed straight back to the screen
 * and added to the notes, where the person checks it before anything is saved
 * — a transcript is never written anywhere unread.
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
  const durationMs = Number(form.get("durationMs") ?? 0) || null;
  const fileName = file.type.includes("mp4") ? "brief.mp4" : file.type.includes("ogg") ? "brief.ogg" : "brief.webm";

  // Store and transcribe at the same time: neither needs the other.
  const [stored, transcript] = await Promise.all([
    (async () => {
      try {
        const uploadUrl = await convexMutation<string>("ta/storage:recordingUploadUrl", {});
        const put = await fetch(uploadUrl, {
          method: "POST",
          headers: { "content-type": file.type || "audio/webm" },
          body: Buffer.from(await file.arrayBuffer()),
        });
        if (!put.ok) return { key: null, error: `storage answered ${put.status}` };
        const { storageId } = (await put.json()) as { storageId: string };
        return { key: `convex:${storageId}`, error: null };
      } catch (e) {
        return { key: null, error: (e as Error).message };
      }
    })(),
    transcribeAudio(file, fileName, durationMs),
  ]);

  if (!stored.key) console.error("[recording] storing failed:", stored.error);
  if (!transcript.ok && transcript.reason !== "no_key") console.error("[recording] transcription:", transcript.reason, transcript.detail ?? "");

  // A transcript without a stored copy is still worth handing back: the words
  // are what the person needs, and the notes are what gets saved.
  if (!stored.key && !transcript.ok) {
    return NextResponse.json({ error: "upload_failed", detail: stored.error }, { status: 502 });
  }
  return NextResponse.json({
    key: stored.key,
    transcript: transcript.ok ? transcript.text : null,
    transcriptProblem: transcript.ok ? null : TRANSCRIPT_PROBLEM[transcript.reason],
    storageProblem: stored.key ? null : "The recording itself could not be stored, but its transcript is below.",
  });
}
