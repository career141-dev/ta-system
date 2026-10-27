---
name: follow-up
description: The Follow-up stages and everything that chases a candidate for CV, salary, notice period and the opening's own questions - TA Follow-up, AI Follow-up, manual Send (WhatsApp/Email dialog), the automatic 24-hour reminder sweep, reply reading by AI, auto-advance to Director Review, dropped out/unresponsive. Aliases - chase, nudge, reminders, outreach, Day 0, auto follow-up. Use when changing, debugging or extending any follow-up message, schedule, reply handling or stage rule.
---

# Follow-up

## Scope and boundaries

In this skill: the two Follow-up stages and the machinery that collects missing details from a shortlisted candidate: the manual Send/Stop buttons, the automatic reminder sweep, the Day 0 and reminder messages (WhatsApp template, free text, email), the reading of candidate replies, the completeness rule and the move to Director Review, and the closing rules (Dropped out / `unresponsive`, reinstate). Also the per-opening follow-up questions and the "Automatic follow-up" switch.

Neighbouring skills (do not duplicate; follow the link):
- /voice-agent: Aura web call, `ta/voice.ts`, ElevenLabs/LiveKit. Here only: `AuraCallButton` sits inside `FollowUpActions`; a finished call calls `updateFollowUpFlags` + `checkAndAdvanceFollowUp`.
- /sets-shortlist: the Shortlist button, owner claim, set numbers, Director Review page and its decisions. Here only: `claimForTa` pulls a candidate into Follow-up and decides whether Day 0 goes.
- /scoop: Scoop and HH (headhunted) uploads that put people into Follow-up. /excel-tables: "Add to pipeline" from Tables and "Back to Excel Tables". /database-search: database matches that are shortlisted.
- /cv-extraction: CV parsing and the AI score that files a CV straight into AI Follow-up (`cvs/cvScoringActions.ts`).
- /email-intake: `mailIntake/*` reading linkedin@/cv@/job@ for CVs (separate from the reply path in `emailAgent.pollEmailInbox`).
- /workday: workday checks that list "missing details" and "follow-up is due" (`convex/ta/workdays.ts`), the working-stage gate (`assertWorkdayScope`). /eod-email: the end-of-day email. /strategy-planner, /openings: the opening itself.

## How it works now

### Stage vocabulary

Two vocabularies, one stored field (`applications.currentStage`). The only translator is `convex/ta/stages.ts`.

| TA System (UI) | Backend stored | Meaning |
|---|---|---|
| `ta_follow_up` | `follow_up` | A TA's shortlist. Written for every TA shortlist/move/bring-back. |
| `ai_follow_up` | `ta_shortlist` (retired alias `ai_call` also reads as AI Follow-up, never written) | Only the AI's own shortlist: a new CV scoring >= `job.minMatchScoreToShow` (default 60) in `cvs/cvScoringActions.ts` (patches the stage directly, then calls `initiateFollowUpOutreach`). |
| `director_review` | `second_shortlist` | Where complete candidates go. |
| `dropped_out` | `unresponsive` | The desk's name for gave-up/removed. Reason in `applications.droppedOutReason`. |

`toBackendStage("follow_up")` still maps to `follow_up` (a page open over the 22 Sep release). `isFollowUpStage()` = AI or TA Follow-up; both reply paths and the AI use it to refuse chasing anyone elsewhere (2 Oct, 3e7f73c). Unknown stored stages read as `new_cv`.

### Flow A: entering Follow-up (who sends Day 0)

Entry points: `ta/applications:shortlist` and `ta/applications:moveStage` -> `claimForTa` -> `executeStageTransition(... "follow_up", bypassRoleCheck, skipAutoOutreach)`; HH/Scoop/Tables adds and "Brought back" (`reinstate` in `src/app/actions.ts`) all route through `moveStage`.

- `skipAutoOutreach` is `!followUpOn(job)`. Switch ON: the move calls `initiateFollowUpOutreach(ctx, appId)` (no options = automatic) and Day 0 goes at once. Switch OFF: nothing is sent; a TA presses Send (Flow B). "Off means off" (e61e421).
- `claimForTa` only pulls `new_cv, matched, ai_follow_up, rejected, dropped_out` into Follow-up; a candidate already at Director Review..Placed is claimed in place (ba3902f, 2 Oct).
- `executeStageTransition` (`convex/pipeline/pipelineStateMachine.ts`) on entering `follow_up`/`ta_shortlist` sets `followUpEnteredAt = now`; on entering any other stage calls `stopFollowUpSequenceForApp`.
- AI route: `cvs/cvScoringActions.ts` (score >= pass mark and stage `new_cvs`) patches `currentStage: ta_shortlist` + `followUpEnteredAt` directly and calls `initiateFollowUpOutreach` with no `skipAutoOutreach` concept: it still respects the job's `agent3Enabled`/channel flags inside the helper.

### Flow B: manual Send / Stop

Trigger: TA presses WhatsApp or Email on a Follow-up row (`CandidateRow` -> `FollowUpActions` -> `FollowUpDialog`), or the candidate page chat tab (`LiveFollowUp`). The dialog first loads `GET /api/conversation/[appId]` (the whole thread + state), then Send runs server action `sendFollowUpNow` (`src/app/actions.ts`) -> `convexMutation("ta/followUp:send", { actorId, applicationId, channel? })`. Channel omitted = both (the older button).

`ta/followUp:send` order (`convex/ta/followUp.ts`):
1. `requireActor`, `assertJobAccess(WORKS_THE_DESK)`, `assertNotAnotherTasCandidate` (collision lock).
2. Stage must be `ai_follow_up`/`ta_follow_up`, else "Move the candidate to Follow-up before sending."
3. `candidate.doNotContact` -> "This candidate has asked not to be contacted."
4. Contact checks: "No phone number on file for WhatsApp." / "No email address on file." / "No phone number or email address on file."
5. `before = followUpAttemptCount`, `max = job.maxFollowUpAttempts ?? 3`.
6. `sameRound = sameRoundAs(...)` (`lib/followUpScope.ts`): single channel pressed, `ROUND_WINDOW_MS` = 15 min after a manual send on the other channel, attempts > 0 -> the second channel is the same round: same message kind, no new attempt.
7. `justSent(...)` (`DOUBLE_PRESS_MS` = 60 000): every requested channel already in `followUpLastManualChannels` within 60 s -> returns `{ sent:false, duplicate:true, reason:"A follow-up was sent to this candidate a moment ago (follow-up N of M). Nothing was sent again." }`, no attempt used. Two TAs clicking or a double click are serial in one Convex transaction (2 Oct, ba3902f).
8. `!sameRound && before >= max` -> throws "All N follow-ups have been sent. Call them, or mark them as dropped out."
9. `initiateFollowUpOutreach(ctx, appId, { isManual:true, only: channel, sameRound, report })`. `report.sent=false` -> "Everything the follow-up asks for is already collected."; `report.blocked` -> returns `blocked:true`, "Not sent - messages to candidates are switched off on this system (test mode). It is recorded in the chat and not counted as a follow-up." (UI shows it as a note, not an error).
10. Patches `followUpLastManualSendAt` / `followUpLastManualChannels` (kept as-is for a same-round second channel), returns `{ sent, kind: initial|reminder, attempt, maxAttempts, sameRound, channels, communicationId }`. The action turns it into "WhatsApp follow-up sent (approved template)" / "Follow-up email sent" / "Reminder sent" + "follow-up X of Y".

