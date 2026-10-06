import { primeStore } from "@/data/prime";
import { currentUser } from "@/lib/session";
import { askDesk, snapshotCandidateIds, type AssistantTurn } from "@/lib/deskAssistant";
import { candidateIdsForIntent, looksLikeAction, propose, understand } from "@/lib/deskActions";
import { FAILURE_MESSAGE, type AiFailure } from "@/lib/ai";

/**
 * The desk assistant. Signed-in people only; each asks about their own scope
 * (lib/deskAssistant). A light per-person limit, so a stuck key or a loop
 * cannot run up the bill.
 */
const recent = new Map<string, number[]>();

export async function POST(req: Request) {
  // Load the store before reading it — this route has no page to do it first.
  await primeStore({ allApplications: true, followUps: true });
  const user = await currentUser();
  if (!user || !user.isActive) return Response.json({ error: "Sign in first." }, { status: 401 });
  const now = Date.now();
  const mine = (recent.get(user.id) ?? []).filter((t) => now - t < 60_000);
  if (mine.length >= 20) return Response.json({ error: "That's a lot of questions at once — try again in a minute." }, { status: 429 });
  recent.set(user.id, [...mine, now]);

  let body: { question?: unknown; history?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Could not read the question." }, { status: 400 });
  }
  const question = typeof body.question === "string" ? body.question : "";
  const history = Array.isArray(body.history)
    ? (body.history as AssistantTurn[])
        .filter((t) => t && (t.role === "user" || t.role === "assistant") && typeof t.text === "string")
        .slice(-6)
    : [];

  // A change is never made here: it comes back as a proposal to confirm.
  if (looksLikeAction(question)) {
    const intent = await understand(question);
    if (intent) {
      await primeStore({ allApplications: true, followUps: true, candidateIds: candidateIdsForIntent(user, intent.job) });
      return Response.json(propose(user, intent));
    }
  }

  // Numbers about now, not the 30-second cache, and the record of everyone the
  // snapshot will name — a match or an interview came back nameless before
  // (6 Oct). Read after the rate limit, so a loop cannot turn into reads.
  await primeStore({ allApplications: true, followUps: true, fresh: true });
  await primeStore({ candidateIds: snapshotCandidateIds(user, question.trim().slice(0, 600)) });

  const r = await askDesk(user, question, history);
  if (!r.ok) {
    const msg = r.reason === "empty" ? "Ask a question first." : FAILURE_MESSAGE[r.reason as AiFailure] ?? "That didn't work — try again.";
    return Response.json({ error: msg }, { status: r.reason === "empty" ? 400 : 502 });
  }
  return Response.json({ type: "answer", answer: r.answer, instant: r.instant });
}
