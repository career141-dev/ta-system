# TA workday feature plan

Planning draft — 13 October 2026. This document specifies the proposed feature;
the implementation described below is on a feature branch. It does not authorize
a production release.

## Implementation and selected defaults

The feature adds `/workday`, the right-side checklist, explicit Start/Finish
buttons, server timestamps, team-scoped lead history and in-app notifications.
Account authentication is unchanged. The first Start click opts a TA into
workday enforcement; established accounts can continue their existing workflow
until that click. Once adopted, recruitment work requires an active workday
covering that position. Creating/preparing a job remains available separately.

Regular TAs request additional positions from the job's lead. Support adds
authorized jobs directly. Jobs need a TA Lead so start/finish visibility has a
recipient. Existing working-stage menus update the day's timestamped mode history.
The effort email retains its existing single current-mode label.

Research/benchmark changes are tracked and shown rather than made compulsory
every day. New unworked Excel profiles need a decision or a recorded next
action. Suitable profiles need a pipeline handoff. Existing LinkedIn capture,
Excel export, candidate matching and pipeline controls remain the work surfaces.

Checks use backend follow-up flags, include all recorded CV arrivals on the job
and preserve shared review evidence. They cover late arrivals, reapplications,
pending primary/secondary intake routes, missing details, ready handoffs,
overdue follow-ups and unsent submissions. A lead can record a review for their
job where the owning TA cannot act. Missing CV/detail items become eligible to
wait only after recorded contact; handoffs, unreviewed CVs and email requirements
cannot be dismissed or carried forward.

Carry-forwards require a reason, next action and future due time. A new candidate
reply or relevant recorded action invalidates the previous waiting evidence.
Finishing validates the queues in the same transaction as the finish timestamp,
so arrivals committed before completion must pass the checks. Historical
submission rosters remain consistent with the existing composer; current
workday completion requires a confirmed send. Completed day snapshots survive
the existing email-copy expiry.

Every worked job requires its own email, including an activity-only email when
no candidates are ready. The existing composer, recipients, research-link checks
and outbound safety gates are reused. Graph acceptance is recorded independently
from saving a review round. In-progress/uncertain sends block completion and
retries; a job's lead can reconcile them after verifying the mailbox, with an
audited reason. Explicit revised emails retain the existing correction workflow.

The first version permits one workday per local date, preserves unfinished
overnight workdays, and never invents finish times or measures breaks. No silent
time correction, emergency bypass, or same-day reopening has been introduced.
Preparatory JD/post status is shown but does not block starting preparation work.

Queries use job/user/date indexes and fail closed if a relevant queue exceeds
1,200 rows; the lead must resolve the queue rather than finishing from a truncated
list. Lead views show up to 100 active records and 50 recent records. Broader
historical reporting/pagination can be added separately. The new tables also
join the existing authenticated partner API's full-schema registry.

All data structures are additive. No historical backfill or live database
operation is required by this change. Deployment must use the release pipeline.
Local UI/backend acceptance still needs a running local Docker backend.

Suggested local acceptance walkthrough:

1. Start a TA workday and verify the lead's timestamp and notification.
2. Refresh, close/reopen, and account-sign-out/sign-in; verify the active day persists.
3. Request another assigned job; verify work is blocked until the proper lead approves.
4. Start a support workday across jobs belonging to different leads; verify each lead's scope.
5. Review incoming CVs and work an Excel profile through the existing pipeline.
6. Carry a contacted candidate forward; receive a reply and verify the check reopens.
7. Send separate candidate/activity emails through local test-mode mail settings;
   simulate a failed/uncertain send and verify safe recovery.
8. Introduce a late CV after sending, verify Finish is blocked, then resolve it
   and verify the recorded finish and immutable daily review.

## 1. Purpose and confirmed requirements

Give TAs an explicit way to record when they start and finish work, show the
TA Lead those times, and identify incomplete recruitment work before the TA
finishes their workday.

Confirmed requirements:

- Workday login/logout is a button action, separate from account authentication.
  Opening the website, refreshing, or closing a browser does not start or finish work.
- The TA Lead can see the recorded work start and finish times.
- Regular TAs work on one assigned position per day. A second position requires
  TA Lead approval. TA support can work across multiple positions.
- Each position has its own selected work type: 100%, Add-on, or Follow-up.
- Every new CV on the worked position must be reviewed, including arrivals
  during the day.
