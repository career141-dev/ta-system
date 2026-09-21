"use client";

import { INDUSTRIES, mapIndustry } from "../../convex/lib/jobRequirements";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import type { OpeningRequirements } from "@/data/types";
import { Field, Select, TokenInput, inputClass } from "@/components/form";
import { reextractJobDetailsInline, saveJobDetailsInline } from "@/app/actions";
import { ActionNote, SubmitButton, latest, submitted, useInline } from "@/components/Submit";

/**
 * Job details — the structured requirements matching and sourcing run on.
 *
 * Laid out like the older Create Job page's first step. The fields are read out
 * of the approved JD automatically; the TA checks them here and corrects what
 * is wrong. Anything saved from this form is kept when the JD is edited later
 * (only blanks are filled then); "Re-extract from JD" replaces everything.
 */

const SENIORITY = [
  ["entry_level", "Entry-Level"], ["mid_level", "Mid-Level"], ["executive", "Executive"],
  ["senior_executive", "Senior Executive"], ["manager", "Manager"], ["senior_manager", "Senior Manager"],
  ["agm", "AGM"], ["gm", "GM"], ["director", "Director"], ["c_suite", "C-Suite"], ["other", "Other"],
] as const;
// The one industry list — see convex/lib/jobRequirements.
const EDUCATION = [
  ["any", "Any"], ["diploma", "Diploma"], ["bachelor", "Bachelor's"], ["master", "Master's"], ["phd", "PhD"],
  ["professional_cert", "Professional certification"], ["bachelor_or_master", "Bachelor's or Master's"],
] as const;
const RECRUITMENT = [
  ["both", "Both (headhunting + posting)"], ["headhunting", "Headhunting (passive candidate search)"],
  ["job_posting", "Job Posting (active applicants)"],
] as const;
const STATUS = [["active", "Active"], ["draft", "Draft"], ["on_hold", "On hold"]] as const;

const opts = (list: readonly (readonly [string, string])[]) => list.map(([value, label]) => ({ value, label }));