Stop: `stopFollowUpNow` -> `ta/followUp:stop` -> `stopFollowUpSequenceForApp` (clears `nextFollowUpScheduledAt`, `nextFollowUpMessage`, `flaggedForTaReview`, `taReviewReason`; marks pending `communications` rows `failed` + `stoppedSequence:true`). It does not change the stage or the attempt count. Dialog confirms with `window.confirm`; Stop is shown only when attempts > 0.

Manual send ignores `channel_toggles`, `autopilotEnabled` and the job's channel flags: a TA's chosen channel always runs; with no channel and both job flags false it forces both.

### Flow C: `initiateFollowUpOutreach` (`convex/pipeline/followUpHelper.ts`)

Shared by manual send, the stage machine, and the AI route.

1. Candidate `doNotContact` -> logs, sets `report.blocked`, returns.
2. Non-manual and (`!job.agent3Enabled` or both `enableWhatsAppFollowUp`/`enableEmailFollowUp` not `true`) -> skip. (Manual/auto differ: automatic reads `=== true`; channel enablement below reads `!== false`.)
3. Completeness: CV (`followUpCvReceived` or candidate `cvUploadId`/app `cvFileId` when the flag is undefined), current salary, expected salary, notice period (flag, or candidate field when flag undefined), every `job.customFollowUpQuestions` label has `app.customFollowUpAnswers[label]`. All present -> return (nothing sent).
4. Missing list: "CV / Resume", "Current Salary", "Expected Salary", "Notice Period", then the custom questions; formatted as `• item` lines.
5. Channel selection: manual+`only` -> that channel only; manual without `only` -> job flags, both forced on if both off; automatic -> job flags (`!== false`), abort if both off.
6. `isNudge = sameRound ? attempts > 1 : attempts > 0`. `deliverable` = some enabled channel passes `resolveRecipient` (`lib/outreachSafety.ts`).
7. Automatic call on a `ta_shortlist` app with no deliverable channel -> moved to `follow_up`, `aiFollowUpNoReply:true`, pipeline event `ai_followup_no_contact_to_ta`; returns.
8. `report = { sent:true, kind, blocked: !deliverable }`.

Day 0 (not a nudge):
- Email-first delay: `emailFirstDelayMs(job.whatsappAfterEmailDays, emailEnabled && candidate.email && email deliverable)` (`lib/templateBudget.ts`). Non-null = skip WhatsApp now.
- WhatsApp: if enabled, not held back, and the phone has digits: schedule `communications/metaTemplateSender:sendMetaTemplate` `{ applicationId, templateType:"initial_outreach" }` (template `career141_initial_outreach`). No `communications` row is inserted here; `sendMetaTemplate` inserts one when it logs the outcome.
- Email: if enabled, builds `initialReachOutEmail({candidateName, gender, taName, taEmail, jobTitle, clientIndustry, country, asks: missingFields})` (`communications/emailHtml.ts`, desk-approved text of 30 Sep; subject `<job title> opportunity – Career141`), inserts an outbound `communications` row (`sequenceDay:0`, `deliveryStatus:"pending"`), schedules `communications/graphEmail:sendGraphEmail` with `taEmail` = `assignedTa(...).email` (empty -> system inbox). No candidate email -> row marked `failed`, "Candidate has no email address".
- State: `sameRound` -> return, nothing else. `!deliverable` -> only `followUpEnteredAt`, `nextFollowUpScheduledAt: undefined`. Else `followUpAttemptCount:1`, `nextFollowUpScheduledAt = now + (emailFirstMs ?? 24h)`, `followUpState.lastContactDay:0`, `firstChannelUsed` ("whatsapp" unless email went first).

Reminder (nudge):
- Text: `app.nextFollowUpMessage || job.followUpSampleTemplate || default "Hi <name>, This is a friendly reminder ..."` with placeholders `{candidate_name} {job_title} {missing_fields} {company_name}` (company = `appSettings.system.brandName`).
- WhatsApp: inserts outbound row (`pending`, `sequenceDay = followUpState.lastContactDay`), schedules `whatsappOutbound:sendWhatsApp` (Flow D).
- Email: only if `candidate.email`; subject = `job.followUpEmailSubjectTemplate` or "Action Required: Missing info for your <title> application"; HTML from `buildStructuredEmailHtml`; `emailAgent:sendFollowUpEmail` with `fromEmail = assignedTaEmail`.
- State (not same round, deliverable): `nextFollowUpScheduledAt = now + 24h`, `nextFollowUpMessage` cleared, `followUpAttemptCount + 1`, `lastContactDay` = 4 (when previous attempts were 1) else 6. Not deliverable: schedule cleared, count unchanged.

`assignedTa()`: `app.ownerTaId` -> `post.assignedTaId` (job post the candidate applied through) -> `job.primaryRecruiterId`; first with an email wins (30 Sep).

### Flow D: how a WhatsApp reaches the candidate

- Free text: `whatsappOutbound:sendWhatsApp({communicationId, candidateId, jobId, body, isReplyToCandidate?})`. Guard `followUpCancelledReason(comm, app, isReply)` (`lib/graphMail.ts`): comm `stoppedSequence` or `failed` -> "Follow-up was stopped before this message went."; unless `isReplyToCandidate`, a stage other than `follow_up`/`ta_shortlist`/`matched_candidates` -> "Cancelled: the candidate is no longer in Follow-up (<stage>)." Failed rows are marked `failed` with the reason.
- Window guess: `hasRecentInboundComm(candidateId, 24h)` reads our own inbound WhatsApp rows. Closed -> schedules `sendMetaTemplate` with `templateType:"reengagement"` (template `career141_followup_reminder`, params name + job title; the original text is replaced by the template wording). Open -> `metaDirectSender.sendMetaFreeText`. If Meta answers 131047/131026 (`isOutsideWindowError`) the sender falls back to the reengagement template (25 Sep, 83c3d66). Meta is the authority on its window.
- `sendMetaTemplate` order: `META_ACCESS_TOKEN` present; job must resolve (no fallback to another job); `refuseIfDoNotContact`; `followUpCancelledReason`; sender phone-number id from the job's outbound number (`getJobOutboundWhatsAppNumber`/`getMetaPhoneNumberId`, default `META_PHONE_NUMBER_ID`); candidate phone digits; `resolveRecipient("whatsapp")`; **daily cap** `dailyTemplateCap(C141_WHATSAPP_TEMPLATE_DAILY_CAP)` counts `communications` rows with `billableTemplate:true` today (UTC day, index `by_channel_time`) - over the cap: row marked failed "Not sent - the daily WhatsApp template limit of N has been reached ...", and `retryTemplateTomorrow` sets `nextFollowUpScheduledAt` to the next UTC midnight; then `phoneAllowed` (outbound lock); POST to Meta Graph v19.0 trying language `en` then `en_US` (only a 132001 error moves to the second); `logTemplateCommunication` writes status and `billableTemplate:true` only when Meta accepted.
- `initial_outreach` params: name (candidate name with a trailing "(+94...)" stripped), job title, requirements snippet (first four `requiredSkills`, else first sentence of the JD <=140 chars, else 130-char cut), missing list joined by " | " (Meta forbids newlines/tabs/4+ spaces, hence `sanitizeParam`).
- Number formatting: `internationalPhone()` in `lib/outreachSafety.ts` turns `07xxxxxxxx` into `94...` (`OUTREACH_DEFAULT_COUNTRY_CODE`, default 94) and strips `00`.

