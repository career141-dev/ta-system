# Today's Checks

TAs and TA Support start and finish work from the right sidebar. Account sign-in
does not start the clock, and sign-out does not finish work. Old `/workday` links
redirect to Openings with the drawer open. TA Leads and admins use Team checks
in the same sidebar, with date, TA, job and task-status filters.

The TA's workday sidebar groups candidate work into one "Candidates sourced
and progressed" check per job, with source names and totals in TA Shortlist,
Director Review and submitted. It omits the individual candidate roster and
candidate task rows. Completion ratios and the remaining-step count use the
grouped view; Finish still checks the original candidate requirements. Job
pages and the lead's team review retain the detailed actions and history.

The first workday for a TA/opening is 100%. Returning jobs default to Follow-up;
the TA can explicitly select Add-on. Pending assigned jobs carry into the next
workday as Follow-up and do not consume the ten manually selected job slots.
Changing a carried job to Add-on makes it a deliberately selected job.

## Requirements

100% requires the TA's confirmed review of the approved job description, a
valid LinkedIn job/post or Recruiter project link, review decisions on the
latest applicable Suggestions round, and one distinct own Excel Tables profile.
Successful empty searches need a saved explanation; failed searches do not count.
Suggestions decisions are labelled Select / Not selected. Selecting adds a
profile to Excel Tables; it does not contact the candidate or put them on the
pipeline. All results in the applicable round must have a decision.

The eight research fields are optional. They are absent from the workday sidebar
and do not block email or Finish, including when older research task events exist.
The Research page and saved reports remain available.

Approving a JD records the approving TA's review automatically. Other assigned
TAs confirm their own review from the sidebar. Editing the JD invalidates every
TA's confirmation, including when an old version is restored. Reconfirmation
records a new server timestamp; repeated confirmation preserves the original
time. Existing approvals without a saved reviewed version need confirmation;
there is no automatic historical backfill. Follow-up and Add-on do not repeat
the JD setup requirement. Leads see the review's actor, time, and event history.

Every work type requires a Director Review CV or a CV already submitted during
that work session. A no-candidate explanation cannot replace the CV. General
candidate work remains grouped; Director Review CV readiness is a separate
sidebar check. TA Shortlist may be zero. Follow-up requires due actions
to be completed or valid waiting reasons with next actions and future due times.
Director replies can remain waiting. Each selected/carried job needs its daily
email and confirmed ChatGPT research share link before the workday can finish.

EOD sending requires confirmed review of the approved JD, a valid LinkedIn job,
post or Recruiter project link, completed human Suggestions review, one own Excel
profile, a Director Review CV, and a confirmed ChatGPT research share link.
These checks apply to every work type and reuse saved setup evidence. The LinkedIn
link is compulsory; a reason-only exception is not accepted. General candidate
work does not block sending, while selected candidate validation and duplicate/
uncertain-mail safeguards remain enforced. Empty activity-only emails are disabled,
and at least one CV must be successfully prepared and attached before sending.
The composer fills the ChatGPT link from today's saved confirmation. Editing
that link clears confirmation, and revised emails require confirmation again.
The Excel minimum is temporarily one (14 October). It still counts only valid,
distinct LinkedIn profiles added by the TA; visible lead-added rows do not count.

The composer displays outstanding send requirements. Server preflight and the
mail reservation recheck evidence; Finish rechecks in its transaction. Existing
CV review, candidate detail, handoff, upload and uncertain-mail safeguards still
apply. Failed/uncertain email results do not mark the email complete.

## Evidence and compatibility

`src/lib/workdayRequirements.ts` evaluates setup evidence; the existing backend
workday evaluator adds recruitment queues and valid waiting reasons. Both feed
the sidebar, lead review, email checks and completion snapshot.

New tables store confirmations (`taWorkdayCheckNotes`), successful sourcing runs
including empty results (`taSourcingRuns`), shared setup provenance
(`taWorkdayEvidence`), and append-only task transitions (`taWorkdayTaskEvents`).
Daily exceptions and link confirmation are scoped to the workday. Research
confirmation is tied to the report's generated timestamp and field contents;
new edits or regeneration invalidate it. Empty-search explanations are tied to
the applicable run version.

Add-on submission evidence belongs to the current Add-on session: an earlier
email or no-candidate explanation does not complete a later session. A profile
roster change that remains above the threshold preserves the completion time.

Relevant commit, stage-transition, headhunted-upload and workday mutations record
events. Dashboard queries never write completion timestamps. A completed task
can reopen; earlier events remain visible. Reused evidence keeps its source time
and actor when known. Missing historical timestamps are shown as unrecorded,
never as the time the sidebar was opened. Finished snapshots are immutable.

Schema additions are optional/new tables and require no historical backfill.
Any future backfill must be an internal migration with dry-run support, executed
by the release pipeline. No laptop operations against the production backend.

## Validation

Run `npm test`, `npx tsc --noEmit -p .`, and `npx tsc --noEmit -p convex`.
Workday handler tests cover first-day enforcement, ownership, late CV arrivals,
carry expiry, mail acknowledgement/reconciliation, permission-scoped lead
history, idempotent events, preserved times, research invalidation, twelve
automatically carried jobs, and the ten selected-job limit. Requirement tests
cover thresholds, exceptions, share links and separate send/finish blockers.