export function JobDetailsPanel({
  openingId,
  title,
  requirements: r,
  jdApproved,
  canEdit,
  editedByName,
}: {
  openingId: string;
  title: string;
  requirements: OpeningRequirements;
  jdApproved: boolean;
  canEdit: boolean;
  editedByName: string | null;
}) {
  const router = useRouter();
  const save = useInline(saveJobDetailsInline);
  const reextract = useInline(reextractJobDetailsInline);
  const working = save.pending || reextract.pending;

  // While the model reads the JD, look again every few seconds.
  useEffect(() => {
    if (r.status !== "extracting") return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [r.status, router]);

  const educationKnown = EDUCATION.some(([v]) => v === r.educationLevel);
  const locked = new Set(r.lockedFields);
  const mark = (field: string) => (locked.has(field) ? "checked by a person" : undefined);

  const statusLine =
    r.status === "extracting"
      ? "Reading the details…"
      : r.status === "failed"
        ? `Could not read the JD: ${r.error ?? "unknown error"}`
        : r.editedAt
          ? `Edited${editedByName ? ` by ${editedByName}` : ""} ${new Date(r.editedAt).toLocaleString()}`
          : r.status === "extracted" && r.extractedAt
            ? `Extracted ${jdApproved ? "from the approved JD" : "from the brief and notes"} ${new Date(r.extractedAt).toLocaleString()} — check it`
            : jdApproved
              ? "Not extracted yet"
              : "Filled in from the brief and notes when the JD is drafted";

  const fieldset = !canEdit || r.status === "extracting";

  return (
    <section className="mb-8 rounded-2xl border border-rule bg-surface px-6 py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-[15px] font-semibold">Job details</h2>
          <p className="mt-0.5 text-[12px] text-ink-soft">
            Define the role, client and requirements. Reverse matching and LinkedIn sourcing run on these.
          </p>
        </div>
        <span className={`text-[11.5px] ${r.status === "failed" ? "text-danger" : "text-ink-faint"}`}>{statusLine}</span>
      </div>

      <form
        onSubmit={(e) => {
          const { formData, pressed } = submitted(e);
          (pressed === "reextract" ? reextract : save).run(formData);
        }}
        className="mt-5"
      >
        <input type="hidden" name="openingId" value={openingId} />
        <fieldset disabled={fieldset} className="grid gap-5 disabled:opacity-70">
          <Field label="Job Title *">
            <input name="title" defaultValue={title} required className={inputClass} placeholder="e.g. Senior Brand Manager" />
          </Field>

          <div>
            <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Client &amp; recruitment</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Client Industry" hint={mark("clientIndustry")}>
                <Select
                  name="clientIndustry"
                  // An older value not on the list is shown as the list item it
                  // means, not as "Other" — saving "Other" let the JD reader
                  // put its own guess in (21 Sep).
                  defaultValue={mapIndustry(r.clientIndustry) ?? "Other"}
                  options={INDUSTRIES.map((i) => ({ value: i, label: i }))}
                />
              </Field>
              <Field label="Recruitment Type">
                <Select name="recruitmentType" defaultValue={r.recruitmentType} options={opts(RECRUITMENT)} />
              </Field>
              <label className="flex items-center gap-2 self-end pb-3 text-[13px]">
                <input type="checkbox" name="isConfidential" defaultChecked={r.isConfidential} />
                Confidential role
              </label>
            </div>
          </div>

          <div>
            <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-[0.08em] text-ink-faint">Requirements</h3>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="sm:col-span-2">
                <Field label="Location" hint={mark("location")}>
                  <input name="location" defaultValue={r.location ?? ""} required className={inputClass} placeholder="e.g. Colombo, Sri Lanka" />
                </Field>
              </div>
              <Field label="Seniority Level" hint={mark("seniorityLevel")}>
                <Select name="seniorityLevel" defaultValue={r.seniorityLevel ?? "mid_level"} options={opts(SENIORITY)} />
              </Field>
              <Field label="Job Status">
                <Select
                  name="status"
                  defaultValue={["active", "draft", "on_hold"].includes(r.jobStatus) ? r.jobStatus : "active"}
                  options={opts(STATUS)}
                />
              </Field>
              <Field label="Min Years Exp" hint={mark("experienceMinYears")}>
                <input name="experienceMinYears" type="number" min={0} max={50} defaultValue={r.experienceMinYears ?? 0} className={inputClass} />
              </Field>
              <Field label="Max Years Exp" hint={mark("experienceMaxYears")}>
                <input name="experienceMaxYears" type="number" min={0} max={50} defaultValue={r.experienceMaxYears ?? ""} className={inputClass} />
              </Field>
              <div className="sm:col-span-2">
                <Field label="Education" hint={mark("educationLevel")}>
                  {educationKnown || !r.educationLevel ? (
                    <Select name="educationLevel" defaultValue={r.educationLevel ?? "any"} options={opts(EDUCATION)} />
                  ) : (
                    <input name="educationLevel" defaultValue={r.educationLevel} className={inputClass} />
                  )}
                </Field>
              </div>
              <Field label="Salary min" hint={mark("salaryMin")}>
                <input name="salaryMin" inputMode="numeric" defaultValue={r.salaryMin ?? ""} className={inputClass} placeholder="200000" />
              </Field>
              <Field label="Salary max" hint={mark("salaryMax")}>
                <input name="salaryMax" inputMode="numeric" defaultValue={r.salaryMax ?? ""} className={inputClass} placeholder="300000" />
              </Field>
              <Field label="Currency">
                <input name="salaryCurrency" maxLength={3} defaultValue={r.salaryCurrency ?? "LKR"} className={`${inputClass} uppercase`} />
              </Field>
            </div>
          </div>

          <Field label="Required Skills *" hint={mark("requiredSkills") ?? "Enter or comma adds a skill"}>
            <TokenInput name="requiredSkills" group="skills" initial={r.requiredSkills} placeholder="Type a required skill (e.g. IFRS) and press Enter" />
          </Field>
          <Field label="Nice-to-Have Skills" hint={mark("niceToHaveSkills")}>
            <TokenInput name="niceToHaveSkills" group="skills" initial={r.niceToHaveSkills} placeholder="Type a nice-to-have skill and press Enter" />
          </Field>
          <Field label="Languages Required" hint={mark("languagesRequired")}>
            <TokenInput name="languagesRequired" initial={r.languagesRequired} placeholder="e.g. English, Sinhala" />
          </Field>
        </fieldset>

        {canEdit && (
          <div className="mt-5">
            <div className="flex flex-wrap items-center gap-4">
              <SubmitButton
                name="intent"
                value="save"
                busy={save.pending}
                locked={working}
                disabled={r.status === "extracting"}
                pendingLabel="Saving…"
                className="rounded-full bg-brand px-5 py-2.5 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-50"
              >
                Save job details
              </SubmitButton>
              {jdApproved && (
                <SubmitButton
                  name="intent"
                  value="reextract"
                  formNoValidate
                  busy={reextract.pending}
                  locked={working}
                  disabled={r.status === "extracting"}
                  pendingLabel="Reading the JD…"
                  tone="dark"
                  className="text-[12.5px] text-ink-soft hover:text-ink disabled:opacity-50"
                >
                  ✨ Re-extract from JD
                </SubmitButton>
              )}
              <span className="text-[11.5px] text-ink-faint">
                Saved fields are kept if the JD changes; Re-extract replaces them.
              </span>
            </div>
            {/* Here, not at the top of the page: this button sits a long scroll below it. */}
            <ActionNote result={latest(save.result, reextract.result)} className="mt-3" />
          </div>
        )}
      </form>
    </section>
  );
}