### Flow E: the automatic sweep

Cron `evaluate-follow-up` (every 7 minutes, `convex/crons.ts`) -> `internal.crons.evaluateFollowUpStage({})` (the `taOnly` arg is used only by the staging cron, below). Everything in one mutation:

1. Kill switches: `appSettings` row key `system`: `autopilotEnabled === false` -> return; `channel_toggles.whatsappFollowUp/emailFollowUp === false` pause that channel (both paused also freezes the time-based closes).
2. Jobs: `jobs` by `by_status = active`, filtered by `sweepCovers(job, taOnly)` = `followUpOn(job)` (`agent3Enabled === true` and either channel flag true) and, if `taOnly`, `followUpStartsOnSend`.
3. Reading: `readWindow` (`lib/cronCursor.ts`) over keys `<jobId>|follow_up` and `<jobId>|ta_shortlist`, up to `MAX_APPS_PER_RUN` = 60, index `by_job_stage` with `_creationTime > cursor`, skipping `flaggedForTaReview === true`; cursor stored with `writeCursor` under name `followUpSweep` (or `followUpSweep.taOnly`). Fixes the 2 Oct starvation (fdab754).
4. Per application: skip do-not-contact, missing/inactive job.
5. AI Follow-up (`ta_shortlist`): no phone and no email, or >= 1 day in stage with no `lastCandidateReplyAt` -> `toTaFollowUp` (`sweepMove(... "follow_up")`, then patches `aiFollowUpNoReply:true`, clears schedule, restores `followUpEnteredAt` so the clock keeps running).
6. Attempt ceiling: `maxAttempts = job.maxFollowUpAttempts ?? 3`; `followUpAttemptCount >= max` and not `lastReminderStillOpen` (TA openings: last reminder gets its 24 h, i.e. `followUpStartsOnSend` and `now < nextFollowUpScheduledAt`) -> AI stage goes to TA Follow-up, TA stage goes to `unresponsive` ("No reply after N follow-up attempts.").
7. Completeness: `directorReviewBlockers(app, candidate)` empty and all custom questions answered -> sets `followUpCvReceived`, `followUpExpectedSalary`, `followUpNoticePeriod` true (not current salary) and `sweepMove(... "second_shortlist")` with a reason "Auto-advanced from Follow-up: CV, expected salary and notice period confirmed." (current salary is not required; "Negotiable"/"Not disclosed" count).
8. `maxFollowUpDays` (if a positive number on the job) elapsed since entry (`followUpEnteredAt || lastStageChangedAt || _creationTime`) and not all channels paused -> `unresponsive` "Profile still incomplete after N days.", `followUpState.replyChannel = "unresponsive"`.
9. Scheduled message due (`nextFollowUpScheduledAt <= now`): first clears `nextFollowUpScheduledAt` (the mutex against a concurrent run), clears ETA flags (`waitingForCandidateEta`, `candidateEtaMs`, `candidateEtaText`), then builds the missing list and text (`app.nextFollowUpMessage || job.followUpInitialTemplate || default`). WhatsApp (if not paused and `enableWhatsAppFollowUp !== false`): attempts 0 and no stored message -> `sendMetaTemplate initial_outreach`; otherwise inserts the outbound row and `sendWhatsApp` (window rules of Flow D). Email (if not paused, flag `!== false`, candidate has email): `sendFollowUpEmail` from the assigned TA. Then `nextFollowUpScheduledAt = now + 24h`, `nextFollowUpMessage` cleared, count + 1.
10. TA openings (`followUpStartsOnSend`) stop here (`continue`): the day-tier flow would double up.
11. Legacy static flow (CV-pipeline jobs only): 7 days in stage without completion -> `unresponsive` "Profile still incomplete after 7 days in Follow-up."; promised-ETA hold (`waitingForCandidateEta`, `candidateEtaMs`); records `followUpState.replyChannel` from the first inbound/completed call; day tiers by whole days in stage: 0 -> Meta initial template, 4 and 6 -> WhatsApp text from the missing list, 2 and odd days silent (AI call branch `triggerAiCall` is never set; voice suspended), idempotency by `followUpState.lastContactDay >= targetDay`. No email is sent from this flow (removed 2 Oct).

All stage moves in the sweep use `sweepMove` -> `executeStageTransition({actorId:"system", bypassRoleCheck:true, skipAutoOutreach:true})`, so they close/stop/record properly (2 Oct, fdab754).

Staging/quiet registry: with `C141_DISABLE_CRONS=true` the whole `crons` registry is replaced by `quiet`; `C141_TA_FOLLOW_UP=on` adds cron `ta-evaluate-follow-up` (7 min, `{ taOnly: true }`). Read-only impact check before enabling outreach: `convex/admin/followUpBacklog.ts:countDueFollowUps` (dashboard function runner; run it, do not run mutations from a laptop).

### Flow F: the automatic switch

UI toggle "Automatic follow-up" on both follow-up stage pages -> `setOpeningAutoFollowUp` (needs `opening.manage`) -> `backend.setAutoFollowUp` -> `ta/followUp:setAuto` -> `jobs.patch(autoFollowUpPatch(enabled))`:
- ON: `agent3Enabled:true, enableWhatsAppFollowUp:true, enableEmailFollowUp:true, followUpStartsOnSend:true`.
- OFF: `agent3Enabled:false, enableWhatsAppFollowUp:false, enableEmailFollowUp:false` (must clear the channels too; the helper reads them `!== false`). `followUpStartsOnSend` is left true.
- Also copies `followUpQuestions` labels into `customFollowUpQuestions` and bumps `updatedAt`. New-opening form checkbox `autoFollowUp` (`CaptureForm`) -> `ta/openings` create applies `autoFollowUpPatch(true)`.
- `ta/model/projections.ts` exposes `autoFollowUp = followUpOn(job)`; so a CV-pipeline job with its own flags set also reads as "on".
- Max attempts (`maxFollowUpAttempts`) and max days (`maxFollowUpDays`) have no TA UI; TA openings use the default 3 attempts, no day limit.

### Flow G: replies

