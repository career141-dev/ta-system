import { repo } from "@/data/store";
import { timeAt } from "@/lib/format";

/**
 * Two records, kept apart.
 *
 * A call and a message are not the same thing and are not read for the same
 * reason. A call is a TA's account of a conversation that has already happened
 * — prose, written after the fact. A chat is the conversation itself, in the
 * candidate's own words, still running.
 *
 * Merging them into one "conversation" feed put a recruiter's summary of a
 * phone call in the same column as the candidate's WhatsApp reply, which reads
 * as though the candidate said it.
 */

/** Calls logged against this application, newest first. */
const OUTCOME_WORDS: Record<string, string> = {
  no_answer: "no answer",
  answered: "answered",
  callback: "asked to be called back",
  will_send: "will send the details",
  not_interested: "not interested",
};

export function CallLog({ applicationId }: { applicationId: string }) {
  const calls = repo.callFeedback(applicationId).slice().sort((a, b) => b.recordedAt - a.recordedAt);
  // Follow-up calls are logged with the contact history, and belong here with
  // the other calls rather than in the chat.
  const followUpCalls = repo
    .outreach(applicationId)
    .filter((m) => m.channel === "ai_call")
    .sort((a, b) => (b.sentAt ?? b.createdAt) - (a.sentAt ?? a.createdAt));

  if (calls.length === 0 && followUpCalls.length === 0) {
    return <p className="py-6 text-center text-[13px] text-ink-faint">No calls logged yet.</p>;
  }

  return (
    <ol className="flex flex-col gap-3">
      {followUpCalls.map((m) => (
        <li key={m.id} className="rounded-xl border border-rule bg-surface px-4 py-3">
          <div className="mb-1 flex flex-wrap items-baseline gap-x-2.5 text-[11px]">
            <span className="rounded bg-brand px-1.5 py-px font-medium text-white">Follow-up call</span>
            <span className="text-ink-soft">
              {OUTCOME_WORDS[m.callOutcome ?? ""] ?? "call"}
              {m.promisedAt ? ` · ${timeAt(m.promisedAt)}` : ""}
            </span>
            <span className="ml-auto text-ink-faint">
              {timeAt(m.sentAt ?? m.createdAt)}
              {m.byUserId && repo.user(m.byUserId)?.name ? ` · ${repo.user(m.byUserId)!.name}` : " · automatic"}
            </span>
          </div>
          {m.body && <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed">{m.body}</p>}
        </li>
      ))}
      {calls.map((f) => (
        <li key={f.id} className="rounded-xl border border-rule bg-surface px-4 py-3">
          <div className="mb-1 flex flex-wrap items-baseline gap-x-2.5 text-[11px]">
            <span
              className={`rounded px-1.5 py-px font-medium ${
                f.source === "ai_call" ? "bg-brand text-white" : "bg-paper text-ink-soft"
              }`}
            >
              {f.source === "ai_call" ? "Screening call" : "Call"}
            </span>
            <span className="text-ink-soft">
              {f.kind.replace(/_/g, " ")} — {f.outcome.replace(/_/g, " ")}
            </span>
            <span className="ml-auto text-ink-faint">
              {timeAt(f.recordedAt)}
              {repo.user(f.recordedBy)?.name ? ` · ${repo.user(f.recordedBy)!.name}` : ""}
            </span>
          </div>
          <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed">{f.body}</p>
        </li>
      ))}
    </ol>
  );
}

/**
 * The WhatsApp and email exchange, as a conversation.
 *
 * Sides drawn the way a messaging app draws them — ours on the left, theirs
 * indented and tinted — because the one thing a TA needs to see at a glance is
 * whether the last word was ours or theirs.
 */
export function Chat({ applicationId, channel }: { applicationId: string; channel?: "whatsapp" | "email" }) {
  const messages = repo.outreach(applicationId).filter((m) => m.channel !== "ai_call" && (!channel || m.channel === channel)).sort((a, b) => {
    const at = (m: (typeof a)) => m.sentAt ?? m.createdAt;
    return at(a) - at(b);
  });

  if (messages.length === 0) {
    return (
      <p className="py-6 text-center text-[13px] text-ink-faint">
        Nothing sent to them yet. Anything WhatsApped or emailed from the follow-up appears here.
      </p>
    );
  }

  return (
    <ol className="flex flex-col gap-2.5">
      {messages.map((m) => {
        const inbound = m.direction === "in";
        return (
          <li
            key={m.id}
            className={`max-w-[78%] rounded-xl border px-3.5 py-2.5 ${
              inbound
                ? "self-end border-brand-line bg-brand-soft/50"
                : "self-start border-rule bg-surface"
            }`}
          >
            <div className="mb-1 flex flex-wrap items-baseline gap-x-2 text-[10.5px] text-ink-faint">
              <span className="uppercase tracking-[0.07em]">
                {m.channel === "whatsapp" ? "WhatsApp" : "Email"}
              </span>
              <span>
                {inbound ? "from them" : `attempt ${m.attempt}`}
                {m.sentAt ? ` · ${timeAt(m.sentAt)}` : " · not sent"}
              </span>
            </div>
            {m.subject && <p className="mb-1 text-[12.5px] font-medium">{m.subject}</p>}
            <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed">{m.body}</p>
          </li>
        );
      })}
    </ol>
  );
}
