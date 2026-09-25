import type { Application, Offer, Placement } from "@/data/types";
import { dateAt } from "@/lib/format";
import { makeOffer, recordPlacement, respondToOffer } from "@/app/actions";
import { SubmitButton } from "./Submit";

/**
 * The offer, on the candidate.
 *
 * Only shown once a candidate is somewhere an offer could plausibly be made.
 * Before that it is noise on a screen that already has plenty, and a form that
 * cannot sensibly be used is worse than no form.
 *
 * The platform tracks as far as Offer and Placed, with a joining date, and no
 * further — no fees, invoices or guarantees. It is the TAs' tool, not
 * operations' (13 September). The joining date is what the joining-day call
 * runs off.
 */

const OFFERABLE = ["client_shortlist", "interview", "offer", "placed"];

export function ClosingPanel({
  app,
  openingId,
  offer,
  placement,
  expectedSalary,
  locked = false,
}: {
  app: Application;
  openingId: string;
  offer: Offer | undefined;
  placement: Placement | undefined;
  expectedSalary: string | null;
  /** Someone else's candidate, or a seat that reads only. */
  locked?: boolean;
}) {
  if (!OFFERABLE.includes(app.stage)) return null;
  if (locked && !offer && !placement) return null;

  const box = "rounded-2xl border border-rule bg-surface p-5 shadow-[0_1px_2px_rgba(23,28,24,0.04)]";
  const input = "w-full rounded border border-rule bg-paper px-2.5 py-1.5 text-[13px]";
  const label = "mb-1 block text-[11px] uppercase tracking-[0.08em] text-ink-faint";

  if (placement) {
    return (
      <div className={`mt-3 ${box}`}>
        <h2 className="text-[13px] font-semibold">Placed</h2>
        <p className="mt-1 text-[12.5px] text-ink-soft">
          Joining {dateAt(placement.joinDate)}. The morning they start, you are reminded to call
          and check they arrived.
        </p>
      </div>
    );
  }

  if (offer && offer.status === "pending" && !locked) {
    return (
      <div className={`mt-3 ${box}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-[13px] font-semibold">Offer out</h2>
          <span className="text-[12px] text-ink-faint">Made {dateAt(offer.createdAt)}</span>
        </div>
        <p className="mt-1 text-[12.5px]">
          {offer.currency} {offer.salary.toLocaleString()}{" "}
          {offer.salaryBasis === "monthly" ? "a month" : "a year"}
          {offer.startDate ? ` · starting ${dateAt(offer.startDate)}` : " · no start date agreed"}
        </p>
        {offer.terms && <p className="mt-1 text-[12px] text-ink-soft">{offer.terms}</p>}

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <form action={recordPlacement} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="offerId" value={offer.id} />
            <input type="hidden" name="applicationId" value={app.id} />
            <input type="hidden" name="openingId" value={openingId} />
            <label className="block">
              <span className={label}>They accepted — join date</span>
              <input
                type="date"
                name="joinDate"
                defaultValue={
                  offer.startDate ? new Date(offer.startDate).toISOString().slice(0, 10) : ""
                }
                className={input}
              />
            </label>
            <SubmitButton
              pendingLabel="Placing…"
              className="rounded bg-ink px-3 py-1.5 text-[12.5px] font-medium text-surface disabled:opacity-60"
            >
              Place
            </SubmitButton>
          </form>

          <form action={respondToOffer} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="offerId" value={offer.id} />
            <input type="hidden" name="applicationId" value={app.id} />
            <input type="hidden" name="openingId" value={openingId} />
            <input type="hidden" name="status" value="declined" />
            <label className="min-w-0 flex-1">
              <span className={label}>They turned it down — why</span>
              <input name="reason" placeholder="Counter-offered" className={input} />
            </label>
            <SubmitButton
              tone="dark"
              pendingLabel="Recording…"
              className="rounded border border-rule-strong px-3 py-1.5 text-[12.5px] font-medium disabled:opacity-60"
            >
              Decline
            </SubmitButton>
          </form>
        </div>
      </div>
    );
  }

  if (offer && offer.status !== "pending") {
    return (
      <div className={`mt-3 ${box}`}>
        <h2 className="text-[13px] font-semibold">Offer {offer.status}</h2>
        <p className="mt-1 text-[12.5px] text-ink-soft">
          {offer.currency} {offer.salary.toLocaleString()}
          {offer.declineReason ? ` — ${offer.declineReason}` : ""}
        </p>
      </div>
    );
  }

  return (
    <div className={`mt-3 ${box}`}>
      <h2 className="text-[13px] font-semibold">Make an offer</h2>
      <form action={makeOffer} className="mt-2.5 grid gap-2.5">
        <input type="hidden" name="applicationId" value={app.id} />
        <input type="hidden" name="openingId" value={openingId} />
        <div className="grid gap-2.5 sm:grid-cols-4">
          <label className="block">
            <span className={label}>Salary</span>
            <input
              name="salary"
              placeholder={expectedSalary ?? "600000"}
              className={input}
            />
          </label>
          <label className="block">
            <span className={label}>Per</span>
            <select name="salaryBasis" className={input}>
              <option value="monthly">month</option>
              <option value="annual">year</option>
            </select>
          </label>
          <label className="block">
            <span className={label}>Currency</span>
            <select name="currency" className={input}>
              <option value="LKR">LKR</option>
              <option value="USD">USD</option>
            </select>
          </label>
          <label className="block">
            <span className={label}>Start date</span>
            <input type="date" name="startDate" className={input} />
          </label>
        </div>
        <label className="block">
          <span className={label}>Package on top of the basic</span>
          <input name="terms" placeholder="Vehicle, fuel, driver allowance" className={input} />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton
            pendingLabel="Recording…"
            className="rounded bg-ink px-3.5 py-1.5 text-[12.5px] font-medium text-surface disabled:opacity-60"
          >
            Record the offer
          </SubmitButton>
          <span className="text-[11.5px] text-ink-faint">
            {expectedSalary
              ? `They asked for ${expectedSalary}.`
              : "No expected salary on file for them."}
          </span>
        </div>
      </form>
    </div>
  );
}