WhatsApp: Meta POST to `convex/http.ts` routes `/whatsapp`, `/api/whatsapp`, `/whatsapp-whatchimp`, `/api/whatsapp-whatchimp` -> `communications/whatchimp.ts:handleWhatChimpWebhook`. Checks in order: `META_APP_SECRET` set (else 503) and `X-Hub-Signature-256` valid (else 401) - added 23 Sep (36d139d); status-only payloads ignored; messages from the business/TA number ignored; documents/images -> `cvs/ingestion:processInboundCV`; text -> `whatsappOutbound:checkAndRecordFollowUpReply({senderPhone,textBody})`. If it returns `isFollowUpReply` the webhook stops; otherwise keyword/pre-application handling continues (/cv-extraction territory).

`checkAndRecordFollowUpReply` (`whatsappOutbound.ts`):
1. `findCandidateByPhone` -> `candidatesWithPhone` gathers every record holding the number in any spelling (`by_phone`, `by_phoneClean`, +94/0 forms, tail-9 fallback over the newest 200); several matches -> prefers a record with an open application in `follow_up`/`ta_shortlist`/`matched_candidates` (rank 2), then any open application, then newest (23 Sep, f6bcaba).
2. Application = the one on the latest outbound WhatsApp row if still open, else first open one; then an app in Follow-up beats one that is not.
3. Echo guard: body starting "Hi " and containing "We've recorded your update" or "still waiting on the following" is ignored.
4. 30-second duplicate guard: identical inbound body within 30 s -> `{isFollowUpReply:true}` without recording again.
5. Inserts inbound `communications` (`deliveryStatus:"read"`), patches `lastCandidateReplyAt`.
6. Not in Follow-up -> recorded, no AI reply (2 Oct). Body > 2 chars -> schedules `inboundExtraction:extractDetailsFromText({candidateId,textBody,channel:"whatsapp",applicationId})`.

Email: `emailAgent:pollEmailInbox` (crons `poll-linkedin-inbox` 13 min, `poll-cv-inbox` 11 min, `poll-jobs-sender-inbox` job@ 3 min, `poll-per-job-email-inboxes` 17 min via `scheduleEmailPolling`, plus Graph webhook `POST /api/graph-webhook` which schedules a poll of the mailbox in the notification; `clientState` checked, none set = nothing accepted) -> `emailAgent:checkAndRecordEmailReply`: test-mode sender mapping (reply from `OUTREACH_TEST_EMAIL` maps to the last emailed candidate when outreach is not live), matches candidate by `by_email`, once per Graph message id (`communications.externalMessageId`, index `by_externalMessageId`), newest application in Follow-up wins, inserts the inbound row, and if in Follow-up schedules `extractDetailsFromText({channel:"email", inboxEmail, messageId, senderEmail, applicationId})`. The older `generateAndSendAiEmailReply` action is no longer scheduled (dead code; it caused double replies).

`inboundExtraction:extractDetailsFromText` (the AI):
1. Uses `args.applicationId` (checked to belong to the candidate); must be in Follow-up; skips do-not-contact.
2. Builds known facts + missing list (`lib/answered.ts` rules: a figure or words count), history scoped to this application only (`getRecentHistoryQuery`), job context, `conversationTone`, the job's `followUpInitialTemplate`/`followUpSampleTemplate` as style references.
3. Model `getModelForTask("email_auto_reply")` (`convex/lib/llm.ts`), temperature 0.1, up to 3 attempts, JSON out: `currentSalary`, `expectedSalary`, `currentSalaryNote`, `expectedSalaryNote`, `noticePeriodDays`, `noticePeriod`, `candidateSummary`, `customAnswers`, `intent` (`provided_all|provided_partial|interested_no_eta|promised_eta|asked_question|not_interested`), `candidateEtaMinutes`, `nextActionTimeHours`, `nextActionMessage`, `detectedQuestion`.
4. ETA > 72 h (`MAX_ETA_MINS` = 4320) -> `followUpMutations:flagForTaReview` (sets `flaggedForTaReview`, `taReviewReason`, clears schedule, writes pipeline event `flagged_for_ta_review`) and stops; the sweep then skips that row until a TA acts.
5. Writes `updateCandidateDetails` (candidate fields, `customFollowUpAnswers` merged by fuzzy question match and mirrored into `answers` by question id), which runs `updateFollowUpFlags` on all the candidate's applications and `checkAndAdvanceFollowUp`. A decline in words is saved in the `*Note` / `noticePeriod` fields and counts as answered (23 Sep, 732f323).
6. Candidate in AI Follow-up that replied -> `transitionAiFollowUpToTaFollowUp` (stage `follow_up`, event `ai_followup_replied_to_ta`).
7. Question detected -> `communications/inquiries:createInquiry` (status `answered_by_ai` or `unresolved`).
8. Reply composition: complete -> "profile is now 100% complete ... advanced to Second Shortlist"; `promised_eta` -> `updateCandidateEta` (schedule = ETA); otherwise `nextActionMessage` or a fallback. Then `clearPendingFollowUp`, and for non-complete non-ETA replies `scheduleDynamicFollowUp` with a reminder naming what is still missing, in `nudgeHoursWithinWindow(hours, channel)` hours (`lib/followUpWindow.ts`: WhatsApp max 23 h = 24 h window minus 1 h sweep headroom; email 24 h).
9. Reply sent on the arrival channel: email -> `emailAgent:createOutboundEmailRecord` + `graphEmail:replyToMessage` (thread reply) or `sendGraphEmail` with `isReplyToCandidate:true`; WhatsApp -> `whatsappOutbound:recordLocalWhatsappOutbound` (30 s outbound dedupe) + `sendWhatsApp` with `isReplyToCandidate:true`.
10. Any extraction exception: fail-open fallback schedules a generic reminder (`scheduleDynamicFollowUp`) within the window.

A reply does not pause the sweep by design (18 Sep, cf5b78d reversed ad60c7d the same day); the sweep carries on when the conversation goes quiet.

### Flow H: complete, advance, close, reinstate

- Complete rule (UI/backend gate): `directorReviewBlockers` (`convex/ta/stages.ts`): CV, expected salary, notice period; current salary not required. `needsReviewDetails(from,to,decidedByReviewer)`: entering `second_shortlist` always, and, since 2 Oct, any jump from before Director Review straight to `director_shortlist`..`placed` unless the reviewer decided. Enforced in `executeStageTransition` with "Cannot move to Director Review: still missing ..." / "Cannot skip Director Review: still missing ...".
- Auto-advance paths: the sweep (Flow E.7), and `followUpHelper.checkAndAdvanceFollowUp`, run after every detail write (`updateCandidateDetails`, `applications/applications.ts`, `candidates/candidates.ts`, `ta/voice.ts`). The helper's rule is stricter (it also requires the current-salary flag) and it patches `currentStage: second_shortlist` directly, with no pipeline event; it also reopens an application auto-rejected "Did not complete requirements within 7-day window".
- Manual: `SendToDirectorReview` button (shown by `LiveFollowUp` when nothing is missing) -> `moveStageInline` with stage `director_review`.
- `ReviewDetailsForm` ("Details for Director review", candidate page) lets a TA type salaries/notice/CV when the answer came by phone; `saveReviewDetails` -> `writeCandidateReview`.
- Dropped out: `executeStageTransition(unresponsive)` sets `isActive:false`, `droppedOutReason`, stops reminders. Triggers: sweep (attempts, `maxFollowUpDays`, 7-day legacy), TA move, "Removed from the opening", "Back to Excel Tables" (reason `BACK_TO_TABLES_REASON`).
- Reinstate: `reinstate()` in `src/app/actions.ts` -> `backend.moveStage(... "ta_follow_up", "Brought back")`; the collision lock applies (owner or desk-wide only); the backend clears `rejected*`, `droppedOutReason`, restores `isActive` and claims the app if unowned. A reinstated app's `followUpAttemptCount` is not reset by this path (only `followUpMutations:resetFollowUpApp` / `addCandidateToJobFollowUp` do, and nothing in the TA UI calls them) (unverified whether anything else resets it).

