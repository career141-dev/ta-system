import Link from "next/link";
import { DAILY_EMAIL_LABEL, type DailyEmail } from "@/lib/dailyEmail";
import { timeAt } from "@/lib/format";
import { reconcileDailyEmail } from "@/app/actions";
import { SubmitButton } from "./Submit";

export function DailyEmailHistory({ emails, openingId }: { emails: DailyEmail[]; openingId: string }) {
  return <section className="mb-6 rounded-xl border border-rule bg-surface p-5">
    <h2 className="font-semibold">Email history</h2>
    {!emails.length ? <p className="mt-2 text-sm text-ink-soft">No emails yet. Use Add to start the first midday email.</p> :
      <ul className="mt-3 space-y-2">{emails.slice().sort((a, b) => b.date.localeCompare(a.date) || b.number - a.number).map(e =>
        <li key={e._id} className="flex flex-wrap justify-between gap-2 text-sm">
          <Link className="text-brand underline" href={`/openings/${openingId}/${e.submissionType === "midday" ? "midday" : "eod"}?mail=${e._id}`}>
            {e.date} · {e.submissionType === "midday" ? `Email ${e.number}` : e.parentId ? "Revised EOD" : "End of day"} · {DAILY_EMAIL_LABEL[e.status]}
          </Link>
          <span className="text-ink-soft">{e.applicationIds.length} candidates{e.acceptedAt ? ` · ${timeAt(e.acceptedAt)}` : ""}</span>
        </li>)}</ul>}
  </section>;
}

export function DailyEmailView({ email, openingId, canCorrect, canReconcile }: { email: DailyEmail; openingId: string; canCorrect: boolean; canReconcile: boolean }) {
  const copy = email.snapshot;
  return <section className="mb-6 rounded-xl border border-rule bg-surface p-5">
    <h2 className="font-semibold">{DAILY_EMAIL_LABEL[email.status]} · {email.date}</h2>
    {copy ? <>
      <dl className="my-4 space-y-1 text-sm">
        <div><dt className="inline font-medium">From: </dt><dd className="inline">{copy.from}</dd></div>
        <div><dt className="inline font-medium">To: </dt><dd className="inline">{copy.to.join(", ")}</dd></div>
        <div><dt className="inline font-medium">Cc: </dt><dd className="inline">{copy.cc.join(", ") || "None"}</dd></div>
        <div><dt className="inline font-medium">Subject: </dt><dd className="inline">{copy.subject}</dd></div>
        <div><dt className="inline font-medium">Attachments: </dt><dd className="inline">{copy.attachmentNames.join(", ") || "None"}</dd></div>
      </dl>
      <iframe title="Saved email content" sandbox="" srcDoc={`<!doctype html><meta charset="utf-8"><body style="font-family:Arial,sans-serif;padding:16px">${copy.html}</body>`} className="h-[560px] w-full bg-white" />
    </> : <p className="my-3 text-sm">The email content is no longer retained. Send records remain available.</p>}
    {email.status === "uncertain" || email.status === "sending" ? <p className="mt-3 text-sm">Do not send again. Ask the TA Lead to reconcile the result in Today’s Checks.</p> : null}
    {canReconcile && ["uncertain", "sending"].includes(email.status) && <form action={reconcileDailyEmail} className="mt-4 space-y-3">
      <input type="hidden" name="openingId" value={openingId} /><input type="hidden" name="dailyEmailId" value={email._id} />
      <label className="block text-sm">Mailbox verification and message reference<textarea name="reason" required maxLength={1000} className="block w-full rounded border border-rule p-2" /></label>
      <SubmitButton name="accepted" value="yes" className="mr-4 text-brand underline">Verified sent</SubmitButton>
      <SubmitButton name="accepted" value="no" className="text-brand underline">Verified not sent</SubmitButton>
    </form>}
    {email.status === "failed" && email.submissionType === "eod" && <Link className="mt-4 inline-block text-brand underline" href={`/openings/${openingId}/eod`}>Return to the composer to retry</Link>}
    {canCorrect && copy && email.status === "accepted" && email.submissionType === "eod" && !email.parentId &&
      <Link className="mt-4 inline-block text-brand underline" href={`/openings/${openingId}/eod?mail=${email._id}&revise=yes`}>Correct and send again</Link>}
  </section>;
}
