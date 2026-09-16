import { convexQuery } from "@/lib/convexServer";
import { timeAt } from "@/lib/format";
import { stopFollowUpNow } from "@/app/actions";
import { FollowUpActions } from "./FollowUpActions";

/**
 * Follow-up, as it really happened — read from the backend, sent through it.
 *
 * The sequence is the older app's proven one: the first Send is the approved
 * WhatsApp template plus an email; each later Send is a reminder. Replies are
 * read by the backend and fill the checklist in. Nothing goes out by moving a
 * card — only this button starts it. With the opening's automatic follow-up
 * on, the reminders after the first Send go out by themselves, every 24 hours.
 */

interface State {
  attemptCount: number;
  autoFollowUp: boolean;
  nextScheduledAt: number | null;
  maxAttempts: number | null;
  lastCandidateReplyAt: number | null;
  flaggedForTaReview: boolean;
  taReviewReason: string | null;
  collected: { cv: boolean | null; currentSalary: boolean | null; expectedSalary: boolean | null; noticePeriod: boolean | null };
  customQuestions: string[];
  customAnswers: Record<string, string>;
}

interface Message {
  id: string;
  direction: string;
  channel: string;
  subject: string | null;
  body: string;
  deliveryStatus: string;
  legacyStatus: string | null;
  stoppedSequence: boolean;
  sentAt: number;
  errorMessage?: string | null;
}

interface Gate {
  live: boolean;
  testEmailSet: boolean;
  testPhoneSet: boolean;
  metaConfigured: boolean;
  graphSenderConfigured: boolean;
}

export async function LiveFollowUp({
  applicationId,
  openingId,
  actorId,
  locked,
  candidateName,
  roleTitle,
  hasPhone,
  hasEmail,
}: {
  applicationId: string;
  openingId: string;
  actorId: string;
  locked: boolean;
  candidateName: string;
  roleTitle: string;
  hasPhone: boolean;
  hasEmail: boolean;
}) {
  const [state, messages, gate] = await Promise.all([
    convexQuery<State | null>("ta/outreach:followUpState", { actorId, applicationId }).catch(() => null),
    convexQuery<Message[]>("ta/outreach:messagesFor", { actorId, applicationId, limit: 100 }).catch(() => []),
    convexQuery<Gate>("ta/followUp:gateStatus", {}).catch(() => null),
  ]);
  if (!state) return null;

  const max = state.maxAttempts ?? 3;
  const sent = state.attemptCount;
  const checklist: [string, boolean | null][] = [
    ["CV", state.collected.cv],
    ["Current salary", state.collected.currentSalary],
    ["Expected salary", state.collected.expectedSalary],
    ["Notice period", state.collected.noticePeriod],
    ...state.customQuestions.map((q): [string, boolean] => [q, !!state.customAnswers[q]]),
  ];
  const missing = checklist.filter(([, ok]) => !ok).length;
  const exhausted = sent >= max;

  return (
    <div className="flex flex-col gap-4">
      {gate && !gate.live && (
        <div className="rounded-lg border border-warn/40 bg-warn-soft/50 px-4 py-2.5 text-[12px] leading-relaxed">
          <b>Test mode.</b>{" "}
          {gate.testEmailSet || gate.testPhoneSet
            ? `Messages go only to the test ${[gate.testPhoneSet && "phone", gate.testEmailSet && "mailbox"].filter(Boolean).join(" and ")}, never to the candidate.`
            : "No test recipient is set, so nothing will be delivered."}
          {!gate.metaConfigured && " WhatsApp is not configured on the backend (META_ACCESS_TOKEN)."}
          {!gate.graphSenderConfigured && " Email has no sender mailbox (MS_SENDER_EMAIL)."}
        </div>
      )}

      <div className="rounded-xl border border-rule bg-paper p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-[13px] font-semibold">Follow-up</h3>
          <span className="text-[11.5px] text-ink-faint">
            {sent === 0 ? "nothing sent yet" : `${sent} of ${max} sent`}
            {state.lastCandidateReplyAt ? ` · last reply ${timeAt(state.lastCandidateReplyAt)}` : ""}
          </span>
        </div>

        <ul className="mt-3 grid gap-1 sm:grid-cols-2">
          {checklist.map(([label, ok]) => (
            <li key={label} className="flex items-center gap-2 text-[12.5px]">
              <span className={ok ? "text-brand" : "text-ink-faint"}>{ok ? "✓" : "○"}</span>
              <span className={ok ? "" : "text-ink-soft"}>{label}</span>
            </li>
          ))}
        </ul>

        {state.autoFollowUp && missing > 0 && !exhausted && (
          <p className="mt-3 text-[12px] text-ink-soft">
            {sent === 0
              ? "Automatic follow-up is on: after you send the first message, reminders go out every 24 hours by themselves."
              : state.nextScheduledAt
                ? `Automatic follow-up is on — next reminder ${timeAt(state.nextScheduledAt)}.`
                : "Automatic follow-up is on, but no reminder is scheduled (it was stopped)."}
          </p>
        )}

        {state.flaggedForTaReview && (
          <p className="mt-3 text-[12px] text-warn">Needs you: {state.taReviewReason ?? "flagged for review"}</p>
        )}

        {!locked && (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {missing === 0 ? (
              <span className="text-[12.5px] text-brand">Everything is in — ready for Director review.</span>
            ) : exhausted ? (
              <span className="text-[12.5px] text-ink-soft">All {max} follow-ups sent. Call them, or mark them as dropped out.</span>
            ) : (
              <>
                <span className="text-[12px] text-ink-faint">
                  {sent === 0 ? "First follow-up:" : `Follow-up ${sent + 1} of ${max}:`}
                </span>
                <FollowUpActions
                  applicationId={applicationId}
                  openingId={openingId}
                  candidateName={candidateName}
                  roleTitle={roleTitle}
                  hasPhone={hasPhone}
                  hasEmail={hasEmail}
                />
              </>
            )}
            {sent > 0 && missing > 0 && (
              <form action={stopFollowUpNow}>
                <input type="hidden" name="appId" value={applicationId} />
                <input type="hidden" name="openingId" value={openingId} />
                <button className="text-[12.5px] text-ink-faint hover:text-ink">Stop follow-up</button>
              </form>
            )}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-rule bg-surface">
        <div className="border-b border-rule px-4 py-2.5 text-[11px] uppercase tracking-[0.08em] text-ink-faint">
          Conversation
        </div>
        {messages.length === 0 ? (
          <p className="px-4 py-4 text-[12.5px] text-ink-faint">No messages yet.</p>
        ) : (
          <ul className="divide-y divide-rule">
            {messages.map((m) => {
              const out = m.direction === "outbound";
              const failed = m.deliveryStatus === "failed" || m.legacyStatus === "failed";
              return (
                <li key={m.id} className={`px-4 py-3 ${out ? "" : "bg-brand-soft/30"}`}>
                  <div className="flex flex-wrap items-baseline justify-between gap-2 text-[11.5px] text-ink-faint">
                    <span>
                      {out ? "Sent" : "Reply"} · {m.channel === "whatsapp" ? "WhatsApp" : m.channel === "email" ? "Email" : m.channel}
                      {m.subject ? ` · ${m.subject}` : ""}
                    </span>
                    <span className={failed ? "text-danger" : ""}>
                      {out ? (m.stoppedSequence ? "stopped" : m.deliveryStatus) : ""} {timeAt(m.sentAt)}
                    </span>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed">{m.body}</p>
                  {failed && m.errorMessage && <p className="mt-1 text-[11.5px] text-danger">{m.errorMessage}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
