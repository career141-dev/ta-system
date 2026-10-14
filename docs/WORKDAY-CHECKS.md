# Today's Checks

TAs and TA Support start and finish work from the right sidebar. Account sign-in
does not start the clock, and sign-out does not finish work. Old `/workday` links
redirect to Openings with the drawer open. TA Leads and admins use Team checks
in the same sidebar, with date, TA, job and task-status filters.

The first workday for a TA/opening is 100%. Returning jobs default to Follow-up;
the TA can explicitly select Add-on. Pending assigned jobs carry into the next
workday as Follow-up and do not consume the ten manually selected job slots.
Changing a carried job to Add-on makes it a deliberately selected job.

## Requirements

100% requires a LinkedIn job/post link, all eight main research fields filled or
explained as unavailable and reviewed, a successful Suggestions run reviewed
through its latest applicable round, and three distinct profiles added by that
TA to Excel Tables. Existing saved setup counts. Successful empty suggestion
searches need an explanation; failed searches do not count.

100% and Add-on require a fresh owned Director Review candidate or a saved reason
why none were suitable. TA Shortlist may be zero. Follow-up requires due actions
to be completed or valid waiting reasons with next actions and future due times.
Director replies can remain waiting. Each selected/carried job needs its daily
email and confirmed ChatGPT research share link before the workday can finish.

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