- A right-hand sidebar identifies missing steps throughout the workday.
- Checks cover CV review, required candidate details, Director Review handoff,
  overdue follow-ups, and end-of-day emails.
- The review also covers job research, benchmarking, LinkedIn profiles recorded
  in the headhunting Excel table, and suitable headhunted candidates entering
  the pipeline and Director Review.
- Required incomplete steps block workday completion. Work genuinely waiting
  on candidates can carry forward with a reason and next action.
- End-of-day emails remain separate for each job worked.

## 2. Workday buttons and recorded times

Proposed labels are **Start workday** and **Finish workday**, avoiding confusion
with the existing account Sign out button. If the desk prefers Work login /
Work logout, the behavior remains the same.

Before starting, the TA selects their assigned job and work type. The server
records the start when the completed Start workday action succeeds. The active
workday banner shows the recorded start time, positions, and a Finish workday
button. Reopening the website restores that state without another button press.

Finish workday opens the final checklist; opening this screen does not record
a finish. The server records the finish only when completion succeeds after
all required checks. A blocked attempt leaves the TA working and explains why.

Use server timestamps stored in UTC and show dates/times in Asia/Colombo.
Show elapsed session duration as start-to-finish time, not as verified productive
time. Break tracking is outside the first version unless requested.

Account logout and session expiry preserve the unfinished workday. Neither
should manufacture an end time. A later visit resumes the same workday.

## 3. TA Lead view

Provide a workday overview for the lead's authorized team:

| Field | Meaning |
| --- | --- |
| TA / support member | Person who started the workday |
| Status | Not started, Working, Completing, or Finished |
| Start / finish | Recorded server times; unfinished workdays have no finish |
| Positions and work types | Jobs worked and each job's selected type |
| Outstanding checks | Required items and waiting items, grouped by job |
| Email status | Not sent, submitting, accepted for sending, failed, or uncertain |
| Elapsed duration | Time since start, or start-to-finish duration |
| Approval requests | Regular TA requests to work a second position |

Start and finish events should update this view without manual re-entry.
Proposed first version includes an in-app activity record/notification for the
lead. Email or WhatsApp notifications are not assumed and need a separate decision.
Do not notify candidates about workday events.

The lead can inspect job activity, approved carry-forwards, and completion
history. Times must not be silently editable. Any future correction facility
requires permission, a reason, original values, corrected values and an audit record.

## 4. Positions and work types

Start from the user's assigned jobs. Do not grant job access through workday
selection or an extra-position approval.

Regular TA: one distinct worked position for the day by default. Adding a second
position creates a pending request to the authorized TA Lead. The job becomes
part of the workday after approval; denial remains visible with its reason.
Finishing or hiding the first position must not bypass the second-position rule.

TA support: may select several authorized positions without that approval.
Verify the existing role representation before implementation rather than
assuming support is already a distinct backend role.

Require an explicit work type selection for each job when starting, prefilled
from the existing selection. Preserve work type changes with timestamps so
changing the current selection does not rewrite earlier activity. Reuse the
existing Add-on tagging behavior. Decide how mixed-mode days appear in the
existing single-mode effort email before changing its format.

## 5. Recruitment paths covered

Incoming CV path:

Assigned job -> JD approval and connected LinkedIn post -> incoming CV ->
recorded review -> unsuitable decision or TA shortlist -> required details /
follow-up -> Director Review -> end-of-day email -> director decision.

Headhunting path:

Job research -> benchmarking -> LinkedIn profiles in the headhunting Excel
table -> suitability decision / contact -> candidate and CV linked to the
pipeline -> TA shortlist / required details -> Director Review -> end-of-day
email -> director decision.

Director Review is the submission stage. Director Shortlist records the
director's approval, not the TA's submission. Existing permitted paths may
combine some intermediate actions; workday tracking must recognize those
successful paths instead of requiring redundant clicks.

LinkedIn profiles can be added to the Excel table and the table can be exported.
Exporting is optional and does not satisfy candidate review or pipeline handoff.
A suitable profile awaiting a CV is pending, not ready for Director Review.
Use existing candidate matching to avoid duplicating someone who enters via
both a received CV and a headhunting profile. Keep one application per relevant
candidate/job relationship and retain source evidence.

## 6. Activity and scope

Keep two related views: **work performed during this workday** and **outstanding
work on its positions**. A completed research document from last week remains
job context, not research newly completed today. Older overdue owned tasks
must remain visible even if they did not originate in today's session.

