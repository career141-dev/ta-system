import { dateAt, packageLine } from "@/lib/format";
import { channelTag } from "@/lib/format";
import Link from "next/link";
import type { Application, Candidate, User } from "@/data/types";
import { STAGE_LABEL } from "@/data/types";
import { RowActions } from "./RowActions";
import { cameFromTables, directorReviewBlockers } from "@/lib/pipeline";
import { addCandidateToJob, claimCandidate } from "@/app/actions";
import { SubmitButton } from "./Submit";
import { RowCheck } from "./BulkSelect";
import { ContactLinks } from "./ContactLinks";
import { FitMark, FitReason } from "./FitBadge";
import type { Score } from "@/lib/scoring";
import { FollowUpActions } from "./FollowUpActions";
import { repo } from "@/data/store";
import { isConvex } from "@/data/mode";
import { ageHint, ageText } from "@/lib/ageExperience";
import { cvSource, headhuntedCandidates } from "@/lib/cvSource";

export function CandidateRow({
  app,
  candidate,
  owner,
  locked,
  claimable,
  openingId,
  score,
  rank,
  canDecideDirector = false,
  canDecideClient = false,
  selectForm,
  destinationJobs = [],
}: {
  app: Application;
  candidate: Candidate;
  owner: User | undefined;
  locked: boolean;
  claimable: boolean;
  openingId: string;
  /** Absent until the JD is approved — there is nothing to score against
   *  before that, and a score with no agreed requirements is a made-up number. */
  score?: Score;
  rank?: number;
  canDecideDirector?: boolean;
  canDecideClient?: boolean;
  /** The list's bulk bar (components/BulkSelect), when rows can be ticked. */
  selectForm?: string;
  destinationJobs?: { id: string; title: string }[];
}) {
  const stamp = (t: number) =>
    dateAt(t);

  const tag = channelTag(app.sourcingChannel, cvSource(app, headhuntedCandidates(repo.linkVault(openingId))));

  const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
    <>
      <dt className="text-[12.5px] text-ink-soft">{label}</dt>
      <dd className="min-w-0 break-words text-[12.5px] leading-[1.7]">{children}</dd>
    </>
  );

  return (
    <article className="flex flex-wrap gap-x-6 gap-y-4 px-4 py-5 sm:flex-nowrap sm:px-8 sm:py-7">
      {selectForm && (
        <span className="pt-1">
          <RowCheck form={selectForm} name="appId" value={app.id} label={candidate.fullName} />
        </span>
      )}
      {/* The score leads the row, so the list reads top to bottom as a ranking
          rather than as a column of cards bolted to the right. */}
      {score && <FitMark score={score} rank={rank} />}

      <div className="min-w-0 flex-1 basis-[220px]">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <Link
            href={`/openings/${openingId}/candidate/${app.id}`}
            className="text-[15px] font-semibold text-brand hover:underline"
          >
            {candidate.fullName}
          </Link>
          <span className="text-[11.5px] text-ink-faint">· 2nd</span>
          <span className="rounded bg-tag px-1.5 py-[2px] text-[11px] text-ink-soft">{tag}</span>
          {app.aiFollowUpNoReply && (
            <span className="rounded bg-warn-soft px-1.5 py-[2px] text-[11px] font-medium text-warn">
              Didn’t reply
            </span>
          )}
          {/* Held in Follow-up for want of details: said on the row, so it does
              not look like the move to Director review simply failed (21 Sep). */}
          {(app.stage === "ta_follow_up" || app.stage === "ai_follow_up" || (app.stage as string) === "follow_up") && directorReviewBlockers(candidate, app).length > 0 && (
            <span className="rounded bg-warn-soft px-1.5 py-[2px] text-[11px] text-warn">
              Needs {directorReviewBlockers(candidate, app).join(", ")}
            </span>
          )}
          {app.isAddOn && (
            <span className="rounded bg-brand-soft px-1.5 py-[2px] text-[11px] font-medium text-brand">
              Add-on
            </span>
          )}
          {app.backupForApplicationId && (
            <span className="rounded bg-brand-soft px-1.5 py-[2px] text-[11px] font-medium text-brand">
              Backup
            </span>
          )}
        </div>

        <p className="mt-1.5 text-[13px]">{candidate.currentTitle}</p>
        <p className="mt-0.5 text-[12px] text-ink-faint">
          {[candidate.location, candidate.currentEmployer].filter(Boolean).join(" · ")}
        </p>
        <ContactLinks
          phone={candidate.phone}
          email={candidate.email}
          linkedinUrl={candidate.linkedinUrl}
          cvHref={candidate.cvFileName || app.cvFileName ? `/api/cv/${candidate.id}?app=${app.id}` : null}
          className="mt-1.5"
        />

        {/* A database match carries the model's own line on why it was picked
            (lib/claudeMatch, 5 Oct); everyone else, the score's reasons. */}
        {app.matchReason ? (
          <p className="mt-2 text-[13px] leading-[1.6] text-ink-soft">{app.matchReason}</p>
        ) : (
          score && <FitReason score={score} />
        )}

        <dl className="mt-4 grid grid-cols-[84px_minmax(0,1fr)] gap-x-4 gap-y-3 sm:grid-cols-[96px_minmax(0,1fr)] sm:gap-x-6">
          {candidate.age != null && (
            <Field label="Age">
              {ageText(candidate)}
              {ageHint(candidate) && <span className="ml-1.5 text-[11.5px] text-ink-faint">{ageHint(candidate)}</span>}
            </Field>
          )}
          <Field label="Experience">
            {candidate.currentTitle} at {candidate.currentEmployer} · 2023 – Present
            <br />
            <span className="text-ink-soft">{candidate.totalExperienceYears} years total</span>
            {candidate.experienceNote && <span className="block text-[11.5px] text-warn">{candidate.experienceNote}</span>}
          </Field>
          <Field label="Education">
            {candidate.educationDegree}, {candidate.educationInstitution}
          </Field>
          <Field label="Package">
            <span className="text-ink-soft">
              {packageLine(candidate)}
            </span>
          </Field>
          {owner && (
            <Field label="Saved by">
              {owner.name}
              <span className="text-ink-faint"> on {stamp(app.createdAt)}</span>
            </Field>
          )}
        </dl>
      </div>

      <div className="flex w-full shrink-0 flex-col items-start gap-3.5 text-left sm:w-[196px] sm:items-end sm:text-right">
        {locked ? (
          <div className="rounded-lg border border-rule bg-paper px-3.5 py-3 text-[12px] leading-[1.7] text-ink-soft">
            {owner ? (
              <>
                Shortlisted by <span className="text-ink">{owner.name}</span>
                <br />
                <span className="text-ink-faint">You cannot contact</span>
              </>
            ) : (
              <span className="text-ink-faint">View only</span>
            )}
          </div>
        ) : claimable ? (
          <form action={claimCandidate}>
            <input type="hidden" name="appId" value={app.id} />
            <input type="hidden" name="openingId" value={openingId} />
            {/* Busy from the first press, so it is never pressed twice; the
                answer is the banner at the top, and the row moves on (25 Sep). */}
            <SubmitButton
              pendingLabel="Shortlisting…"
              className="rounded-full bg-brand px-4 py-[7px] text-[12.5px] font-medium text-white hover:opacity-90 disabled:opacity-70"
            >
              Shortlist
            </SubmitButton>
          </form>
        ) : (
          <RowActions
            appId={app.id}
            openingId={openingId}
            current={app.stage}
            candidate={candidate}
            app={app}
            isAddOn={app.isAddOn}
            isBackup={!!app.backupForApplicationId}
            canDecideDirector={canDecideDirector}
            canDecideClient={canDecideClient}
            backToTables={cameFromTables(app, repo.linkVault(openingId))}
          />
        )}

        {!locked && isConvex() && destinationJobs.length > 0 && (
          <details className="w-full text-left text-[12px]">
            <summary className="cursor-pointer text-brand">Add to another job</summary>
            <form action={addCandidateToJob} className="mt-2 flex flex-col gap-2">
              <input type="hidden" name="appId" value={app.id} />
              <input type="hidden" name="openingId" value={openingId} />
              <select name="destinationId" required defaultValue="" aria-label="Destination job" className="w-full rounded border border-rule bg-white p-2">
                <option value="" disabled>Choose a job</option>
                {destinationJobs.map(job => <option key={job.id} value={job.id}>{job.title}</option>)}
              </select>
              <SubmitButton pendingLabel="Adding…" className="rounded bg-brand px-3 py-2 text-white">Add to TA Follow-up</SubmitButton>
            </form>
          </details>
        )}

        {/* In Follow-up, the three ways to reach them, one press each. */}
        {!locked && (app.stage === "ta_follow_up" || app.stage === "ai_follow_up" || (app.stage as string) === "follow_up") && isConvex() && (
          <FollowUpActions
            applicationId={app.id}
            openingId={openingId}
            candidateName={candidate.fullName}
            roleTitle={repo.opening(openingId)?.title ?? "the role"}
            hasPhone={!!(candidate.phone ?? "").replace(/\D/g, "")}
            hasEmail={!!candidate.email}
            compact
          />
        )}

        {/* Not on Database CVs: everyone there is a database match. */}
        {app.stage !== "matched" && (
        <div className="rounded-lg border border-rule px-3.5 py-3 text-[12px] leading-[1.8] text-ink-faint">
          <span className="text-ink-soft">In {(STAGE_LABEL[app.stage] ?? app.stage ?? "").toLowerCase()}</span>
          <br />
          since {stamp(app.lastStageChangedAt)}
          {app.setNumber && (
            <>
              <br />
              Set {app.setNumber}
            </>
          )}
        </div>
        )}
      </div>
    </article>
  );
}
