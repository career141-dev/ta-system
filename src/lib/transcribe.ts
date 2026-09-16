import "server-only";

import { SpendCapError, reserve } from "./spend";

/**
 * A spoken brief, as text — OpenAI's speech-to-text.
 *
 * A lead or TA records the client call (or talks the role through) instead of
 * typing it. The words come back into the notes box, where the person reads
 * and corrects them before saving, and from there they feed the JD draft and
 * the Job details like anything typed.
 *
 * gpt-4o-transcribe by default: Sri Lankan English with job titles, company
 * names and qualifications (CIMA, ACCA) is exactly where the smaller models
 * slip. C141_TRANSCRIBE_MODEL overrides it (gpt-4o-mini-transcribe, whisper-1).
 */

/** OpenAI refuses audio files above 25 MB. */
export const TRANSCRIBE_MAX_BYTES = 25 * 1024 * 1024;

/** Listed price, USD per minute of audio (gpt-4o-transcribe, whisper-1). */
const USD_PER_MINUTE = 0.006;

/** Words the recogniser should expect on this desk. */
const VOCABULARY =
  "Career141 recruitment brief. Sri Lanka, Colombo, LKR, salary package, notice period, CIMA, ACCA, CA Sri Lanka, " +
  "MBA, FMCG, apparel, JD, TA, headhunting, shortlist, client, vehicle allowance, fuel allowance.";

export type TranscribeResult =
  | { ok: true; text: string; model: string }
  | { ok: false; reason: "no_key" | "too_large" | "empty" | "spend_cap" | "failed"; detail?: string };

export function transcriptionModel(): string {
  return (process.env.C141_TRANSCRIBE_MODEL ?? "").trim() || "gpt-4o-transcribe";
}

export async function transcribeAudio(audio: Blob, fileName: string, durationMs: number | null): Promise<TranscribeResult> {
  const key = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!key) return { ok: false, reason: "no_key" };
  if (audio.size === 0) return { ok: false, reason: "empty" };
  if (audio.size > TRANSCRIBE_MAX_BYTES) return { ok: false, reason: "too_large" };

  const model = transcriptionModel();
  // An unknown length is reserved as the longest a 25 MB webm could be.
  const minutes = durationMs && durationMs > 0 ? durationMs / 60_000 : 60;
  let settle: (usd: number) => void;
  try {
    settle = reserve(`transcribe · ${model}`, Math.max(0.01, minutes * USD_PER_MINUTE * 1.5));
  } catch (e) {
    if (e instanceof SpendCapError) return { ok: false, reason: "spend_cap", detail: e.message };
    throw e;
  }

  let cost = Number.NaN;
  try {
    const form = new FormData();
    form.append("file", audio, fileName);
    form.append("model", model);
    form.append("response_format", "json");
    form.append("prompt", VOCABULARY);
    const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: form,
    });
    if (!res.ok) {
      return { ok: false, reason: "failed", detail: `${res.status} ${(await res.text()).slice(0, 200)}` };
    }
    const json = (await res.json()) as { text?: string };
    cost = durationMs && durationMs > 0 ? (durationMs / 60_000) * USD_PER_MINUTE : Number.NaN;
    const text = (json.text ?? "").trim();
    if (!text) return { ok: false, reason: "empty" };
    return { ok: true, text, model };
  } catch (e) {
    return { ok: false, reason: "failed", detail: (e as Error).message };
  } finally {
    settle(cost);
  }
}
