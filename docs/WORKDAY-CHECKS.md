# Today's Checks

TAs and TA Support start work from the right sidebar. Account sign-in
does not start the clock. The first successfully finalized original 100% EOD
email records the finish time automatically; there is no Finish button. On
Follow-up/Add-on-only days, the last outstanding EOD completes the day.
Midday emails, revisions, failures and uncertain sends do not finish or retime
the day. Old `/workday` links
redirect to Openings with the drawer open. TA Leads and admins use Team checks
in the same sidebar, with date, TA, job and task-status filters.

The sidebar omits the "Candidates sourced and progressed" summary and
individual candidate action rows. Candidate actions stay on job pages and the
lead's detailed review. EOD send checks remain authoritative; outstanding
candidate actions do not prevent automatic completion after a valid EOD.

Every unfinished position has a Work type selector synchronized with the top
bar. Multiple 100% selections are allowed and can be corrected to returning
modes. Sent positions retain their submitted mode. After the clock stops,
returning positions remain editable/sendable and more returning positions can
be added without restarting it. Remaining emails are shown separately.

All dates use Asia/Colombo. Yesterday's unfinished day is never today's active
record. Starting today saves the new day first; separate backend jobs then
recover prior accepted EOD evidence or expire the old record at its next-midnight
boundary as incomplete. A large old checklist cannot stop today's start.
Expired records are not
successful completed workdays. Clock snapshots stay immutable; later returning
submissions are recorded independently.

Newly created openings default to 100%. The TA can change the opening to
Follow-up or Add-on from its top bar before or during the first recorded
workday; this is needed when an older position is entered into the system for
the first time. That per-TA opening mode is the default in Today's Checks and
changes to it are kept in the active workday's mode history. Pending assigned
jobs from prior days, including a day awaiting recovery, carry into the next
workday as Follow-up and do not consume the ten
manually selected job slots. Changing a carried job to Add-on makes it a
deliberately selected job.

## Requirements

100% requires the TA's confirmed review of the approved job description, a
valid LinkedIn job/post or Recruiter project link, review decisions on the
latest applicable Suggestions round, and one distinct own Excel Tables profile.
Successful empty searches need a saved explanation; failed searches do not count.
Suggestions decisions are labelled Select / Not selected. Selecting adds a
profile to Excel Tables; it does not contact the candidate or put them on the
pipeline. All results in the applicable round must have a decision.

The eight research fields are optional. They are absent from the workday sidebar
and do not block email or automatic completion, including when older research task events exist.
The Research page and saved reports remain available.

Approving a JD records the approving TA's review automatically. Other assigned
TAs confirm their own review from the sidebar. Editing the JD invalidates every
TA's confirmation, including when an old version is restored. Reconfirmation
records a new server timestamp; repeated confirmation preserves the original
time. Existing approvals without a saved reviewed version need confirmation;
there is no automatic historical backfill. Follow-up and Add-on do not repeat
the JD, LinkedIn, Suggestions or Excel setup requirements. They track only
eligible Director Review candidates, the confirmed ChatGPT link and the EOD
email. Leads see the actor, time and event history.

All work types, including 100%, allow an activity-only EOD with zero candidates.
A reason for having no CVs is not required. Add-on includes only the TA's candidates tagged
Add-on and progressed to Director Review during the current Add-on session.
Each selected/carried job needs its daily email and confirmed ChatGPT research
share link. Returning emails can follow the 100% email after the clock stops.

100% EOD sending requires confirmed review of the approved JD, a valid LinkedIn
job, post or Recruiter project link, completed human Suggestions review, one own
Excel profile, and a confirmed ChatGPT research share link. Follow-up and Add-on
require the confirmed ChatGPT link without repeating first-day setup. All modes
retain duplicate/uncertain-mail safeguards. An empty activity email keeps the
normal effort section and ChatGPT link without a candidate table or attachments.
When candidates are included, selected-candidate validation and successful CV
attachment preparation remain enforced.
The composer fills the ChatGPT link from today's saved confirmation. Editing
that link clears confirmation, and revised emails require confirmation again.
The Excel minimum is temporarily one (14 October). It still counts only valid,
distinct LinkedIn profiles added by the TA; visible lead-added rows do not count.

The composer displays outstanding send requirements. Server preflight and the
mail reservation recheck evidence. Successful finalization completes the clock
in the same transaction when the EOD completion rule is satisfied. Existing
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

## EOD backups and rollout

Sent EOD emails in the sidebar list this TA's original and revised emails
across positions for the last 31 days, grouped by original submission.
Each successful version gets 31 days from its own accepted timestamp.
Edit and resend starts from the selected saved version, defaults to its saved
recipients, keeps the candidate roster/order, and requires fresh ChatGPT and
preview confirmation. It needs no active workday and never retimes attendance,
counts candidates twice, or resets Director decisions. Replies use the same
review round.

New daily sends keep independent copies of their actual prepared PDFs in
Convex storage. Download/preview checks email access and retention. Resends
reuse these PDFs unless the TA explicitly selects replacement with current
prepared CVs. Candidate CV replacement cannot delete these independent copies.
Cleanup retains shared files while any unexpired or unresolved send references
them. Old backups without stored PDFs are labelled in the resend composer;
their missing original bytes cannot be reconstructed.

After deploying through the release pipeline, run `ta/eodCopies:normalizeRetention`
with `dryRun: true`, inspect its counts, then `dryRun: false`. This extends
retained content to 31 days per version and imports surviving legacy email
copies into the versioned history without resending mail or altering rounds.
Then run `ta/workdays:recoverOpenWorkdays` with dry-run followed by application
to close stale records using accepted EOD evidence or explicit expiry.
Both migrations are idempotent. No laptop operations against production.

## Validation

Run `npm test`, `npx tsc --noEmit -p .`, and `npx tsc --noEmit -p convex`.
Workday handler tests cover first-day enforcement, ownership, late CV arrivals,
carry expiry, mail acknowledgement/reconciliation, permission-scoped lead
history, idempotent events, preserved times, research invalidation, twelve
automatically carried jobs, and the ten selected-job limit. Requirement tests
cover thresholds, exceptions, share links and separate send/finish blockers.
