import { redirect } from "next/navigation";
import { pageUser } from "@/lib/session";
import { convexActorForEmail, convexQuery } from "@/lib/convexServer";
import { SubmitButton } from "@/components/Submit";
import { confirmShortlistReply, ignoreShortlistReply, keepShortlistReplyForReview, rematchShortlistReply } from "./actions";

type Outcome = "shortlisted" | "rejected" | "hold";
type Item = {
  id: string;
  receivedAt: number;
  fromAddress: string;
  subject: string;
  replyText: string;
  status: "pending" | "auto_applied" | "review_required" | "confirmed" | "ignored";
  matchNote: string;
  reviewReasons: string[];
  openingTitle: string | null;
  clientName: string | null;
  roundId?: string;
  decisions: { applicationId: string; outcome: Outcome; evidence: string }[];
  roster: { applicationId: string; name: string; stage: string }[];
  reviewNote?: string;
};

const REVIEWERS = new Set(["admin", "director", "ta_lead", "ops"]);
const statusLabel: Record<Item["status"], string> = {
  pending: "Reading",
  auto_applied: "Applied automatically",
  review_required: "Needs review",
  confirmed: "Confirmed",
  ignored: "Ignored",
};

export default async function ShortlistDecisionsPage() {
  const user = await pageUser("database.read");
  if (!REVIEWERS.has(user.role)) redirect("/");
  const actor = await convexActorForEmail(user.email);
  if (!actor) throw new Error("Your account is not connected to the backend.");
  const data = await convexQuery<{ items: Item[]; roundOptions: { id: string; openingId: string; label: string }[] }>(
    "mailIntake/decisions:list", { actorId: actor._id, limit: 100 },
  );
  const items = [...data.items].sort((a, b) => {
    const priority = (status: Item["status"]) => status === "review_required" || status === "pending" ? 0 : 1;
    return priority(a.status) - priority(b.status) || b.receivedAt - a.receivedAt;
  });

  return (
    <main className="mx-auto max-w-[1180px] px-4 py-7 sm:px-8 sm:py-9">
      <h1 className="text-[24px] font-semibold tracking-tight">Shortlist decisions</h1>
      <p className="mt-1.5 max-w-[82ch] text-[13px] leading-relaxed text-ink-soft">
        Replies received at shortlists@career141.com. Nothing marked “Needs review” changes a candidate until it is confirmed here.
      </p>

      <div className="mt-6 grid gap-4">
        {items.length === 0 && <p className="rounded-2xl border border-rule bg-surface p-8 text-center text-[13px] text-ink-soft">No shortlist replies have been recorded yet.</p>}
        {items.map((item) => {
          const proposed = new Map(item.decisions.map((decision) => [decision.applicationId, decision]));
          const open = item.status === "review_required" || item.status === "pending";
          return (
            <article key={item.id} className="rounded-2xl border border-rule bg-surface p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold">{item.subject || "(no subject)"}</p>
                  <p className="mt-0.5 text-[11.5px] text-ink-faint">
                    {item.fromAddress} · {new Date(item.receivedAt).toLocaleString("en-GB", { timeZone: "Asia/Colombo" })}
                  </p>
                  {(item.clientName || item.openingTitle) && <p className="mt-1 text-[12px] text-ink-soft">{item.clientName} · {item.openingTitle}</p>}
                </div>
                <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${open ? "bg-warn-soft text-warn" : item.status === "ignored" ? "bg-tag text-ink-faint" : "bg-brand-soft text-brand"}`}>
                  {statusLabel[item.status]}
                </span>
              </div>

              <blockquote className="mt-4 whitespace-pre-wrap rounded-xl bg-paper px-4 py-3 text-[12.5px] leading-relaxed text-ink">{item.replyText}</blockquote>
              <p className="mt-3 text-[11.5px] text-ink-faint">{item.matchNote}</p>
              {item.reviewReasons.length > 0 && <ul className="mt-2 list-disc space-y-1 pl-5 text-[11.5px] text-warn">{item.reviewReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}

              {open && (
                <>
                  <form action={rematchShortlistReply} className="mt-4 flex flex-wrap items-end gap-2 border-t border-rule pt-4">
                    <input type="hidden" name="reviewId" value={item.id} />
                    <label className="grid min-w-[280px] flex-1 gap-1 text-[11.5px] text-ink-soft">
                      Original candidate set
                      <select name="roundId" defaultValue={item.roundId ?? ""} required className="rounded-lg border border-rule bg-paper px-3 py-2 text-[12px] text-ink">
                        <option value="" disabled>Choose the correct client, role and set</option>
                        {data.roundOptions.map((round) => <option key={round.id} value={round.id}>{round.label}</option>)}
                      </select>
                    </label>
                    <SubmitButton pendingLabel="Matching…" className="rounded-full border border-rule px-3.5 py-2 text-[12px] font-medium">Use this set</SubmitButton>
                  </form>

                  {item.roster.length > 0 && (
                    <form action={confirmShortlistReply} className="mt-4">
                      <input type="hidden" name="reviewId" value={item.id} />
                      <div className="overflow-hidden rounded-xl border border-rule">
                        <table className="w-full text-left text-[12px]">
                          <thead className="bg-paper text-[10.5px] uppercase tracking-wider text-ink-faint"><tr><th className="px-3 py-2">Candidate</th><th className="px-3 py-2">Current stage</th><th className="px-3 py-2">Decision</th></tr></thead>
                          <tbody>{item.roster.map((candidate) => {
                            const decision = proposed.get(candidate.applicationId);
                            return <tr key={candidate.applicationId} className="border-t border-rule">
                              <td className="px-3 py-2.5 font-medium">{candidate.name}<input type="hidden" name={`evidence:${candidate.applicationId}`} value={decision?.evidence ?? "Confirmed from the shortlist reply"} /></td>
                              <td className="px-3 py-2.5 text-ink-soft">{candidate.stage}</td>
                              <td className="px-3 py-2.5"><select name={`decision:${candidate.applicationId}`} defaultValue={decision?.outcome ?? "skip"} className="rounded-lg border border-rule bg-paper px-2 py-1.5"><option value="skip">No decision</option><option value="shortlisted">Shortlisted</option><option value="rejected">Not shortlisted</option><option value="hold">Hold / optional</option></select></td>
                            </tr>;
                          })}</tbody>
                        </table>
                      </div>
                      <label className="mt-3 grid gap-1 text-[11.5px] text-ink-soft">Review note<input name="note" className="rounded-lg border border-rule bg-paper px-3 py-2 text-[12px] text-ink" placeholder="Optional correction or context" /></label>
                      <SubmitButton pendingLabel="Applying…" className="mt-3 rounded-full bg-brand px-4 py-2 text-[12px] font-semibold text-white">Confirm selected decisions</SubmitButton>
                    </form>
                  )}

                  <form action={keepShortlistReplyForReview} className="mt-4 flex flex-wrap items-end gap-2 border-t border-rule pt-4">
                    <input type="hidden" name="reviewId" value={item.id} />
                    <label className="grid min-w-[260px] flex-1 gap-1 text-[11.5px] text-ink-soft">Note for later<input name="note" className="rounded-lg border border-rule bg-paper px-3 py-2 text-[12px] text-ink" placeholder="Optional reason or question" /></label>
                    <SubmitButton pendingLabel="Saving…" className="rounded-full border border-rule px-3.5 py-2 text-[12px] font-medium">Keep for review</SubmitButton>
                  </form>

                  <form action={ignoreShortlistReply} className="mt-4 flex flex-wrap items-end gap-2 border-t border-rule pt-4">
                    <input type="hidden" name="reviewId" value={item.id} />
                    <label className="grid min-w-[260px] flex-1 gap-1 text-[11.5px] text-ink-soft">Reason for ignoring<input name="note" required className="rounded-lg border border-rule bg-paper px-3 py-2 text-[12px] text-ink" /></label>
                    <SubmitButton pendingLabel="Ignoring…" className="rounded-full border border-rule px-3.5 py-2 text-[12px] font-medium">Ignore email</SubmitButton>
                  </form>
                </>
              )}
              {!open && item.reviewNote && <p className="mt-3 text-[11.5px] text-ink-faint">Review note: {item.reviewNote}</p>}
            </article>
          );
        })}
      </div>
    </main>
  );
}