### Flow I: per-opening questions

TA System stores `opening.followUpQuestions: {id,label}[]` (max 12 in the local store). Edited in the Follow-up pages: `setOpeningQuestions` (textarea, one per line, keeps ids when wording unchanged) and `addOpeningQuestion` (AskQuestion box on TA Follow-up, <= 200 chars, duplicate-ignoring); both need `opening.manage`. They write through the store sync (`convex/ta/model/tables.ts` openings `toDoc`): `followUpQuestions` and `customFollowUpQuestions = questionLabels(...)` (kept in step unless the job was never backfilled). Answers are `applications.answers` (by id) mirrored to `customFollowUpAnswers` (by label, `answersByLabel`) in the `applications` `toDoc`; replies come back through `updateCandidateDetails` (`answersById`). The backend asks and matches by label, so renaming a question orphans old answers. The "standard questions" box (`setFollowUpStandard`, setting `followUpQuestions`) affects only the local engine and the UI labels; the live backend always asks CV, current salary, expected salary, notice period.

### Local-store engine vs live Convex

`src/lib/followup.ts` is the desk's 13 Sep design (AI call first, WhatsApp+email, 07:00-21:00 Colombo contact window `CONTACT_FROM_HOUR`/`CONTACT_TO_HOUR`, `NUDGE_AFTER_HOURS` = 3, `WINDOW_HOURS` = 24, all inside one day). It drives `FollowUpPanel`, `recordFollowUpAttempt`, `recordFollowUpCall`, `logFollowUpReply` and `repo.followUp()` only when `isConvex()` is false (`src/data/mode.ts`; the candidate page renders `LiveFollowUp` instead in Convex mode). It sends nothing. Live behaviour is Convex: 24 h x up to 3, not 3 h within a day. Do not edit one expecting the other to change.

## UI surface

| Where | Component / action | Calls | Who |
|---|---|---|---|
| `/openings/[id]/pipeline/ta_follow_up` and `/ai_follow_up` (`src/app/openings/[id]/pipeline/[stage]/page.tsx`) | "Automatic follow-up" card, Turn on/off | `setOpeningAutoFollowUp` -> `ta/followUp:setAuto` | `opening.manage` (lead/desk-wide or recruiter on the opening) |
| same | "Follow-up questions" (textarea, Save) | `setOpeningQuestions` | `opening.manage`; others read-only list |
| TA Follow-up page | `AskQuestion` | `addOpeningQuestion(Inline)` | `canAsk = opening.manage` |
| TA Follow-up page | `HhUpload` | /scoop skill | `opening.act` |
| Candidate row (`CandidateRow.tsx`), Convex mode, stage in follow-up, not `locked` | `FollowUpActions`: Aura Call, WhatsApp, Email; "Needs ..." chip from `directorReviewBlockers` | dialogs below | `opening.act` |
| `FollowUpDialog` | conversation + Send + Stop follow-up | `GET /api/conversation/[appId]` (`ta/outreach:followUpState`, `messagesFor` limit 100); `sendFollowUpNowInline`, `stopFollowUpNowInline` | `opening.act` |
| Candidate page chat tab (`/openings/[id]/candidate/[appId]?tab=chat`) | `LiveFollowUp` (server component): checklist, automatic-status line, "Needs you: ..." when flagged, `SendToDirectorReview`, Stop, test-mode banner from `ta/followUp:gateStatus` | queries above | seat on the opening |
| Candidate page (call tab) | `AuraCallButton`, `WebCallResults` | /voice-agent | `opening.act` |
| Candidate page | `ReviewDetailsForm` | `saveReviewDetails` | `opening.act` |
| Local mode only | `FollowUpPanel`, `ScreeningPanel` | repo actions | n/a |

Dialog button text states: `mode` from `delivery` (`deliveryMode()`): "live" -> "Send the first WhatsApp/email" / "Send follow-up N of M" / "All M sent" (disabled at `sent >= max`); "test" -> "Send to the test number/address" + warn banner; "off" -> "Record WhatsApp (not sent)" + banner "messages are recorded here but not sent, and are not counted". Failed rows show "not sent (test mode)" for `/test mode: blocked/i` errors, else "not delivered".

## Data

Tables (`convex/schema.ts`):
- `applications`: `currentStage`, `followUpEnteredAt`, `followUpAttemptCount`, `followUpState {lastContactDay, firstChannelUsed, replyChannel}`, `followUpLastManualSendAt`, `followUpLastManualChannels`, `nextFollowUpScheduledAt`, `nextFollowUpMessage`, `flaggedForTaReview`, `taReviewReason`, `followUpCvReceived`, `followUpCurrentSalary`, `followUpExpectedSalary`, `followUpNoticePeriod`, `customFollowUpAnswers` (label -> answer), `answers` (id -> answer), `waitingForCandidateEta`, `candidateEtaMs`, `candidateEtaText`, `lastCandidateReplyAt`, `aiFollowUpNoReply`, `droppedOutReason`, `ownerTaId`, `candidateCurrentSalary`, `candidateExpectedSalary`, `candidateNoticePeriodDays`. Indexes used: `by_job_stage`, `by_candidateId`, `by_candidate_job`.
- `jobs`: `agent3Enabled`, `enableWhatsAppFollowUp`, `enableEmailFollowUp`, `followUpStartsOnSend`, `maxFollowUpAttempts`, `maxFollowUpDays`, `customFollowUpQuestions` (labels), `followUpQuestions` (id+label), `followUpInitialTemplate`, `followUpSampleTemplate`, `followUpEmailSubjectTemplate`, `followUpEmailBodyTemplate`, `enableEmailFollowUpTemplate`, `whatsappAfterEmailDays`, `conversationTone`, `minMatchScoreToShow`, `primaryRecruiterId`, `status`. The template fields exist only from the CV platform; there is no TA editor. Dead agent3 fields (`agent3Day2Message`, `agent3CustomSteps`, ...) are not read by the follow-up code (unverified for other modules).
- `candidates`: `currentSalary`, `expectedSalary`, `currentSalaryNote`, `expectedSalaryNote`, `noticePeriodDays`, `noticePeriod`, `cvUploadId`, `doNotContact`/`doNotContactReason`/`doNotContactAt`, `phone`, `phoneClean` (indexes `by_phone`, `by_phoneClean`, `by_email`).
- `communications`: `direction`, `channel`, `subject`, `body`, `deliveryStatus` (`pending|sent|failed|delivered|read`), legacy `status`, `errorMessage`, `sentAt` (number; some old rows string), `stoppedSequence`, `sequenceDay`, `billableTemplate`, `externalMessageId`, `applicationId`. Indexes: `by_applicationId`, `by_candidate_time`, `by_channel_time`, `by_externalMessageId`.
- `appSettings` (key `system`): `autopilotEnabled`, `channel_toggles.{whatsappFollowUp,emailFollowUp}`, `brandName`.
- `pipelineEvents` (`flagged_for_ta_review`, `ai_followup_replied_to_ta`, `ai_followup_no_reply_to_ta`, `ai_followup_no_contact_to_ta`, `stage_change_<stage>`), `candidateInquiries` via `communications/inquiries.ts`, cron cursors via `lib/cronCursor.ts`.
- Not used by the live flow: `followUpSequences` (the real state lives on the application).

