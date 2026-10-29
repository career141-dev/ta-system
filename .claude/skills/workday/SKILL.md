---
name: workday
description: Today's Checks and the TA workday engine - the right-side drawer, Start/addPosition, work modes (100% / Follow-up / Add-on), per-job check evidence, carry/exceptions, automatic completion by the first final 100% EOD, Team checks for leads. Aliases - workday, Today's Checks, checklist drawer, sidebar checks, work type, clock, workday gate. Use when changing, debugging or extending any of it.
---

# Workday (Today's Checks)

Verified against the repo on 27 Oct 2026. Code wins over this file and over `docs/WORKDAY-CHECKS.md`; where they disagree the doc is stale (it does not mention the lead-wide view of 23 Oct).

## Scope and boundaries

In this skill: the drawer UI, `ta/workdays` backend, the check evaluator (`convex/lib/workdayChecks.ts`), the pure rules (`src/lib/workday*.ts`), the workday scope gate, the work mode (100% / Follow-up / Add-on) as it is stored and enforced, mail receipts (`taWorkdayMail`) as they decide completion, and the one-off recovery migrations.

Neighbours (do not duplicate, link instead):
- /eod-email: composing/sending the EOD and midday email, `convex/ta/dailyEmails.ts`, `EodComposer`, attachments, 31-day backups, resend. Only the points where it calls into the workday are covered here (`emailPreflight`, `finalizeDailyEmail` -> `autoCompleteWorkday`, receipts).
- /follow-up: candidate follow-up that produces `details:`/`handoff:`/`followup:` checks (stage rules live there).
- /sets-shortlist, /scoop: Director Review sets and rounds (`reviewRounds`) that feed `sentIds`.
- /excel-tables: `linkVault` rows; the `excel_profiles` and `profile:` checks read them.
- /database-search, /email-intake, /cv-extraction: `cvUploads` queue that yields `upload:` checks.
- /openings: opening page, ContextBar, team editing, `WorkingStageMenu` host pages.
- /strategy-planner, /voice-agent: unrelated except they share the layout.

## How it works now

All dates are Asia/Colombo: `workdayDate(ms)` in `src/lib/workday.ts` (`toLocaleDateString("en-CA", {timeZone:"Asia/Colombo"})`). `colomboDayStart` is in `src/lib/calendar.ts`. One `taWorkdays` row per TA per Colombo date.

### Vocabulary of a day