Track job-linked research/benchmark changes, Excel profile additions and
decisions, candidate links, shortlist decisions, stage moves, follow-up
actions, work type changes and email submissions. Use existing authoritative
events where available. Do not infer completed research from merely opening a
page, or completed CV review from merely opening a file.

The all-new-CV rule applies to the position's recorded intake, not just the
TA's shortlisted candidates. Define a persisted review disposition and review
actor/time if current records cannot prove a review occurred. LinkedIn prospects
without CVs belong to the headhunting checklist rather than the incoming-CV count.
The system cannot detect files remaining in unconnected external inboxes/chats.

## 7. Right-hand sidebar

Use a persistent, collapsible desktop panel and a drawer on smaller screens.
Show the current job first and allow switching to all workday positions. Each
item includes the candidate/job, missing step, reason, next action and a deep
link to the relevant page. Group into **Needs your action**, **Waiting on
someone else**, and **Completed**. Show counts and refresh after relevant changes.

| Check | Proposed completion evidence |
| --- | --- |
| New CV not reviewed | Saved review disposition, actor and time |
| Required candidate details missing | Authoritative pipeline eligibility check passes, or justified waiting item |
| Suitable headhunting profile not in pipeline | Candidate/application linkage, or justified waiting-for-CV item |
| Candidate ready but not in Director Review | Valid stage transition, or recorded valid exclusion/hold |
| Follow-up due with no action | Recorded action or justified rescheduling |
| Research or benchmarking required | Saved job evidence under the agreed requirement |
| Excel profile decision missing | Saved decision under the agreed daily rule |
| Ready candidate not submitted | Successful email submission covering the candidate, or valid recorded hold |
| Required email incomplete | Successful submission for that workday/job |

Research/benchmark requirements and permitted holds remain decisions to settle;
do not turn these proposed checks into unconditional blockers yet.

Reuse backend pipeline gates, including follow-up flags. Current Director
Review rules require CV, expected salary and notice; current salary is optional.
Do not rely solely on the existing UI proxy, which can disagree with backend flags.
Never advance a candidate or send outreach automatically just to clear a check.

## 8. Carry-forward work

Waiting items need a reason, next action and proposed required due date. Preserve
the candidate/job, responsible person and supporting last action. For example:
"Requested CV; awaiting candidate; follow up tomorrow morning."

Missing action is not equivalent to waiting: a TA who has not requested the CV
still has an actionable task. Due dates surface the item again on the next
workday and in existing follow-up views. Later arrivals/replies should cause
checks to be recomputed so stale waiting reasons cannot hide newly actionable work.

Use structured reasons plus notes. No generic Dismiss all. Record who carried
an item forward and when. Whether leads must approve specific exceptions is
an open policy decision.

## 9. Daily review and separate job emails

The daily review lists all candidates shortlisted during the workday, from
received CVs and headhunting, with source and current status. Separate ready
to send, pending, already sent and later withdrawn/rejected candidates.
Also show earlier candidates worked today or ready to send so an older shortlist
does not disappear merely because it was created on another date.

Reuse the existing per-job email composer, eligibility, recipients, prepared
CV attachments and review rounds. Existing emails include unsent Director
Review candidates; the broader daily shortlist view does not automatically
make pending candidates eligible for the outgoing email. Deduplicate against
successful prior submissions and preserve candidate ownership/permissions.

Display research, benchmarking and headhunting effort in the daily review.
Whether to add that narrative to the actual email remains open. Existing
research-link requirements remain enforced. Counts must preserve current
definitions: sourced profiles, reviewed CVs, shortlisted people and sent CVs
are different measures and must not be combined into one inflated total.

Record provider acceptance as acceptance for sending, not proof of delivery.
Failed, held or uncertain sends do not satisfy the email requirement. Handle
retries and timeouts without creating duplicate emails/review rounds. New
ready candidates after an earlier email may require another submission.

## 10. Final completion and arrivals

Finish workday summarizes every selected job, including support's multiple
jobs, approval status, checks, carry-forwards and email results. The server
re-evaluates the workday before committing its finish time; frontend state
alone cannot close it. Work added after an earlier email can reopen checks.

Proposed boundary, pending confirmation: include all recorded CV arrivals up
to the atomic successful completion check. An arrival before that boundary
blocks completion if unreviewed; arrivals afterward enter the next work queue.
This avoids an endless check against future arrivals. Persist the boundary and
queue coverage so it is reproducible. If the desk prefers a fixed cutoff,
make that explicit instead.

