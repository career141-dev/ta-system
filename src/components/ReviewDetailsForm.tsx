import { saveReviewDetails } from "@/app/actions";
import { inputClass } from "./form";

/**
 * What Director Review needs before it will take someone: current salary,
 * expected salary, notice period and a CV. The follow-up collects these, but a
 * TA who got them on a call, on WhatsApp or from LinkedIn had nowhere to type
 * them, so the move stayed refused. Entered here, they are saved on the
 * candidate record.
 */
export function ReviewDetailsForm({
  applicationId,
  openingId,
  currentSalary,
  expectedSalary,
  noticePeriodDays,
  hasCv,
}: {
  applicationId: string;
  openingId: string;
  currentSalary: string | null;
  expectedSalary: string | null;
  noticePeriodDays: number | null;
  hasCv: boolean;
}) {
  const missing = [
    !hasCv && "CV",
    !currentSalary?.trim() && "current salary",
    !expectedSalary?.trim() && "expected salary",
    noticePeriodDays == null && "notice period",
  ].filter(Boolean) as string[];

  return (
    <form
      action={saveReviewDetails}
      className="mt-3 rounded-xl border border-rule bg-surface px-5 py-4 text-[12.5px]"
    >
      <input type="hidden" name="applicationId" value={applicationId} />
      <input type="hidden" name="openingId" value={openingId} />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold">Details for Director review</h2>
        <span className={missing.length ? "text-warn" : "text-brand"}>
          {missing.length ? `Still needed: ${missing.join(", ")}` : "All details in"}
        </span>
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-3">
        <label>
          <span className="mb-1 block text-[11.5px] text-ink-soft">Current salary</span>
          <input name="currentSalary" defaultValue={currentSalary ?? ""} placeholder="SAR 12,000 a month" className={inputClass} />
        </label>
        <label>
          <span className="mb-1 block text-[11.5px] text-ink-soft">Expected salary</span>
          <input name="expectedSalary" defaultValue={expectedSalary ?? ""} placeholder="SAR 15,000 a month" className={inputClass} />
        </label>
        <label>
          <span className="mb-1 block text-[11.5px] text-ink-soft">Notice period (days)</span>
          <input name="noticePeriodDays" type="number" min={0} step={1} defaultValue={noticePeriodDays ?? ""} placeholder="30 (0 if immediate)" className={inputClass} />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-[11.5px] text-ink-faint">
          Write salaries with the amount, e.g. &ldquo;SAR 12,000&rdquo;, so they can be read.{" "}
          {hasCv ? "A CV is on file." : "No CV on file yet — uploading one from here is not built yet."}
        </p>
        <button className="rounded-full bg-brand px-4 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90">
          Save details
        </button>
      </div>
    </form>
  );
}