Status values to know: attempt count 1 means Day 0 done; `followUpState.lastContactDay` 0/4/6 is only a label in the TA flow.

## Backend wiring

Convex functions (all under `convex/ta/` are internal, called with the admin key from `src/lib/convexServer.ts`; do not make them public):
- `ta/followUp:send|stop|setAuto` (mutations), `ta/followUp:gateStatus` (query), `ta/outreach:followUpState|messagesFor` (queries; `optionalActor`, so no job-access check on reads: `convex/ta/guard.ts`), `ta/applications:shortlist|moveStage`, `ta/stages.ts` (pure), `ta/openings` (create with auto).
- `pipeline/followUpHelper.ts`: `initiateFollowUpOutreach`, `stopFollowUpSequenceForApp`, `updateFollowUpFlags`, `checkAndAdvanceFollowUp`, `assignedTa`, `assignedTaEmail` (plain functions on ctx).
- `crons.ts`: `evaluateFollowUpStage` (sweep), `sweepMove`.
- `communications/`: `whatchimp.handleWhatChimpWebhook` (http), `whatsappOutbound` (`sendWhatsApp`, `checkAndRecordFollowUpReply`, `findCandidateByPhone`, `candidatesWithPhone`, `hasRecentInboundComm`, `recordLocalWhatsappOutbound`, `updateStatus`), `metaTemplateSender` (`sendMetaTemplate`, `logTemplateCommunication`, `countBillableTemplatesToday`, `retryTemplateTomorrow`), `metaDirectSender.sendMetaFreeText`, `emailAgent` (`pollEmailInbox`, `checkAndRecordEmailReply`, `sendFollowUpEmail`, `createOutboundEmailRecord`), `graphEmail` (`sendGraphEmail`, `replyToMessage`), `inboundExtraction` (`extractDetailsFromText`), `followUpMutations` (`scheduleDynamicFollowUp`, `clearPendingFollowUp`, `flagForTaReview`, `clearTaReviewFlag`, `updateCandidateEta`, `transitionAiFollowUpToTaFollowUp`, `resetFollowUpApp`), `contactGuard.contactRefusal`, `emailHtml`.
- `lib/`: `followUpScope.ts`, `followUpWindow.ts`, `answered.ts`, `templateBudget.ts`, `outreachSafety.ts`, `outboundGuard.ts`, `doNotContact.ts`, `graphMail.ts`, `cronCursor.ts`.
- HTTP routes (`convex/http.ts`): `/whatsapp`, `/api/whatsapp`, `/whatsapp-whatchimp`, `/api/whatsapp-whatchimp` (GET verification via `handleMetaVerification`, POST webhook), `/api/graph-webhook`.
- Next side: server actions in `src/app/actions.ts` (`sendFollowUpNow`, `stopFollowUpNow`, `setOpeningAutoFollowUp`, `setOpeningQuestions`, `addOpeningQuestion`, `saveReviewDetails`), `src/data/convex/backend.ts` (`setAutoFollowUp`), API route `src/app/api/conversation/[appId]/route.ts`. No `/api/mobile` write route for follow-up send (mobile only reads alerts/openings).

Env names (never values): `OUTREACH_LIVE`, `OUTREACH_TEST_EMAIL`, `OUTREACH_TEST_PHONE`, `OUTREACH_DEFAULT_COUNTRY_CODE`, `C141_OUTBOUND_LOCK`, `C141_OUTBOUND_ALLOW_PHONES`, `C141_OUTBOUND_ALLOW_EMAILS`, `C141_WHATSAPP_TEMPLATE_DAILY_CAP`, `C141_DISABLE_CRONS`, `C141_TA_FOLLOW_UP`, `META_ACCESS_TOKEN`, `META_PHONE_NUMBER_ID`, `META_APP_SECRET`, `WHATCHIMP_PHONE_NUMBER_ID`, `MS_SENDER_EMAIL`, `OUTBOUND_EMAIL_SENDER`, `MS_GRAPH_CLIENT_STATE`, `LINKEDIN_SHARED_INBOX`. Kill switches in data: `appSettings.autopilotEnabled`, `channel_toggles`, per-opening switch, `candidates.doNotContact`.

Providers: Meta WhatsApp Cloud API direct (WhatChimp is only a legacy webhook name), Microsoft Graph (mail), OpenRouter via `getOpenAI("email_auto_reply")`.

## Access and roles

