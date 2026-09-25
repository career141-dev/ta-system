import { repo } from "@/data/store";
import { CopyButton } from "./CopyButton";
import { draftsFor } from "@/lib/followup";
import { timeAt } from "@/lib/format";
import {
  logFollowUpReply,
  recordFollowUpAttempt,
  recordFollowUpCall,
  saveFollowUpAnswers,
} from "@/app/actions";
import { SubmitButton } from "@/components/SubmitButton";
import { SubmitButton as Submit } from "@/components/Submit";

/**
 * One candidate's follow-up day, beside everything else said to them.
 *
 * Shown on both tabs, because the day is calls AND messages: the Call log tab
 * records how a call went, the Chat tab carries the WhatsApp and email and the
 * reply. Both read the same engine, so they agree on what is owed next.
 */
export function FollowUpPanel({
  applicationId,
  openingId,
  taName,
  mode,
}: {
  applicationId: string;
  openingId: string;
  taName: string;
  mode: "call" | "chat";
}) {
  const f = repo.followUp(applicationId);
  if (!f) return null;
  const s = f.followUp;
  const next = s.next;
  const callOwed = !!next?.channels.includes("ai_call");
  const messageOwed = !!next && next.channels.some((c) => c !== "ai_call");

  const drafts =
    next && messageOwed
      ? draftsFor({
          candidate: f.candidate,
          missing: s.missing,
          roleTitle: f.opening.title,
          purpose: next.purpose,
          channels: next.channels,
          taName: taName.split(" ")[0],
        })
      : [];

  const tone =
    s.state === "overdue"
      ? "border-danger/40 bg-danger-soft/40"
      : s.state === "due"
        ? "border-warn/40 bg-warn-soft/50"
        : s.state === "complete"
          ? "border-brand-line bg-brand-soft/40"
          : "border-rule bg-paper";

  const status =
    s.state === "overdue"
      ? "day is up — yours now"
      : s.state === "complete"
        ? "everything is in"
        : s.state === "declined"
          ? "not interested"
          : s.state === "unreachable"
            ? "no way to reach them"
            : next
              ? next.at <= Date.now()
                ? `${callOwed ? "call" : "message"} owed now`
                : `next ${timeAt(next.at)}`
              : `day ends ${timeAt(s.deadline)}`;

  const field = "rounded border border-rule bg-surface px-2 py-1.5 text-[12.5px]";

  return (
    <div className={`rounded-xl border p-4 ${tone}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-semibold">Follow-up</h3>
        <span className="text-[11.5px] text-ink-faint">{status}</span>
      </div>

      {s.missing.length > 0 ? (
        <p className="mt-1 text-[12.5px] text-ink-soft">
          Still needed: {s.missing.map((q) => q.label.toLowerCase()).join(", ")}.
          <span className="text-ink-faint"> Day runs until {timeAt(s.deadline)}.</span>
        </p>
      ) : (
        <p className="mt-1 text-[12.5px] text-brand">Every question is answered.</p>
      )}

      {next && (
        <p className="mt-2 text-[12.5px]">
          <span className="font-medium">Next:</span>{" "}
          {next.channels.map((c) => (c === "ai_call" ? "AI call" : c === "whatsapp" ? "WhatsApp" : "Email")).join(" + ")}
          {" — "}
          <span className="text-ink-soft">{next.reason}</span>
        </p>
      )}
      {s.handBack && <p className="mt-2 max-w-[70ch] text-[12.5px] leading-relaxed text-ink-soft">{s.handBack}</p>}

      {/* ── Calls ── */}
      {mode === "call" && s.state !== "complete" && (
        <form action={recordFollowUpCall} className="mt-3 grid gap-2 border-t border-rule pt-3">
          <input type="hidden" name="applicationId" value={applicationId} />
          <input type="hidden" name="openingId" value={openingId} />
          <p className="text-[11px] uppercase tracking-[0.08em] text-ink-faint">
            {callOwed ? "Record the call" : "Record a call"}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <select name="outcome" defaultValue="no_answer" className={field}>
              <option value="no_answer">No answer</option>
              <option value="answered">Answered</option>
              <option value="callback">Call back at…</option>
              <option value="will_send">Will send details by…</option>
              <option value="not_interested">Not interested</option>
            </select>
            <input type="datetime-local" name="promisedAt" className={field} aria-label="Time they gave" />
            <input name="note" placeholder="What they said" className={`${field} min-w-[180px] flex-1`} />
            <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
          </div>
          <p className="text-[11px] text-ink-faint">
            The time only matters for a call-back or a promise to send. Colombo time.
          </p>
        </form>
      )}

      {/* ── Messages ── */}
      {mode === "chat" && next && drafts.length > 0 && (
        <>
          <div className="mt-3 grid gap-2">
            {drafts.map((d) => (
              <div key={d.channel} className="rounded border border-rule bg-surface p-3">
                <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2 text-[11px] text-ink-faint">
                  <span>
                    <span className="uppercase tracking-[0.08em]">{d.channel === "whatsapp" ? "WhatsApp" : "Email"}</span> · {d.to}
                  </span>
                  <CopyButton value={d.subject ? `${d.subject}\n\n${d.body}` : d.body} />
                </div>
                <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed">{d.body}</p>
              </div>
            ))}
          </div>
          <form action={recordFollowUpAttempt} className="mt-2 flex flex-wrap items-center gap-2">
            <input type="hidden" name="applicationId" value={applicationId} />
            <input type="hidden" name="openingId" value={openingId} />
            <select name="channel" className={field}>
              {drafts.length > 1 && <option value="both">Both</option>}
              {drafts.map((d) => (
                <option key={d.channel} value={d.channel}>
                  {d.channel === "whatsapp" ? "WhatsApp only" : "Email only"}
                </option>
              ))}
            </select>
            <Submit
              pendingLabel="Recording…"
              disabled={next.at > Date.now()}
              className="rounded bg-ink px-3 py-1.5 text-[12.5px] font-medium text-surface disabled:opacity-40"
            >
              {next.at > Date.now() ? `Due ${timeAt(next.at)}` : "Record as sent"}
            </Submit>
          </form>
        </>
      )}

      {mode === "chat" && s.state !== "complete" && (
        <form action={logFollowUpReply} className="mt-3 grid gap-2 border-t border-rule pt-3">
          <input type="hidden" name="applicationId" value={applicationId} />
          <input type="hidden" name="openingId" value={openingId} />
          <textarea
            name="body"
            rows={2}
            placeholder="They replied — paste it. Salary and notice are read out of it."
            className="w-full rounded border border-rule bg-surface px-2.5 py-2 text-[12.5px]"
          />
          <div className="flex flex-wrap items-center gap-2">
            <select name="channel" className={field}>
              <option value="whatsapp">WhatsApp</option>
              <option value="email">Email</option>
            </select>
            <Submit
              tone="dark"
              pendingLabel="Logging…"
              className="rounded border border-rule-strong px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-60"
            >
              Log the reply
            </Submit>
          </div>
        </form>
      )}

      {/* ── The answers themselves, however they arrived ── */}
      {s.missing.length > 0 && (
        <details className="mt-3 border-t border-rule pt-3">
          <summary className="cursor-pointer text-[12px] text-ink-soft">Type the answers in</summary>
          <form action={saveFollowUpAnswers} className="mt-2 grid gap-2">
            <input type="hidden" name="applicationId" value={applicationId} />
            <input type="hidden" name="openingId" value={openingId} />
            {s.missing.map((q) => (
              <label key={q.id} className="grid gap-1 sm:grid-cols-[170px_1fr] sm:items-center">
                <span className="text-[12px] text-ink-soft">{q.label}</span>
                <input name={q.field ? `std_${q.field}` : `q_${q.id}`} className={field} />
              </label>
            ))}
            <div>
              <SubmitButton pendingLabel="Saving…">Save answers</SubmitButton>
            </div>
          </form>
        </details>
      )}
    </div>
  );
}