- Active day (`activeFor` in `convex/ta/workdays.ts`, read through the `by_user_date` index so it never loads the TA's whole history, 29 Oct): today's row where `finishedAt === undefined` OR `closureReason === "eod"`. So an EOD-closed day stays the "active" record all day so Follow-up/Add-on work can continue. `expired` days are never active.
- `ownedActive`: row must be the caller's, dated today, and not finished unless closed by `eod`. Errors: "That workday is not yours.", "Start today's workday first.", "That workday is already finished."
- Roles: workers are `ta`, `ta_support` (`requireWorker`: "Workdays are for TAs and TA support."). `canLead` = `admin` or `ta_lead` (backend, local const). `canReviewWorkdays` (src/lib/workdayRoles.ts) = `ta_lead`, `admin`, `director`. `canViewWorkday` adds `ta`, `ta_support`.

### Flow 1 - Start (`ta/workdays:start`, op `start`)
Trigger: TA picks a position and work type in the drawer (JobPicker, no active day) -> `changeWorkday` (`src/app/workday/actions.ts`) -> `convexMutation("ta/workdays:start", {actorId, jobId, workType})`.
1. `requireWorker`; if today's day already exists it is returned at once (double click, retry after a lost answer: never a second row, no recovery work); otherwise `recoverStaleDays(userId)` (see Flow 8).
2. If an active day exists, returns `{id}` unchanged (idempotent).
3. If the latest row is dated today (finished and not active) -> "Today's workday is already finished. Ask the lead to review its record."
4. `assignedJob`: `assertJobAccess(..., ["primary_recruiter","supporting_recruiter"])`, job not `isGone` ("That job is no longer available."), and `job.taLeadId` must exist ("Ask the lead to assign a TA Lead to this job before starting work.").
5. Inserts `taWorkdays` with the chosen job first (`workType`, `addedAt`, `leadId: job.taLeadId`, `workLocationIds: activeWorkLocationIds(job)`, `modeHistory:[{at,workType}]`) followed by every `pendingJobs()` job as `carried:true`, `workType:"Follow-up"` (the chosen job is excluded from carry).
6. `setMode` writes the mode for each job (see Work modes), `attachLead` inserts `taWorkdayLeads {workdayId, leadId}` once per lead, `notify` inserts a `notifications` row type `workday_started` ("Started workday") for the chosen job's lead only, then `refreshWorkdayChecks(jobId)` for the chosen job only. Carried jobs are refreshed after Start by `ta/workdays:refreshCarried({workdayId, jobIds})`, scheduled inside Start (commits with the day) and running one job per mutation, each scheduling the next, scoped to that one day (29 Oct: fifteen carried checklists in one mutation made attendance wait on, and fail with, all of them). The drawer computes checks live, so only the task-event history lags; those first events are `observed`.
Sign-in never starts the clock. The first Start is the opt-in (see `assertWorkdayScope`).

### Flow 2 - Add position (`addPosition`)
`ownedActive`; no-op if the job is already on the day; cap: `day.jobs.filter(j => !j.carried).length >= 10` -> "A workday supports at most ten positions."; `assignedJob`; if mode is `100%` and the day already has 5 100% entries (`count100` >= `MAX_100_PER_DAY`) -> "A workday supports at most 5 100% positions…". Appends the entry, `setMode`, `attachLead`, notification `workday_started` "Started work on another position", `refreshWorkdayChecks`. Always returns `{pending:false}`: the old request-to-lead flow is gone, see `decide` below.

### Flow 3 - Work mode (`setWorkType` and `recordActiveMode`)
Two entry points write the same thing:
- Drawer: `changeWorkday` op `setWorkType` -> `workdays:setWorkType`. Also `WorkingStageMenu` inside the drawer (shown only to the owner, `canFinish && !job.eodSentAt`) which calls the server action `setWorkingStage` (`src/app/actions.ts:1985`, capability `opening.act`) -> `writeWorkingStage` (`src/lib/openings/writes.ts:65`) -> `ta/openings:setWorkingStage`.
- Opening top bar: `ContextBar` and the /openings list render the same `WorkingStageMenu` (`src/components/WorkingStageMenu.tsx`) for anyone passing `opening.act`.
`ta/openings:setWorkingStage` patches the assignment (or `taSettings`), then calls `recordActiveMode` + `refreshWorkdayChecks` (so a refusal from `recordActiveMode` rolls the whole mutation back).
`recordActiveMode(ctx,userId,jobId,stage)` is a no-op unless the user has an active day containing that job with a different mode. Guards, in order:
| Condition | Message |
|---|---|
| any receipt for (day, job) is `sending`/`uncertain`/`accepted` without `finalizedAt` | "Wait for this position's email result or ask the lead to reconcile it before changing work type." |
| a finalized original EOD (`!revised`, not `recoveryReopenedAt`, `submissionType` eod/undefined) exists | "This position's EOD has been sent. Its recorded work type cannot change today." |
| target `100%` and the day already has 5 100% entries | "A workday supports at most 5 100% positions…" (`MAX_100_PER_DAY`) |
Then it patches the entry (`workType`, appends `modeHistory {at, workType}`) and calls `autoCompleteWorkday` (changing the last 100% job to returning can complete a returning-only day). `setWorkType` additionally: `suggestedMode` is an identity hook; a `carried` job switched to Add-on is un-carried (becomes a "selected" job, refused if there are already 10 non-carried: "A workday supports at most ten selected positions.").

### What each work mode requires
Pure rule: `checksForWorkType(workType, checks)` in `src/lib/workday.ts` keeps everything for `100%`; for Follow-up/Add-on only keys whose prefix is in `RETURNING_CHECKS = {director_cv, chatgpt, daily_email, mail}`.
| Mode | Checks in sidebar | Needed to send EOD (server) |
|---|---|---|
| 100% | `jd_review`, `linkedin_post`, `suggestions` (while `SUGGESTIONS_WORKDAY_REQUIRED`), `excel_profiles` (>= `MIN_OWN_EXCEL_PROFILES` = 1), `director_cv` (always complete), `chatgpt`, `daily_email`, `midday_email` (once policy on), plus `mail:`/`capacity`/`job_access`; candidate checks (`review:`, `details:`, `handoff:`, `followup:`, `email:`, `profile:`, `upload:`, `director_wait:`, `candidate:`) exist in the data but `sidebarChecks` (`src/lib/workdaySidebar.ts`) hides them from the drawer (leads see them under "Candidate task details") | the `isEodSendCheck` set: jd_review, linkedin_post, suggestions, excel_profiles, director_cv, chatgpt, mail, midday_email, all complete or excused |
| Follow-up | `director_cv`, `chatgpt`, `daily_email`, `mail:` | confirmed ChatGPT link (+ `mail:` blockers) |
| Add-on | same as Follow-up; EOD roster limited to this TA's `isAddOn` candidates that reached Director Review since the current Add-on session (`workSessionStart`, `isEodCandidateEligible` in `src/lib/eodEligibility.ts`) | same as Follow-up |
Every mode may send an activity-only EOD with zero candidates (`director_cv` is created with `complete=true`; progress text "No eligible candidates today - a link-only activity email is allowed"). The eight research fields (`RESEARCH_FIELDS`) are optional and no longer produce a check; `saveCheck kind:"research"` and `ResearchConfirmation` (only rendered on the Research page when `repo.workingStage === "100%"`) remain but nothing gates on them.
`midday_email` is not in `RETURNING_CHECKS`, so it never shows as a Follow-up/Add-on drawer check, yet `ta/dailyEmails.ts` still enforces midday via `dailySendProblem(..., middayRequired)`.

### Where the work mode is stored
- Team member on the opening: `jobAssignments.workingStage` (optional union). Written by `setMode` / `ta/openings:setWorkingStage`; mapped in `convex/ta/model/tables.ts` (~l.392/403) for the `assignments` model.
- Anyone else (lead/admin/director working the job): `taSettings` row key `workingStageKey(jobId,userId)` = `workingStage:<jobId>:<userId>` (`src/lib/workingStage.ts`).
- Read defaults: app `repo.workingStage` (`src/data/store.ts:2725`) and `workdays:eodContext` fall back to `"100%"`. The drawer picker default is different: `dashboard.options[].workType = assignment.workingStage ?? (job in a previously finished workday ? "Follow-up" : "100%")`.
- Inside a day the authoritative mode is `taWorkdays.jobs[].workType` + `modeHistory`; `taWorkdayMail.workType` freezes the mode at send time (`autoCompleteWorkday` reads `r.workType ?? modeHistory at r.startedAt ?? entry.workType`).
- `workSessionStart(entry)` (`src/lib/workdayRequirements.ts`): for Add-on the `at` of the last Add-on `modeHistory` item, else `entry.addedAt`. Add-on evidence (accepted receipts, no-candidate reason) before that is ignored, so a second Add-on session starts clean.
- Quirk "Save team resets stages": `repo.setAssignments` (`src/data/store.ts:2680`) deletes every assignment row of the opening and re-pushes rows without `workingStage`, so saving the team resets every TA on it to the default (100%); `taSettings` copies for non-members survive. Reached via `writeOpeningTeam` (`src/lib/openings/admin.ts`). The effect on the Convex `jobAssignments` rows goes through `convex/ta/model/tables.ts` (`toDoc` only writes `workingStage` when present); end-to-end backend behaviour not re-verified (unverified).

### Flow 4 - Evaluating a job: `jobView` and `requiredChecks`
`jobView(ctx, day, entry, now)` in `convex/ta/workdays.ts` builds one `WorkdayJobView`. It is a pure read (queries and mutations both call it) and never writes. All queues use `.take(LIMIT + 1)` with `LIMIT = 1200`; if any exceeds the limit a `capacity` check ("This job needs a lead review: its work queue exceeds the checklist limit.") is added so a day is never closed from a truncated queue. `job_access` is added when the opening is gone.
Check keys are `<kind>:<id>`:
| Key | Source and rule | canCarry |
|---|---|---|
| `mail:<receiptId>` | receipt `sending`/`uncertain` or `accepted` w/o `finalizedAt`: "An email is still sending or its result needs reconciliation. Do not send it again." | no (blocksEmail) |
| `review:<appId>` | incoming CV (stage `new_cvs`, or reapplied/arrived since Colombo day start of `startedAt`, DB-sourced prospects excluded) with no review at/after arrival; reviewer = `workdayReviewedAt/shortlistedAt/taShortlistAt/rejectedAt`; label differs if the viewer is not the assigned TA | no |
| `candidate:<appId>` | owned app whose candidate record is missing | no |
| `details:<appId>` | TA-owned `ta_follow_up`/`ai_follow_up` app missing CV / expected salary / notice period (flags `followUpCvReceived|ExpectedSalary|NoticePeriod` else on-file helpers from `ta/stages`) | only when contacted |
| `handoff:<appId>` | same stages, nothing missing: "ready for Director Review" | no |
| `followup:<appId>` | `nextFollowUpScheduledAt <= now` | yes |
| `email:<appId>` | owned `director_review` app not in any sent roster | no |
| `profile:<linkId>` | `linkVault` rows of this TA: shortlisted but app still `new_cvs`/`matched_candidates`; shortlisted but app closed after the decision; shortlisted/cv_received with no app; `no_contact` that was worked today or carried | only the last two |
| `upload:<cvUploadId>` | CV still processing, or processed but not filed on the job; secondary routes via `alsoAssignTo` | no |
| `director_wait:<appId>` | own `second_shortlist` app already in a sent round: "Waiting for the Director's reply: record the next follow-up" | yes |
| `jd_review`, `linkedin_post`, `suggestions`, `excel_profiles`, `director_cv`, `chatgpt`, `daily_email`, `midday_email` | `requiredChecks` in `convex/lib/workdayChecks.ts` via `setupChecks` (`src/lib/workdayRequirements.ts`) | no |
Then `applyCarryForwards` (valid when `canCarry` and carry `dueAt > now` and `carry.evidenceAt === check.evidenceAt`, so any reply/stage change invalidates a waiting reason), `checksForWorkType`, `withTaskHistory`. `eodChecks` = the `isEodSendCheck` subset (plus `midday_email`).

`requiredChecks` evidence rules (all scoped to the TA `day.userId`):
- `jd_review`: complete when JD text non-empty, `jobs.jdStatus === "approved"` and `taWorkdayCheckNotes.jdVersion === jobs.jobDescription` (note keyed by user+job, NOT by day, so it persists across days until the JD changes).
- `linkedin_post`: any `jobPosts` row (any author) whose `externalUrl` passes `linkedinPostUrl()` (https linkedin.com, no userinfo; `/jobs/view/...`, `/jobs/search`+id, `/hiring/jobs/`, `/talent/` project id, `/posts/...`, `/feed/update/urn:li:activity:`). Time/actor come from `taWorkdayEvidence` rows (table `jobPosts`, `version === externalUrl`).
- `suggestions`: applicable `profileSuggestions` = `generatedFor` empty or this TA; `round = max(latest taSourcingRuns round, applicable rounds)`; complete when a run or suggestions exist, none have `status === "new"`, and (count > 0 or an empty-search reason saved for this exact `suggestionVersion`). `needsEmptySuggestionsReason` drives the form on the drawer and Suggestions page. Select / Not selected live in the Suggestions UI.
- `excel_profiles`: distinct (`linkKey`) `linkVault` rows added by this TA on the job, all-time (not only today), `>= MIN_OWN_EXCEL_PROFILES`; lead-added rows never count.
- `chatgpt`: `validateResearchLink` (`src/lib/eod-format.ts`: hosts `chatgpt.com`, `www.chatgpt.com`, `chat.openai.com`; path `/share/(e/)?<id>`; private `/c/`, `/g/`, `/chat/` refused; max 300 chars; query/fragment stripped) AND `confirmedAt`. Notes are day-scoped via `taWorkdayCheckNotes.workdayId`, falling back to the last accepted receipt's `researchLink/acceptedAt`.
- `daily_email`: `jobEodComplete` over today's accepted original EOD receipts (all active locations covered); complete time = max `finalizedAt`.
- `director_cv`: always complete; for multi-location jobs, forced complete with "All location EODs sent, including activity-only reports" once every location EOD is in.
- `midday_email`: only when `middayRequired(ctx, day.date)` (policy row `dailyEmailPolicy` key `midday`, `date >= requiredFrom`); complete when an accepted finalized midday exists for every required location.
- Exceptions: `canExcuseCheck` = jd_review, linkedin_post, suggestions, excel_profiles, chatgpt. Each gets `exceptionVersion = JSON([sessionStart, versions[key]])` (evidence versions: JD text+approved+reviewed, post list, suggestion round/statuses, own link list, chatgpt link+confirmedAt). `applyTaskExceptions` only honours the latest `submit` event if versions match and the day is today, so any change in underlying evidence voids the excuse.

### Flow 5 - Saving evidence (`saveCheck`, `emailPreflight`, `taskException`, `carry`, `markReviewed`)
- `changeWorkday` op `saveCheck` (kinds `jd`, `research`, `emptySuggestions`, `noCandidates`, `chatgpt`): requires an active day containing the job ("Start work on this opening first."). `jd` needs an approved non-empty JD ("Review and approve the job description first."). `emptySuggestions` only after a successful empty run ("Only a successful empty search needs this reason."), reason <= 1000. `chatgpt` validates the link and requires `confirmed` ("Confirm you opened this link in a private window and it contains no candidate details before saving."), re-saving the same link keeps the original `confirmedAt`; a changed link resets it. Switching day clears `noCandidate*`, `chatgptLink`, `confirmedAt` (patch when `notes.workdayId !== day._id`). The Next action pre-validates the link with `checkResearchSubmission`. Success copy "Research link confirmed." for chatgpt, else "Saved.".
- The drawer's ChatGPT box (`ChatgptConfirmation` + `useChatgptResearch` + `src/lib/chatgptResearchSync.ts`) saves through `saveConfirmedResearchLink` -> `changeWorkday` `saveCheck kind:chatgpt`, and syncs with the EOD composer via a window event.
- `emailPreflight` (internalMutation, called from `eodResearchSubmission` in `src/app/actions.ts:~4326`): non-workers pass. Workers need an active day ("Start your workday in Today's Checks before sending.") containing the job ("Add this opening to Today's Checks first."). Persists a confirmed link into `taWorkdayCheckNotes`, `refreshWorkdayChecks`, recomputes `jobView`, returns `{ok, blockers: ["<label>: <progress>"], workType}`. For work-location jobs `director_cv`, `midday_email`, `mail` blockers are dropped and `dailySendProblem` is added per location. An empty link is accepted only if the `chatgpt` check has an exception.
- `taskException` (op, worker): blocked if the job's EOD is already complete ("This position is already finished by its EOD emails."), key must be an excusable EOD check with an `exceptionVersion` ("This task must be completed."); complete tasks cannot be excused; reason 1..1000 chars. Appends `taWorkdayExceptions` (append-only; `withdraw` re-uses the prior reason) and inserts `notifications` type `workday_exception` for every active admin plus the job's lead (link built in `convex/ta/notifications.ts:~76` as `/openings?checks=open&checkDay=&checkJob=&checkTask=`), then `refreshWorkdayChecks`. Idempotent for identical repeats.
- `carry` (op, worker): finds the key in `jobView(...).checks` (so only checks visible for the job's current mode), `validateCarry` (`canCarry`; reason and nextAction non-empty, <= 1000; `dueAt` finite and in the future; "This step must be completed before finishing work." otherwise), upserts `taWorkdayCarry` by (user, job, key) with `evidenceAt = check.evidenceAt`, `refreshWorkdayChecks`, and `ctx.scheduler.runAt(dueAt, "ta/workdays:refreshDueChecks", {jobId})` so a lapsed wait reappears as an event. The UI converts the Colombo `datetime-local` with `colomboLocalToInstant`. Because candidate checks are not computed for returning modes, carry is effectively a 100% feature.
- `markReviewed` (op): worker (own CV, or CV on a post assigned to them; `assertNotAnotherTasCandidate`) or lead/admin of that job; refuses if the CV's work location EOD was already sent; stamps `applications.workdayReviewedAt/By` (idempotent if already >= `reappliedAt`).
- `decide` (op, legacy): approves/denies a `taWorkdayRequests` row (only the job's lead or admin; reason required; counts the same 10 cap). Nothing creates requests any more (`addPosition` returns `pending:false`), but the table, UI (`request.status`, Approve/Decline forms under Team checks) and `closeWorkday` denial of pending ones remain.
- `finish` (op): always throws "Your workday completes automatically when the required EOD email is sent." (returns ok if already finished). Kept so old clients do not 404.

### Flow 6 - Task event log (`refreshWorkdayChecks`)
`export async function refreshWorkdayChecks(ctx, jobId, actorId?, onlyDay?)` runs only in write transactions. For today's days (read via `by_date`; open or `eod`-closed) containing the job, or just `onlyDay` when given, it re-evaluates `jobView` and appends a `taWorkdayTaskEvents` row (key, label, href, kind, status, at, by, evidence, completedAt/By, `observed`) only when `status` or `evidence` changed since the last event for that key. A legacy completion with no known time is flagged `observed:true` and the sidebar prints "Existing completion recorded"/"Completion time not recorded", never "now". `withTaskHistory` merges events into checks (names resolved from `users.fullName`), re-surfaces historical keys only for 100% days, and skips `suggestions:` (while paused), `research:`, `director_candidate:`.
Callers (grep before adding one): `convex/pipeline/pipelineStateMachine.ts:264` (every stage transition), `convex/ta/commit.ts` (write batch: JD edits, jobPosts/profileSuggestions evidence rows, any opening update), `convex/jobs/jobs.ts:341-349`, `convex/ta/openings.ts` (approve JD ~266-276, JD edit ~322, `setWorkingStage`), `convex/ta/hhUpload.ts:198`, `convex/ta/dailyEmails.ts` (:259 result, :275), `ta/workdays` itself (start, addPosition, setWorkType, decide, saveCheck, markReviewed, taskException, carry, finalizeMail, reconcileMail, `recordSourcingRun`, `refreshDueChecks`). `recordSourcingRun` is called by `src/app/actions.ts:~3305` after every Suggestions run (including empty ones) and writes `taSourcingRuns`.
JD hooks: `invalidateJdReviews(ctx, jobId)` clears `jdVersion` on every note of the job (called on any JD text change, so restoring old text still needs reconfirmation); `recordJdReview(ctx,userId,jobId,version)` records the approver's own review when they approve (`ta/openings.ts` approve, and `commit.ts` when `jdApprovedAt` changed and `jdApprovedBy === actor`); repeated confirmation keeps the first `jdReviewedAt`.

### Flow 7 - Sending, receipts and completion
Two send paths create a `taWorkdayMail` receipt in status `sending` before any provider call:
1. Current path: `ta/dailyEmails.ts` `begin` mutation (EOD and midday; also per work location). Inserts `dailyEmails` + receipt (`dailyEmailId`, `submissionType`, `workLocationId`, `workType: selectedMode`). Provider result -> `finalizeDailyEmail` (`convex/lib/dailyEmail.ts`) -> patches receipt `accepted`+`finalizedAt`, and for an original EOD (`!parentId`) calls `autoCompleteWorkday`. Its EOD blockers exclude `director_cv`, `chatgpt`, `midday_email` (chatgpt is checked in preflight).
2. Legacy path: `workdays:beginMail` (refuses jobs with `workLocations`: "Use the location's EOD composer to send this job's email."; clock-stopped 100% refused; blockers = `emailBlockers` minus `mail:`; sending/uncertain receipts block; duplicate activity/EOD/candidates refused; Add-on roster check "Send only your Add-on candidates progressed to Director Review in this Add-on session.") -> `mailResult` (`accepted`/`failed`/`uncertain`, called from `convex/ta/eodMail.ts`) -> `finalizeMail` (sets `finalizedAt`, `autoCompleteWorkday`, `refreshWorkdayChecks`).
`reconcileMail` (lead of that job or admin): receipt must not be finalized; reason 1..1000 ("Record how you verified the mailbox result, including the message reference if sent."); a `sending` receipt needs 5 minutes first; an `accepted` receipt cannot be flipped to failed ("Microsoft Graph already accepted this email. Its submission record needs recovery."). Accept -> finalizes the daily email (or inserts a recovery `reviewRounds` row `C141-WD-...`), marks receipt accepted+finalized+reconciled, then `autoCompleteWorkday`. Reject -> receipt/email `failed`, retry allowed. UI: drawer "Reconcile this email after checking the mailbox" requires the "I checked the sending mailbox" tick (action layer also refuses without `verified=yes`: "Verify the mailbox result before confirming.").

`autoCompleteWorkday(ctx, dayId)` (exported, `convex/ta/workdays.ts`) - the only way a day closes with reason `eod`:
1. Skip if already finished. `entries` = day jobs whose opening still exists (`availableWorkdayEntries`; deleted/binned openings never block, 19 Oct).
2. `receipts` = accepted, finalized, not revised, not `recoveryReopenedAt`, `submissionType` eod/undefined. `completedJobs` = `jobEodComplete` per job (`convex/lib/workLocationEmails.ts`: every id in `entry.workLocationIds` (else active locations) has a receipt; no-location job: any receipt).
3. If any job with `workLocationIds` is incomplete -> return (multi-city: no partial close).
4. `primary` = receipts of completed jobs whose recorded mode is `100%`.
5. `finishedAt` = if `primary` non-empty: `Math.min` of `acceptedAt ?? finalizedAt` (the FIRST final 100% EOD), but `Math.max` if any job has locations; else if the day has no current 100% job and every job is complete: `Math.max` of all receipts (last EOD, returning-only day); else no close.
6. `closeWorkday(ctx, day, at, "eod")`: builds an immutable `completion` snapshot via `view()` (pending requests -> denied "Workday closed before approval"), patches `finishedAt/closureReason/completion`, sets `taWorkdayLeads.finishedAt`, denies pending requests, and notifies each job's lead (`workday_finished`, "Workday completed by EOD email").
Midday, revised (`revised`/`parentId`), failed, uncertain and reopened sends never complete or retime the day. After the clock stops, Follow-up/Add-on and further 100% positions (up to 5 100% a day, `MAX_100_PER_DAY`) can still be added and sent; the clock stays at the first 100% EOD. Also called from `recordActiveMode` and `reconcileMail`.

### Flow 8 - Stale days and recovery
- `recoverStaleDays(ctx, userId)` (called by `start`): every unfinished day with `date < today` is first passed to `autoCompleteWorkday`; if still open it is closed `expired` at `Date.parse(date + "T00:00:00+05:30") + 86400000` (next Colombo midnight), no notification. An expired day is "Incomplete (expired)" in the UI and never counts as success.
- `ta/workdays:recoverOpenWorkdays({dryRun})` (internalMutation, pipeline `run_function` only): lists all unfinished days dated before today (`by_finished` index), returns `{dryRun, affected}`, applies `recoverStaleDays` per user when `dryRun:false`. Idempotent.
- `ta/dailyEmails:enableRequirement({dryRun})`: seeds `dailyEmailPolicy {key:"midday", requiredFrom: next Colombo day}` once; later runs never move the date.
- One-off incident repairs (do not re-run, both date/title-guarded): `convex/admin/repairSanduniMistimedEod.ts` (19 Oct) and `convex/admin/reopenShihabEarlyEod.ts` `run({dryRun})` (20 Oct, guard `workdayDate(Date.now()) === "2026-10-20"`, one user email, opening id, title check; runbook `docs/RECOVERY-SHIHAB-EOD-2026-10-20.md`). Both mark receipts `recoveryReopenedAt`, which every completion filter honours.

### Flow 9 - Scope gate (`assertWorkdayScope`, `convex/lib/workdayScope.ts`)
Applies only to `ta`/`ta_support`. Reads today's rows via `by_user_date`, not the whole history (29 Oct). Today's active day (open or `eod`-closed) must contain the job: else "Add this assigned position to your workday first.". No active day but any prior workday row: "Start your workday before continuing recruitment work." A TA with no workday history is exempt until the first Start. Enforcement points (grep the function name before adding more):
- `convex/ta/applications.ts:132, 284`, `convex/ta/commit.ts:63` (every job touched by a write batch), `convex/ta/cv.ts:42`, `convex/ta/hhUpload.ts:48`, `convex/ta/scoopUpload.ts:43`.
- App side `decideOn` in `src/lib/openings/writes.ts:~44` calls query `ta/workdays:checkScope` for `opening.act` and `opening.sourcing`, returning 403 with the backend message.

### Flow 10 - Team checks (leads/admins/directors)
`dashboard` (internalQuery): `detail:false` returns only `{canWork, canLead, canReview, role, lastFinishedAt/Date, active, history:[], team:[], options:[]}` (cheap poll used by `EodJobChecks`). `detail:true` adds options (the TA's active recruiter `jobAssignments` only, open jobs; never a scan of every opening: reading all `jobs` (embedding, `reverseMatchResults`) broke the 16 MB per-query read limit and Today's Checks said "Could not load workday checks" for TAs and admins, 28 Oct; with a `carry` flag while no active day; the 100% checklist preview is no longer built per option on every poll, 29 Oct: `JobPicker` fetches it for the picked position from `GET /api/workday?preview=<jobId>` -> `ta/workdays:startPreview`, which checks `requireWorker` + `assignedJob`), the 2 most recent days (15 with `allHistory`, sent by the "Load earlier workdays" button as `?history=all`; 28 Oct, so the 20-second poll no longer reads 15 days), `teamAssignments` (built from active recruiter `jobAssignments` rows, then those jobs only; a TA named only in `assignedTaIds` with no assignment row no longer appears), `teamMembers`, `team`, `nextCursor`. For reviewers: `deskWide` = admin, director, ta_lead (since 23 Oct b76374c every reviewer sees every TA's days; management rights stay per job). Query modes: default (open days via `by_finished` take 100 + page of 20 newest), `date` (+ optional `taId`) via `by_date` index paginated 20 ("filter before pagination", older days used to disappear), `focusWorkday` (notification deep link; loads exactly one day). Finished days render the stored `completion` snapshot (jobs filtered to visible ones), except an `eod`-closed day dated today which re-renders live. Each job gets `canManage = canLead && (admin || entry.leadId === me)`; requests likewise. Directors can view but never manage. Management powers = `markReviewed` as lead, `reconcileMail`, `decide`.
`taWorkdayLeads` (by_lead, by_lead_finished, by_workday) is the per-lead seat index; the `else` branch in `dashboard` that reads it is now dead for current reviewer roles (all are `deskWide`) (verified by reading; keep for future non-desk-wide leads).

## UI surface

| Piece | File | Notes |
|---|---|---|
| Mount | `src/app/layout.tsx` (two branches: Clerk and UI-only) | `canViewWorkday(role)` wraps `children` in `WorkdayWorkspace role` (`src/components/Workday.tsx`) |
| TA / TA Support | `WorkdayRail` | always visible at `xl`, `xl:pr-96` page padding; below xl a fixed "Today's checks" button; width `max-w-96` |
| Lead / admin / director | `WorkdayRailLeadAdmin` | closed by default, edge pull-tab "Today's Checks" at 45% height, `aside#workday-rail-lead` `inert` when closed |
| Redirect | `src/app/workday/page.tsx` | `redirect("/openings?checks=open")`; `?checks=open` opens either rail |
| Data hook | `useWorkday(detail, enabled, query)` | `GET /api/workday?detail=0|1&date=&cursor=&ta=&checkDay=`; one request at a time (29 Oct): the next poll is timed 20-25 s (jitter) after the last answer, only while `document.visibilityState === "visible"`, doubling up to 2 min while loads fail; window `focus` loads only if nothing is in flight; the custom event `workday-changed` (every `WorkForm` dispatches it) aborts and reloads at once |
| `WorkdayDashboard` | same file | TA section: "Sent EOD emails - last 31 days" (`data.sentEmails` from `ta/dailyEmails:sent`, links `/openings/<id>/eod?mail=<id>` or `?resend=` for legacy, "Edit and resend"), active day or Start picker, "Add another position", "Previous workdays" (date filter client-side). Reviewer section: "Team checks" with Day / TA / Position / Task status filters (status values incomplete, complete, waiting, excused) and "Older records"/"Latest records" cursor buttons |
| `JobPicker` | same | Start / Add position form (`op=start|addPosition`); shows the picked position's 100% preview checks (fetched with `?preview=`), the "Follow-up jobs carried forward" line, and the clock-stopped note |
| `DailyReview` + `SavedDetails` | same | per-job collapsible; header `"<title> - <mode> - N completed - M remaining"` or "EOD sent"; `WorkingStageMenu`; activity counts (CV reviews, profiles added/worked, candidates submitted, JD/post/research/benchmark activity from `taWorkdayActivity`); "Review this job's end-of-day email" link |
| `Check` | same | row with status (Completed / Reason submitted / Waiting / To do), "Open task page" (`check.href`), history, forms: `markReviewed`, `carry`, `taskException` (submit/update/withdraw), `saveCheck jd`, `saveCheck emptySuggestions`, `ChatgptConfirmation` |
| `EodJobChecks` | same, used by `EodComposer.tsx:~1178` | non-detail poll; lists `emailBlockers` above the composer and reports `blocked`, `excused`, saved link upward |
| Exported forms | `ResearchConfirmation` (Research page), `EmptySuggestionsReason` (Suggestions page), `NoCandidateReason` (unused by pages today, unverified) | |
| API route | `src/app/api/workday/route.ts` | 401 unauthenticated; 403 if `!canViewWorkday`; 503 "Could not load workday checks. Please retry." on any backend throw (logs `[api/workday] <step> role=... <query>` since 26 Oct); `Cache-Control: private, no-store`; with `detail=1` and `canWork` also fetches `sentEmails` |
| Write action | `src/app/workday/actions.ts` `changeWorkday(FormData)` | builds args per `op`; unknown op -> "Unknown workday action."; mutation returning `ok:false` -> "Complete these steps first: ..."; errors via `workdayErrorMessage` (strips `Uncaught Error:` wrappers, 300 chars, else generic "Could not save. Try again..."); `revalidatePath("/workday")` (+ the Suggestions page on `saveCheck`) |
Local-storage keys (UI memory only): `workday-date`, `workday-ta`, `workday-filter-job`, `workday-filter-status`, `workday-open:<dayId>:<jobId>`, `workday-job:<dayId|start>`. Notification deep links use `checkDay`, `checkJob`, `checkTask` to open/scroll the exact `Check`.

## Data

All in `convex/schema.ts` (top of file). Indexes in brackets.
- `taWorkdays` [by_user, by_user_date(userId,date), by_user_finished(userId,finishedAt), by_date, by_finished]: `userId`, `date` (Colombo), `startedAt`, `finishedAt?`, `closureReason?` (`eod`|`expired`), `jobs[]` {`jobId`, `workType`, `addedAt`, `leadId?`, `modeHistory[]`, `carried?`, `workLocationIds?`}, `completion?` (frozen `WorkdayView`).
- `taWorkdayMail` [by_workday_job]: `status` sending|accepted|failed|uncertain, `startedAt`, `acceptedAt`, `finalizedAt`, `submissionType`, `revised`, `workType`, `workLocationId`, `dailyEmailId`, `applicationIds`, `researchLink`, `recoveryReopenedAt`, `reconciled*`.
- `taWorkdayCheckNotes` [by_user_job, by_job]: `jdVersion/jdReviewedAt`, `researchVersion/ReviewedAt/unavailableReasons`, `emptySuggestions{Version,Reason,At}`, `workdayId` (scopes the next three), `noCandidateReason/At`, `chatgptLink`, `confirmedAt`.
- `taWorkdayTaskEvents` [by_workday_job]: append-only; `status` incomplete|complete|waiting.
- `taWorkdayExceptions` [by_workday_job]: append-only submit/withdraw with evidence `version`.
- `taWorkdayCarry` [by_user_job]: `key`, `reason`, `nextAction`, `dueAt`, `recordedAt`, `evidenceAt` (not day-scoped).
- `taWorkdayEvidence` [by_job]: provenance of jobPosts/profileSuggestions changes (`table`, `recordId`, `version`, `at`, `by`), inserted only by `convex/ta/commit.ts`.
- `taSourcingRuns` [by_job]: Suggestions run rounds (`userId?`, `round`, `count`, `at`).
- `taWorkdayLeads` [by_lead, by_lead_finished, by_workday], `taWorkdayRequests` [by_workday, by_lead_status] (legacy approvals), `taWorkdayActivity` [by_workday_job] (written by `commit.ts` for `researchReports`/`benchmarks` ops during an open day; display counters only).
- `dailyEmailPolicy` [by_key]: `{key:"midday", requiredFrom}`.
- Read-only inputs: `jobs` (`jdStatus`, `jobDescription`, `taLeadId`, `workLocations`, `assignedTaIds`, `status`), `jobAssignments` [by_jobId_userId, by_userId_isActive, by_jobId] (+`workingStage`), `taSettings` [by_key], `applications` [by_job_stage_reviewed, by_jobId, by_workday_owner(jobId, ownerTaId, shortlistedAt), by_workday_review, by_workday_reapply, by_candidate_job] (+`workdayReviewedAt/By`, `isAddOn`, `followUp*`), `linkVault` [by_workday_added, by_workday_outcome, by_opening], `jobPosts`, `profileSuggestions`, `researchReports`, `benchmarks`, `reviewRounds`, `cvUploads` [by_status, by_assignToJob], `dailyEmails`, `notifications` (types `workday_started|finished|request|decision|exception`).
Status vocabularies: check status `incomplete|complete|waiting` (+ UI-only "excused" when `exception` set); request status `pending|approved|denied`; closure `eod|expired`.
Partner read lists the workday tables in `convex/integrations/partnerRead.ts` (keep in sync when adding a table).

## Backend wiring

- Public surface: none. Every `ta/workdays:*` function is `internalMutation`/`internalQuery`, called from Next via `convexMutation`/`convexQuery` with `actorId`. Queries: `dashboard`, `checkScope`, `suggestionsCheck`, `eodContext`, `researchExceptionAllowed`. Mutations: `start`, `addPosition`, `setWorkType`, `decide`, `markReviewed`, `taskException`, `carry`, `finish`, `saveCheck`, `emailPreflight`, `recordSourcingRun`, `refreshDueChecks`, `beginMail`, `mailResult`, `finalizeMail`, `reconcileMail`, `recoverOpenWorkdays`. Exported helpers for other modules: `autoCompleteWorkday`, `refreshWorkdayChecks`, `recordActiveMode`.
- Crons/http: none for the workday. The only timers are the per-carry `ctx.scheduler.runAt(dueAt, refreshDueChecks)`. Polling is client-side (20 s). (Separate cron `ta-background-alerts`, quiet-job alerts, is not a workday check.)
- Env flags/kill switches: none specific. Code constants are the switches: `SUGGESTIONS_WORKDAY_REQUIRED` (true) and `MIN_OWN_EXCEL_PROFILES` (1) in `src/lib/workdayRequirements.ts`; `LIMIT = 1200`, ten-position cap, 5-minute reconcile wait in `ta/workdays.ts`; `dailyEmailPolicy` row for midday. Outbound mail itself is governed elsewhere (`OUTREACH_LIVE`, `convex/lib/outreachSafety.ts`, `convex/lib/outboundGuard.ts`, see /eod-email).
- External providers: none called from this module. Microsoft Graph accepts mail inside `dailyEmails`/`eodMail` and only reports back via `mailResult`/`finalizeDailyEmail`.
- Release-only migrations: `ta/workdays:recoverOpenWorkdays`, `ta/dailyEmails:enableRequirement`, `ta/eodCopies:normalizeRetention` (see `docs/WORKDAY-CHECKS.md` rollout), all `dryRun` first, run by the pipeline.

## Access and roles

- Drawer: visible to `ta`, `ta_support`, `ta_lead`, `admin`, `director` (`canViewWorkday`). Others get 403 from the route and no drawer.
- Worker actions (`start`, `addPosition`, `setWorkType`, `saveCheck`, `taskException`, `carry`, `finish`, `suggestionsCheck`) need `ta`/`ta_support` AND `assertJobAccess` as primary/supporting recruiter on that job. Client seats and other roles cannot.
- Lead actions (`reconcileMail`, `decide`, lead-side `markReviewed`) need `admin`, or `ta_lead` equal to that workday entry's `leadId` (`jobs.taLeadId` captured when the job joined the day; changing the opening's lead later does not move old entries).
- Visibility: `ta_lead`, `admin`, `director` read all TAs' days (23 Oct); only `canManage` jobs show action forms. A TA only ever gets `active` plus own history.
- Opening menu capability `opening.act` (`src/lib/auth.ts:226`) gates `WorkingStageMenu`; the collision lock (first to shortlist owns) is separate (see /follow-up).
- The workday gate: `assertWorkdayScope` plus `decideOn`/`checkScope` (Flow 9). Job needs a `taLeadId` to start work on it.
- Backend `requireActor` (`convex/ta/guard.ts`) resolves `actorId`; `mapUser(user).role` maps stored roles (e.g. `ta_manager`) to app roles before every check.

## Invariants and safety

1. Completion only through `autoCompleteWorkday` after a finalized, accepted, original EOD; `finish` always throws (17 Oct 95a32e4). Never add a client-controlled "done".
2. Dashboard/read paths never write (no events, no completion). Event writes only in `refreshWorkdayChecks` inside mutations (13 Oct 23e6794).
3. Idempotency: Start returns the active day; `taskException` repeats are no-ops; `saveCheck` keeps original timestamps for identical re-saves; `mailResult` ignores non-`sending` receipts; `finalizeDailyEmail` returns early if `finalizedAt`.
4. Mail safety: reserve a `sending` receipt before the provider call; any `sending`/`uncertain`/unfinalized `accepted` receipt blocks new sends and work-type changes (`mail:` check). `reconcileMail` waits 5 minutes, never converts an accepted Graph result to failed, and never sends. Outbound still passes `convex/lib/outreachSafety.ts` and `convex/lib/outboundGuard.ts`; never set `OUTREACH_LIVE`.
5. Colombo day: every date comparison uses `workdayDate`; a day belongs to its `date` forever. A prior day is never reused as today's record; stale days close `expired` at next midnight and are not "completed" (17-19 Oct 95a32e4, 0a2ff43).
6. Snapshots: `completion` is immutable after close; later returning-mode sends are recorded on receipts and do not retime the clock.
7. Recovery flag `recoveryReopenedAt` must be respected by every filter over `taWorkdayMail` (completion, `requiredChecks`, `jobView`, `beginMail`). A new filter that forgets it re-breaks the 19/20 Oct recoveries.
8. Deleted/binned openings must not block or appear in live days (`availableWorkdayEntries`, `availableWorkdayRequests`, 19 Oct dfa080a); the day still stores their ids so Bin restore works.
9. Truncation is a blocker, not an omission (`capacity` check, `LIMIT + 1`).
10. Evidence versioning: exceptions and empty-search reasons are tied to an evidence version; JD/ChatGPT/research confirmations are invalidated by content change (`invalidateJdReviews`, `researchVersion`). Do not key them by time alone.
11. Only `canExcuseCheck` tasks can be excused; CV, mail and `mail:` safety never can.
12. Multi-location (21 Oct 4dd30a8): a job's day closes only when every location in `entry.workLocationIds` has its EOD; locations added after the TA started are not required until tomorrow ("This location was added after today's work started...").
13. Errors shown to users must be plain (`workdayErrorMessage`); never leak Convex request ids (20 Oct c0a68c7).
14. Data changes to workday tables are migrations with `dryRun` run by the pipeline; never against live from a laptop.

## Known quirks, gaps and unverified items

- `docs/TA-WORKDAY-FEATURE-PLAN.md` (13 Oct) is superseded: it describes `/workday` page and Start/Finish buttons. `docs/WORKDAY-CHECKS.md` is the maintained doc.
- Drawer default mode vs stored default differ (`dashboard.options` uses "Follow-up" for previously worked jobs; `repo.workingStage`/`eodContext` default "100%").
- "Save team resets stages" (see Work modes); backend-side effect unverified.
- `excel_profiles` counts all-time own profiles on the job, not only today's; the doc says "added by the TA".
- `jd_review` confirmation is per (user, job) across days; `chatgpt` confirmation is per day.
- `midday_email` is absent from Follow-up/Add-on drawer checks but enforced at send time by `dailyEmails`.
- Carry only applies to checks that exist for the mode, so it is 100%-only in practice; `director_wait` is likewise hidden for returning modes.
- `suggestedMode` is a stub returning the requested mode; `setWorkType` message "Use the suggested work type..." is unreachable.
- Legacy `taWorkdayRequests`/`decide`/approval UI and `NoCandidateReason` are dead or near-dead paths; `saveCheck kind:"noCandidates"` and `researchExceptionAllowed` name a "research exception" that is now the chatgpt exception.
- `docs/WORKDAY-CHECKS.md` rollout notes mention `normalizeRetention` which belongs to /eod-email.
- "Eye-marked gate" (named in the request) could not be found in code or commit messages (unverified); the CV-review gate is the `review:` check cleared by `markReviewed` or any shortlist/reject action, now hidden from the TA sidebar and listed only in leads' "Candidate task details".
- No automated browser test of the drawer; coverage is handler-level with a synthetic DB.
- Convex timestamps: `jobs`/`applications` mix numeric and ISO `createdAt` (handled in `jobView` arrival calc); keep that normalisation when touching it.

## How to change it safely

Where to edit:
- Add/remove a 100% setup requirement: `setupChecks` in `src/lib/workdayRequirements.ts` (rows, labels, hrefs), evidence gathering in `requiredChecks` (`convex/lib/workdayChecks.ts`), `isEodSendCheck` and `canExcuseCheck` (`src/lib/workday.ts`), `RETURNING_CHECKS` if returning modes need it, `versions` map for exception versioning, `dailyEmails.ts` blocker exclusions, composer copy (`EodComposer`, /eod-email) and `docs/WORKDAY-CHECKS.md`. Keep `emailPreflight` and `beginMail` in step (both read `emailBlockers`).
- Change a threshold: `MIN_OWN_EXCEL_PROFILES`, `SUGGESTIONS_WORKDAY_REQUIRED` (both consts, update tests that assert `evaluate().length` and counts).
- New candidate-side check: add in `jobView` (stage rules from /follow-up), decide `canCarry`, add the prefix to `CANDIDATE_TASKS` in `src/lib/workdaySidebar.ts` if it must stay out of the TA drawer, and do not add it to `RETURNING_CHECKS` unless returning modes should see it.
- New op: Convex mutation in `ta/workdays.ts`, a branch in `changeWorkday`, a `WorkForm` in `Workday.tsx`, role guard and a test.
- New table or field: `convex/schema.ts`, `convex/ta/model/tables.ts` mapping if the app reads it through `commit`, `convex/integrations/partnerRead.ts` list, and the `WorkdayView` types in `src/lib/workday.ts` (snapshots in `completion` are `v.any()`, old snapshots will lack new fields: read defensively).
- Completion rule: only `autoCompleteWorkday` (+ `closeWorkday`); add a test per branch (100% primary, returning-only, multi-city, expired).
- New caller that changes evidence: call `refreshWorkdayChecks(ctx, jobId, actorId)` in the same transaction.
- Any new write path for TAs on a job: call `assertWorkdayScope` (backend) and route app-side checks through `decideOn`.

Tests (script style, no framework; `node tests/run.mjs` discovers them): `tests/workday.test.ts` (real handlers on a synthetic db: start/add/carry cap, scope, suggestions, JD/ChatGPT timestamps, exceptions, mail begin/result, leader view, finish throws), `tests/workdayRequirements.test.ts` (setupChecks, link validation, thresholds), `tests/workdayRoles.test.ts`, `tests/workdaySidebar.test.ts`, `tests/workdayErrors.test.ts`, `tests/dailyEmails.test.ts` (midday/EOD gating and completion), `tests/eodEligibility.test.ts`, `tests/reopenShihabEarlyEod.test.ts`, `tests/repairSanduniMistimedEod.test.ts`, `tests/researchlink.test.ts`.
Commands: `npm test`, `npx tsc --noEmit -p .`, `npx tsc --noEmit -p convex`.

Pre-merge checklist:
1. All three commands above pass.
2. Handler test added for each new branch (including the day-boundary and `recoveryReopenedAt` cases).
3. Colombo-date logic goes through `workdayDate`, never `toISOString().slice(0,10)`.
4. No dashboard/read function writes.
5. Message text for refusals is plain and specific (UI shows it verbatim).
6. `docs/WORKDAY-CHECKS.md` updated.
7. Flag to the owner anything that changes what TAs/leads see in the drawer, which checks block EOD, or what reaches candidates/directors.

Repo hard rules that apply: never run `convex deploy/run/import/env set` against live from a laptop; live changes only via the release pipeline; outbound only through `convex/lib/outreachSafety.ts` and `convex/lib/outboundGuard.ts`; data changes are `dryRun` internal functions run by the pipeline; branch `<person>/<topic>` + PR, never push to `main`/`production`; no secrets in code or docs.

## History

- 2026-10-13 `23e6794` first workday system (/workday page, Start/Finish buttons, tables `taWorkdayCheckNotes`, `taSourcingRuns`, `taWorkdayEvidence`, `taWorkdayTaskEvents`, lead history, notifications, plan doc); `e6342fe` profile handoffs enforced and assigned positions preserved.
- 2026-10-14 `53914f8` TAs add assigned positions directly (was: request to lead). `f036a64` Start/Finish moved into the sidebar; 100% requires LinkedIn post, eight research fields reviewed, reviewed Suggestions, three own Excel profiles; returning jobs default Follow-up; pending jobs carry. `e7c017b` 100% also requires confirmed JD review. `3f16536`/`26a0374` share-link validation and empty-search reason gated on workday evidence. `d944c84` candidate summary in sidebar. `6576e0b` Suggestions requirement paused. `6be7cdf` EOD allowed once the four setup checks are done. `e905001` Excel profiles 3 to 1 (temporary).
- 2026-10-15 `1610541`/`e987fb1`/`3b7e88e` lead/admin drawer closed by default with an edge tab, moved to mid-screen so it stops covering TA names. `da3529d` EOD requires LinkedIn, reviewed Suggestions (re-required) and a Director Review CV; `9213e05` simplified checks and added daily task exceptions; `643a2ff` multiple 100% positions allowed; `c815389` ChatGPT link synced between EOD and drawer; `048ef4b` compact checks for all roles; `d599c1c` Follow-up and Add-on show only returning tasks (checks only for 100%).
- 2026-10-16 `8222454` restore returning-position behaviour after midday work; `eacc9c2` midday emails (EOD gated once `dailyEmailPolicy` is enabled); `c1bebc5` mode-aware workday and EOD (mode frozen on receipts, `modeHistory`).
- 2026-10-17 `95a32e4` automatic completion by the first final original 100% EOD; Finish button removed (`finish` throws); stale days recover or expire; versioned 31-day EOD backups.
- 2026-10-19 `0a2ff43`, `12369b5`, `f400737` Sanduni's Friday EOD sent on Monday had closed Monday: migration `repairSanduniMistimedEod` moves it back without touching mail; `dfa080a` deleted openings hidden from active days.
- 2026-10-20 `09c78f4`, `7efd9e3`, `25d2048` Shihab's early EOD consumed his Director Review candidates: `reopenShihabEarlyEod` reopens that send (`recoveryReopenedAt`) without sending mail, preserving his other openings' EODs; `c0a68c7` friendly error copy (`workdayErrors`); `b88697d` (21 Oct) freezes the one-time date in the test.
- 2026-10-21 `4dd30a8` work locations: per-location EODs, `workLocationIds` on entries, `lib/workLocationEmails.ts`, city submissions cannot close attendance early.
- 2026-10-23 `f3d57d6` EOD can be sent with zero CVs and no reason in any mode (`director_cv` always complete); `b76374c` TA leads (and directors) review all TA activity (`deskWide`, `canReviewWorkdays`).
- 2026-10-26 `d5497ab` `/api/workday` logs which call failed on 503 (reviewers' panel failed on every 20 s poll).

<!-- skill-meta
verified-commit: 66aa2ca
verified-hash: 395d6834b91cc9fa3a74d6de0506b80e2e659d3c
verified-date: 2026-10-29
sources:
  convex/ta/workdays.ts
  convex/lib/workdayChecks.ts
  convex/lib/workdayScope.ts
  convex/lib/workLocationEmails.ts
  convex/lib/dailyEmail.ts
  convex/ta/dailyEmails.ts
  convex/ta/eodMail.ts
  convex/ta/openings.ts
  convex/ta/commit.ts
  convex/ta/notifications.ts
  convex/admin/repairSanduniMistimedEod.ts
  convex/admin/reopenShihabEarlyEod.ts
  convex/schema.ts
  src/lib/workday.ts
  src/lib/workdayRequirements.ts
  src/lib/workdayRoles.ts
  src/lib/workdayErrors.ts
  src/lib/workdaySidebar.ts
  src/lib/workingStage.ts
  src/lib/eodEligibility.ts
  src/lib/workLocations.ts
  src/lib/openings/writes.ts
  src/components/Workday.tsx
  src/components/WorkingStageMenu.tsx
  src/components/useChatgptResearch.ts
  src/app/workday/**
  src/app/api/workday/route.ts
  tests/workday*.test.ts
  tests/dailyEmails.test.ts
  tests/reopenShihabEarlyEod.test.ts
  tests/repairSanduniMistimedEod.test.ts
  docs/WORKDAY-CHECKS.md
  docs/TA-WORKDAY-FEATURE-PLAN.md
  docs/RECOVERY-SHIHAB-EOD-2026-10-20.md
-->