Proposed shared-job rule, pending confirmation: a valid authorized person's
review satisfies the CV's review once; each TA still owns their candidate
handoffs and emails. Define backlog handling for previously unreviewed CVs
and CVs arriving while no workday is active before implementing the queue.

Unreviewed CVs cannot simply be labelled waiting on a candidate to bypass the
confirmed review requirement. Incoming processing failures must appear as
system problems with a recovery path, not as completed reviews.

## 11. Suggested backend model and integration

Conceptual records, to finalize after inspecting existing schema and events:

- Workday: user, local work date, status, server start/finish, completion boundary.
- Workday job: workday, job, initial work type, mode-change history, approval reference.
- Extra-position request: user, day, job, lead decision, reason and timestamps.
- Review evidence: application/intake, disposition, actor and timestamp if missing today.
- Carry-forward: job/application/profile, rule, reason, next action, due date, actor.
- Audit events: start, mode/position changes, approval, carry-forward and completion.
- Submission association: link existing email/review-round IDs to the workday/job.

Prefer derived checks from current records instead of a second mutable set of
checkboxes. Store manual evidence, decisions and completion snapshots; avoid
duplicating candidate personal information. The lead history must remain
meaningful when existing email body copies expire.

Enforce identity, job access, TA ownership and lead/team scope on the backend.
Use indexed/paginated summaries rather than scanning the entire candidate
database. Start/finish and approval writes must be idempotent across retries
and multiple tabs. Coordinate asynchronous email actions with final transactional
completion checks. Do not treat elapsed UI timers as authoritative timestamps.

## 12. Recovery and exceptional cases

- Refresh / multiple tabs: one shared active workday and consistent buttons.
- Network failure: show failure/uncertainty, retain work, retry safely.
- Forgotten finish: keep the original workday unfinished; offer audited recovery,
  never silently invent a finish time at midnight.
- Overnight work: preserve start date and use explicit boundaries rather than
  assuming all sessions end on their starting calendar day.
- Reassignment / closed job: preserve history and provide a lead resolution path
  without granting access to a job the TA no longer has permission to view.
- JD/post readiness: show prerequisites before sourcing; decide whether
  preparation work may start before approval/post connection.
- No suitable candidates: valid reviewed work is not a failure; decide whether
  a zero-shortlist activity email is mandatory.
- Work after finish: require an explicit reopen/additional-session policy;
  preserve the original completion instead of silently rewriting it.

## 13. Delivery and validation

1. Finalize remaining policy decisions and map current roles, events, research,
   benchmark and Excel-table evidence.
2. Add workday records/buttons and the lead's start/finish overview.
3. Add backend checklist calculation, live sidebar and carry-forward records.
4. Add complete daily review, per-job email association and completion enforcement.
5. Validate locally with synthetic data and TA/lead walkthroughs, then use the
   reviewed PR and release pipeline.

Required acceptance scenarios include start/finish visibility to the lead,
no automatic start/finish on browser actions, duplicate clicks/tabs, second-job
approval, support working multiple jobs, mixed incoming/headhunted candidates,
candidate deduplication, late CV arrival at completion, missing details,
waiting carry-forwards becoming due/actionable, failed/uncertain email sends,
permissions across users/jobs, forgotten/overnight workdays and expired email copies.

Before pushing implementation: npm test, app TypeScript check and backend
TypeScript check as required by AGENTS.md. Test locally against 127.0.0.1 only.
Any backfill is a pipeline-run internal migration with dryRun. All outbound
messages keep existing outreach/outbound guards. No laptop changes to live.

## 14. Decisions still needed

1. Is research/benchmarking required once per job or updated on particular work types?
2. Must every new Excel profile receive a same-day decision, or can some carry forward?
3. Should research/headhunting narrative be added to emails or only the daily review?
4. Approve the proposed completion-time CV cutoff or choose a fixed cutoff;
   define backlog/no-active-session handling and shared-job review responsibility.
5. Must a zero-shortlist workday send an activity email for each job?
6. Should lead start/finish updates include an in-app notification, or is the live view enough?
7. Define forgotten-finish corrections, emergency exceptions, reopening, and multiple sessions.
8. Can preparation work start before JD approval/LinkedIn post connection, and
   how should changed work types appear in the existing effort email?

Confirmed requirements above take precedence. Open decisions are not approvals
to enable bypasses, add compulsory daily research, or change email content.