- UI seats (`src/lib/auth.ts`): `opening.act` (send, stop, call, review details; non-desk-wide users need an assignment; a TA who is not the owner is refused with "Another recruiter has claimed this candidate."; leads/directors/admin/ops may act), `opening.manage` (switch, questions; desk-wide or primary/supporting recruiter), `user.manage` (standard questions).
- Backend guards in `ta/followUp.ts`: `assertJobAccess(..., WORKS_THE_DESK)` (`primary_recruiter`, `supporting_recruiter`, `director`; admin and `ta_manager` pass; a TA in `job.assignedTaIds` or the `taLeadId` counts), `assertNotAnotherTasCandidate`. `setAuto` allows the same three roles; the UI is narrower (`opening.manage`).
- `ta/followUp:send` has no workday gate; `shortlist` and `moveStage` call `assertWorkdayScope` (/workday).
- Collision lock holds for reinstating a closed candidate too (review of PR #2, 21 Sep).
- Webhooks are unauthenticated users: protected by Meta signature (`META_APP_SECRET`) and Graph `clientState`.

## Invariants and safety

1. Every outbound goes through `lib/outreachSafety.ts` (`resolveRecipient`; fail closed unless `OUTREACH_LIVE=true`; env only, never the DB, 15 Sep eec5052/376c8a2) and then `lib/outboundGuard.ts` (`phoneAllowed`/`emailAllowed`). Senders: `sendMetaFreeText`, `sendMetaTemplate`, `lib/graphMail.ts`. Never set `OUTREACH_LIVE` in code/config; never add a second test mode.
2. Do-not-contact is checked at every sender and early in `initiateFollowUpOutreach`, the sweep and `extractDetailsFromText` (`communications/contactGuard.ts`, 2 Oct, 3e7f73c).
3. Stopped messages are not counted: with no deliverable channel a round is recorded, not counted, not rescheduled (`deliverable` in the helper, 21 Sep, cbd5c06). Do not re-add counting there.
4. Off means off: `autoFollowUpPatch(false)` clears the channel flags, and shortlist/moveStage pass `skipAutoOutreach` when `!followUpOn(job)` (18 Sep, e61e421). Do not read channel flags with a default of true without the `agent3Enabled` check.
5. Anti-duplicate: the sweep clears `nextFollowUpScheduledAt` before sending; a manual double press within 60 s sends nothing (`justSent`); inbound WhatsApp deduped for 30 s; inbound email once per `externalMessageId`; the text stored as `nextFollowUpMessage` is a "still missing" reminder, never the reply just sent (it used to be resent word for word, 2 Oct).
6. Chase only in Follow-up (`isFollowUpStage`) on both channels; a candidate at interview/offer who writes is recorded and a TA answers (2 Oct).
7. A message that answers a candidate is exempt from the stage guard (`isReplyToCandidate`), otherwise the "profile complete" confirmation is cancelled by its own advance (18 Sep 7ca148c email, 23 Sep WhatsApp).
8. Reply attribution: pass `applicationId` into `extractDetailsFromText`; reply on the channel it arrived on; history scoped to one application (23 Sep, f48edc4, 7a084b8). No fallback to another job or application in templates (2 Oct).
9. A question is answered when the candidate answered it, a figure or words (`lib/answered.ts`, 23 Sep, 732f323). "Complete" in the sweep, UI chip and state machine all derive from `directorReviewBlockers` (2 Oct).
10. A CV means a file (`cvUploadId`/`cvFileId`), never `isParsed` (23 Sep, 2cde268).
11. WhatsApp nudges are scheduled <= 23 h out (`MAX_WHATSAPP_NUDGE_HOURS`) so they stay in the free window (23 Sep, 7a084b8); Meta's 131047 overrides our window guess (25 Sep, 83c3d66).
12. The sweep's stage moves go through `executeStageTransition` with `skipAutoOutreach` (2 Oct, fdab754); the cursor window prevents starvation.
13. Template spend: all billable templates pass `sendMetaTemplate`, which owns the daily cap and the retry-tomorrow reschedule (2 Oct, ff9ef71). Cap day is a UTC day, not a Colombo day.
14. Webhook auth fails closed (no `META_APP_SECRET` -> 503) (23 Sep, 36d139d).
15. The reminder template wording replaces the text when the window is closed; keep reminders short because the real text may never arrive.
16. Migrations that fix data (e.g. `ta/fixes2609:resetBlockedFollowUpCounts`) are `dryRun`-default internal functions run by the pipeline.

## Known quirks, gaps and unverified items

- The sweep's reminder path increments `followUpAttemptCount` even when nothing was deliverable; only `initiateFollowUpOutreach` has the `deliverable` guard (cbd5c06 did not touch the sweep). With outreach off and no test recipient, sweep reminders burn attempts. `ta/fixes2609:resetBlockedFollowUpCounts` repairs it after the fact.
- `channel_toggles` and `autopilotEnabled` are read only by the sweep; manual Send and `initiateFollowUpOutreach` ignore them.
- `awaitingFirstSend` (`lib/followUpScope.ts`) is exported and tested but not used by the sweep. In the sweep TA-opening candidates with no schedule and attempts 0 are simply never sent anything: the dynamic branch needs `nextFollowUpScheduledAt` and the legacy day-0 branch is skipped for `followUpStartsOnSend`. The comment at the top of the loop ("the sweep sends it rather than leaving the candidate waiting") is true only for CV-pipeline jobs.
- Email-first delay: after email-only Day 0 the count is 1, so when the sweep fires the delayed WhatsApp it takes the reminder path (`sendWhatsApp`, which falls back to `career141_followup_reminder` because the window is closed), not `career141_initial_outreach`. The comment in the helper says the sweep sends "the first template". Also an email reply does not open WhatsApp's window in `hasRecentInboundComm` (only inbound WhatsApp rows count) (verify intent).
- `checkAndAdvanceFollowUp` requires the current-salary flag; the sweep/state machine do not. It patches the stage directly (no event, no stop-sequence). Whichever fires first wins.
- `checkAndRecordFollowUpReply` sets `lastCandidateReplyAt`; `checkAndRecordEmailReply` does not, so the AI Follow-up "no reply within 1 day" rule and the dialog's "they replied" only see WhatsApp replies (an email reply still moves an AI Follow-up candidate to TA Follow-up via the extraction).
- `extractDetailsFromText` computes `remainingMissing` for the reply using `currentSalary === undefined` / `expectedSalary === undefined`, ignoring the `*Note` fields, so the "still missing" reminder text can list a salary the candidate declined, while the flags and sweep treat it as answered (verify).
- Reply keyword fuzzy-match for custom answers is substring-based; two similar questions can cross-match.
- Reply routing for emails sent from the TA's own mailbox relies on `replyTo` including job@ (polled every 3 min) or a Graph subscription; a reply to a TA mailbox that is neither is not read (unverified).
- `maxFollowUpAttempts`, `maxFollowUpDays`, templates and `whatsappAfterEmailDays` have no TA-facing editor. `ta/dispatch.ts:sendFollowUp` (draft sending) has no caller in `src` (unverified for other callers).
- Stale comments: crons.ts "handled once for both flows, above (1c)" (the reply-pause was reversed); `setOpeningAutoFollowUp` toast says reminders start after "the first message you send", but with the switch on Day 0 goes at shortlist.
- Echo guard is a text match on two phrases; changing reminder wording may defeat it.
- Duplicate candidate records still swallow replies in rare cases (see the warning log "candidate records share the number"); merge the duplicates.
- `isWithinCallingHours`, AI-call retry and Day 2 tier are dead code while voice outbound is suspended.
- Calendar rule: the live flow runs on elapsed hours/UTC day, not Colombo days or 07:00-21:00 (that exists only in `src/lib/followup.ts`).

## How to change it safely

Where to edit:
- Message wording: Day 0 email -> `initialReachOutEmail` (`communications/emailHtml.ts`); reminder default text -> `followUpHelper.ts` (nudge block) and the sweep (`crons.ts`, missing list + default text) - two copies; AI reply style -> prompt in `inboundExtraction.ts`; WhatsApp templates are approved at Meta, only their parameters are in `metaTemplateSender.ts`.
- Intervals/limits: 24 h `NUDGE_RESCHEDULE_MS` in both the helper and the sweep; 15 min/60 s in `lib/followUpScope.ts`; 23 h in `lib/followUpWindow.ts`; 72 h in `inboundExtraction.ts`; 60 rows in `crons.ts`; attempts default 3 appears in `ta/followUp.ts`, `crons.ts`, `ta/outreach.ts`, `admin/followUpBacklog.ts`.
- New required detail: update `directorReviewBlockers` (`ta/stages.ts`), `pipelineStateMachine` check (uses `expectedSalaryOnFile`/`noticePeriodOnFile`), `followUpHelper` missing lists (3 places), `updateFollowUpFlags`, `metaTemplateSender` missing list, the AI prompt, `ta/workdays.ts` details check, `ta/outreach.followUpState.collected`, `FollowUpDialog`/`LiveFollowUp` checklists, `src/lib/pipeline.ts` `directorReviewBlockers` (UI chip), docs.
- New field on the opening/application: schema (`convex/schema.ts`) -> mapping in `convex/ta/model/tables.ts` and `convex/ta/model/projections.ts` -> `src/data/convex/map.ts` -> `src/data/types.ts` -> seed/store -> UI.
- New channel gate: add it to `outreachSafety`/`outboundGuard`, never only to a caller.
- Stage rule: change `ta/stages.ts` and `ALLOWED_TRANSITIONS`/gates in `pipelineStateMachine.ts` together; keep `src/lib/pipeline.ts` transitions in step.

Tests (run all with `npm test`; one with `node tests/run.mjs <substring>`): `tests/followupscope.test.ts` (switch, rounds, double press), `tests/followupsweep.test.ts` (cursor window, completeness, needsReviewDetails), `tests/followupwindow.test.ts`, `tests/answered.test.ts`, `tests/templatebudget.test.ts`, `tests/windowfallback.test.ts`, `tests/replyrouting.test.ts`, `tests/stagenames.test.ts`, `tests/followup.test.ts` (local engine only), `convex/communications/__tests__/dynamicEmailFollowUp.test.ts` (ETA ceiling logic, mirrors constants, not the function). There is no test for `sendFollowUp`/the sweep body or `checkAndRecordFollowUpReply`; extend pure helpers in `convex/lib/` first and test them there. Types: `npx tsc --noEmit -p .` and `npx tsc --noEmit -p convex`.

Pre-merge checklist: tests + both type-checks pass; no new sender bypasses `resolveRecipient` and `outboundGuard`; do-not-contact still asked; any new schedule write clears or sets `nextFollowUpScheduledAt` deliberately; stage moves use `executeStageTransition`; both reply channels covered; change reflected in this skill and in `docs/` if user-facing; wording or timing changes flagged for the owner (they change what users see and what is sent to candidates).

Repo hard rules that apply: never run `convex deploy|run|import|env set` against api.career141.com or the VPS from a laptop (live changes only through `.github/workflows/deploy-production.yml`); work on a branch, merge by PR; no secrets in code or docs; data fixes are `dryRun` internal functions run by the pipeline; run locally with `deploy/local/start-app.sh` only, never pointed at a live address; anything touching the live server needs the owner's explicit go-ahead.

## History

- 2026-09-15 `bc022f5` send the proven sequence from the candidate's Chat tab; `eec5052` one fail-closed gate in front of every message; `376c8a2` nothing reaches a real person from a test deployment.
- 2026-09-16 `7b1fbbc` automatic reminders for TA openings (`setAuto`, sweep per job, `C141_TA_FOLLOW_UP`); `4d63446` call/WhatsApp/Email buttons + Aura; `9df2be6` follow-ups sent from the assigned TA's mailbox via Graph.
- 2026-09-18 `ad60c7d` a reply pauses the chase, then `cf5b78d` the same day reversed it: shortlisting starts outreach, the AI answers replies, sweep carries on; `daa49cd` Meta template language `en` first; `7ca148c` the assistant's answer is not cancelled by the advance it causes (email); `9d7b458` WhatsApp/Email open the conversation first; `e61e421` "off means off" (`autoFollowUpPatch(false)` clears channels, `skipAutoOutreach`) and a refused thread reply is shown.
- 2026-09-21 `cbd5c06` stopped messages not counted, dialog explains test mode, local Sri Lankan numbers normalised, `resetBlockedFollowUpCounts`; `f2f19ce` Ask a question from the Follow-up page; `76d2080` Send to Director Review from Follow-up.
- 2026-09-22 `6e4e2af` AI Follow-up (`ta_shortlist`) split from TA Follow-up (`follow_up`).
- 2026-09-23 `7a084b8` AI history scoped to the opening, "already known" facts, nudges inside the 24 h window; `f48edc4` email replies answered on email and filed on the right opening; `f6bcaba` a duplicate candidate record no longer swallows a reply; `732f323` a decline counts as an answer, replies sound human; `2cde268` no CV credit for `isParsed`, WhatsApp "complete" message no longer cancelled; `36d139d` WhatsApp webhook requires Meta signature.
- 2026-09-24 TA shortlist goes to TA Follow-up again (owner reversal of a two-day AI Follow-up routing); automatic switch shown on both follow-up pages (review of PRs #30-32, `9f9d864`).
- 2026-09-25 `83c3d66` Meta's 131047 refusal falls back to the template.
- 2026-09-28 `ad6ff18` "Not disclosed" counts as an answer for salary and notice.
- 2026-09-30 `46be4d3` first email is the desk's approved reach-out sent as the TA (`assignedTa`).
- 2026-10-02 `3e7f73c` do-not-contact everywhere, AI chases only Follow-up, one inbound email = one reply, reply not stored as the next reminder; `fdab754` sweep cursor window, system moves through the state machine, Director Review's own completeness rule; `3076005` skipping Director Review needs its details; `ba3902f` Shortlist no longer pulls Director+ back, 60 s double press and 15 min same-round rules; `ff9ef71` daily billable-template cap and email-first delay; `fc5f763`/`e5d6225` collision lock on the backend, open backend closed.
- 2026-10-05 mobile/tablet UI pass touching `LiveFollowUp` and `FollowUpDialog` (`cd3cd8d`); no behaviour change to the sequence.

<!-- skill-meta
verified-commit: d078fcb
verified-hash: 1585e7bc587467b1cc2e69b8de387c4194153c5c
verified-date: 2026-10-27
sources:
  convex/ta/followUp.ts
  convex/ta/outreach.ts
  convex/ta/stages.ts
  convex/ta/applications.ts
  convex/ta/model/tables.ts
  convex/ta/model/projections.ts
  convex/pipeline/followUpHelper.ts
  convex/pipeline/pipelineStateMachine.ts
  convex/crons.ts
  convex/lib/followUpScope.ts
  convex/lib/followUpWindow.ts
  convex/lib/answered.ts
  convex/lib/templateBudget.ts
  convex/lib/outreachSafety.ts
  convex/lib/outboundGuard.ts
  convex/lib/graphMail.ts
  convex/lib/cronCursor.ts
  convex/communications/whatsappOutbound.ts
  convex/communications/metaTemplateSender.ts
  convex/communications/whatchimp.ts
  convex/communications/inboundExtraction.ts
  convex/communications/followUpMutations.ts
  convex/communications/emailHtml.ts
  convex/cvs/cvScoringActions.ts
  src/lib/followup.ts
  src/components/FollowUpActions.tsx
  src/components/FollowUpDialog.tsx
  src/components/LiveFollowUp.tsx
  src/components/SendToDirectorReview.tsx
  src/app/api/conversation/[appId]/route.ts
  src/app/openings/[id]/pipeline/[stage]/page.tsx
  tests/followup*.test.ts
  tests/answered.test.ts
  tests/templatebudget.test.ts
  tests/windowfallback.test.ts
  tests/replyrouting.test.ts
-->
