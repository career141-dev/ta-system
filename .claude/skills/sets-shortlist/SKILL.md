---
name: sets-shortlist
description: Career141 TA System shortlist claim (Shortlist button, owner lock, backups, add-ons), SETS (five CVs in a Colombo day closes a set), Director Review gate and the Director/client reply reading that moves people to Director/Client Shortlist (shortlists@, Shortlist decisions page, AI reader). Aliases - shortlist, claim, set numbers, second shortlist, director shortlist, client shortlist, review round, reply reader. Use when changing, debugging or extending any of these.
---

# Sets, shortlist claim and Director/client decisions

## Scope and boundaries

In this skill: the claim (who owns a candidate and which set they join), backup and add-on tagging at claim time, the set rule, the Director Review gate, how a send creates `reviewRounds`, and every path that reads a Director's or client's decision and moves people to Director Shortlist, Client Shortlist or Rejected.

Not here (link only):
- /eod-email: composing/sending the end-of-day email, effort table, resend "REVISED", midday. Only how sets and rounds are born at send is below.
- /follow-up: what happens after the claim (outreach sequence, 7-minute sweep, WhatsApp/email). The sweep's auto-advance into Director Review is mentioned because it feeds this gate.
- /scoop: Scoops uploads (a Scoop is a CV a Director/Lead/Ops mailed to the TA; "set" is a different thing).
- /email-intake: mail intake framework, mailboxes, the interviews@ side (invitation moves to Interview). Here only the shortlists@ handler.
- /workday: workday gate semantics (`assertWorkdayScope` is cited, not explained).
- /excel-tables: link rows, "Add to pipeline"/"Interested" (they call the claim).
- /openings, /strategy-planner, /voice-agent, /cv-extraction, /database-search: neighbours; "Add to opening" from database search reuses `reinstate`.
- Closed/placed handling beyond a pointer: Placed can only be undone by desk-wide roles (`pipelineStateMachine.ts`).

Terminology trap: **Sets** = numbered batches of a TA's shortlisted CVs (`convex/lib/sets.ts`). **Scoops** = CVs sent to the TA. Ask if the user is ambiguous.

## Adding a candidate to another job

Candidate rows offer “Add to another job”: `ta/applications:addToAssignedJob` verifies assignments and destination workday, keeps the source application, and claims or advances an early-stage destination to TA Follow-up. A colleague’s destination ownership is retained; later and closed stages are protected, and an existing TA Follow-up is unchanged. The destination stage history names the source job.

## How it works now

Stage vocabulary: backend `currentStage` (stored) vs TA names, translated only in `convex/ta/stages.ts` (`toTaStage`/`toBackendStage`).

| Backend | TA name | Note |
|---|---|---|
| new_cvs / matched_candidates | new_cv / matched | unclaimed pool |
| ta_shortlist (ai_call) | ai_follow_up | the AI's own pass-mark shortlist |
| follow_up | ta_follow_up | a TA's shortlist lands here |
| second_shortlist | director_review | "Director Review" |
| director_shortlist | director_shortlist | |
| client_review | client_shortlist | |
| interview / offer / placed | same | |
| rejected / unresponsive | rejected / dropped_out | closed, `isActive=false` |

### 1. Shortlist = claim

Triggers (all end in the same function):
- Row "Shortlist" button / candidate page "Save to pipeline": `src/app/actions.ts:claimCandidate` -> `backend.shortlist` -> `convex/ta/applications.ts:shortlist`.
- Bulk "Shortlist selected" (`CandidateList.tsx`, `claimable`): `actions.ts:confirmShortlist`, loops one `backend.shortlist` per id; per-id `can(opening.act)` pre-check, refused ones counted as "skipped - already taken by someone else", errors counted separately with last error text. Message: `N shortlisted and sent to Follow-up.`
- `moveStage` to `ta_follow_up` with nobody's name on them (`ta/applications.ts:moveStage` calls `claimForTa` in the same transaction; 2 Oct).
- `movePipelineCandidate` (`src/lib/openings/pipelineWrites.ts`) routes `ta_follow_up` from `ai_follow_up|new_cv|matched` to `ta/applications:shortlist`.
- Excel Tables "Add to pipeline"/"Interested" (`actions.ts:pipelineFromLink`, claims then moves to `director_review`), `reinstate()` ("Brought back"), HH CV upload (`ta/hhUpload.ts` calls `claimForTa`).

`shortlist` (public-to-app, `internalMutation`) order of checks: `requireActor` -> `assertJobAccess(WORKS_THE_DESK)` -> `assertWorkdayScope` ("Add this assigned position to your workday first." / "Start your workday before continuing recruitment work.", only for mapped roles ta/ta_support) -> refuses `rejected`/`dropped_out` ("This candidate is closed on this opening. Bring them back first, then shortlist.") -> `claimForTa`.

`claimForTa(ctx, user, app, reason = "Shortlisted by a TA")`:
1. `app.ownerTaId` is someone else -> returns `{ ok:false, ownerTaId }` (not a throw; UI says "<Name> already claimed this candidate." / "Already shortlisted by <Name>.").
2. Already mine -> `{ ok:true, alreadyMine:true, setNumber }`, nothing written (idempotent).
3. Else one patch: `ownerTaId`, `shortlistedAt=now`, `setNumber = nextSetNumber()`, plus `isAddOn:true, addedOnAt` if the TA's working stage on the job is `"Add-on"` (`workingStageOf`: active `jobAssignments.workingStage` else `taSettings` key `workingStageKey(jobId,userId)`, default "100%"), plus `backupForApplicationId` if `backupPrimaryOn` finds someone (below) and the row has none.
4. Only if current TA stage is in `PULLED_INTO_FOLLOW_UP` (`new_cv, matched, ai_follow_up, rejected, dropped_out`): `executeStageTransition(follow_up, bypassRoleCheck, skipAutoOutreach = !followUpOn(job))`. Someone already at Director Review/shortlist/interview/offer/placed is claimed where they are and never moved backwards (2 Oct).

Because owner + stage are written in one Convex transaction, a second claimer is serialised behind the first and sees the owner. Do not split the claim into check-then-write or into a second web call (21 Sep review, 2 Oct `38943a8`).

`moveStage` (`ta/applications.ts`): role set is `["director","primary_recruiter"]` for `director_shortlist`/`client_review`, else `WORKS_THE_DESK`; `assertWorkdayScope`; `follow_up` with an owner who is another TA and `isTaOnOwnDesk(user)` returns `{success:false, ownerTaId}`; otherwise `assertNotAnotherTasCandidate` throws "Another recruiter has claimed this candidate."; then `executeStageTransition`; then, for director_shortlist/client_review, `recordShortlistDecision(confirmed:true, note "Moved by <name>[: reason]")`.

Backup (`convex/lib/backup.ts`): `backupPrimary(apps, selfId)` returns the first other application at stage `offer`, else `interview` (`BACKED_UP_STAGES`). Used by `claimForTa` (live) and `store.shortlist` (local store, same function). Manual toggle: `actions.ts:toggleBackup` -> `repo.setBackup(appId,on)`; refuses with "Could not mark as a backup - nobody on this role is at interview or offer yet." when on and no primary. Add-on by hand: `toggleAddOn` -> `repo.setAddOn` (sets `isAddOn`, `addedOnAt`; toast says lead is notified - the notification itself is not in that function, unverified). EOD columns read these via `effortBucket` in `src/lib/eod.ts` (order: backUp, scoop, addOns, then source).

### 2. Sets

`convex/lib/sets.ts`: `SET_SIZE = 5`; `colomboDay(at)` = Colombo midnight (UTC+05:30, no DST); `hasFullDay(rows, before?)` = any Colombo day with >=5 rows (days `>= before` skipped); `nextSetFor(mine, now)`: no numbered rows -> 1; else `top` = max setNumber; if `hasFullDay(rowsInTop, colomboDay(now))` -> `top+1` else `top`; `setClosed(n, top, members)` = `n < top || hasFullDay(members)`.

Rule (desk, 28 Sep): a set stays open across days until the TA sends >=5 CVs in one Colombo day; that day closes it however many went (twelve = one set); the next day starts the next set from zero. Today's CVs never close the open set. Per TA per opening: `nextSetNumber` filters `ownerTaId === taId && setNumber != null` over `by_jobId`. Old numbers are never rewritten.

Two callers must stay identical: `ta/applications.ts:nextSetNumber` (live) and `src/data/store.ts:nextSetNumber` (local store), both calling `nextSetFor`.

Display: `store.ts:setsForOpening(openingId, taId?)` -> `{taId,setNumber,count,status}` used by dashboards, overview, openings list, mobile, `sla.ts` (open sets), reporting, desk assistant. EOD page (`src/app/openings/[id]/eod/page.tsx`) uses the TA's newest set (`nextSetNumber = latestSet?.setNumber ?? 1`) for the subject `subjectLine()` in `src/lib/eod.ts` = `SET n - CLIENT - POSITION - k CV(s)` (uppercase client and title), and the explanatory text ("complete on a day you send 5 or more"). SETS cell in the effort sheet: `setsCell(sets,total)` in `src/lib/eod-format.ts` -> `"2 Â· 14 CVs"`; typed trailing "N CVs" is stripped (1 Oct). `effortRow` sets `sets = max(setsForOpening(opening, ta))`.

At send, the round's set is `min(setNumber of the sent applications)`: live path `convex/lib/dailyEmail.ts:finalizeDailyEmail`; local path `actions.ts:sendEod` -> `repo.openReviewRound`.

### 3. Director Review (second_shortlist) gate

Source of truth: `convex/ta/stages.ts`.
- `directorReviewBlockers(app, candidate)` -> subset of `["a CV","expected salary","notice period"]`; current salary NOT required. A per-application flag (`followUpCvReceived`, `followUpExpectedSalary`, `followUpNoticePeriod`) wins when `true`; when `undefined` it falls back to candidate fields (`cvUploadId||app.cvFileId`; `expectedSalary`, `taExpectedSalaryText`, `expectedSalaryNote`; `noticePeriodDays`, `noticePeriod`). Words count ("Not disclosed", "Negotiable"; 28 Sep). `expectedSalaryOnFile`/`noticePeriodOnFile` shared with the state machine.
- `needsReviewDetails(from,to,decidedByReviewer)`: true when `to === "second_shortlist"`; also true when going from `BEFORE_REVIEW` (new_cvs, matched_candidates, ta_shortlist, ai_call, follow_up) straight to `AFTER_REVIEW` (director_shortlist, client_review, interview, offer, placed) unless `decidedByReviewer` (2 Oct, `3076005`).
- Enforced in `pipeline/pipelineStateMachine.ts:executeStageTransition` step 4. Error text: `Cannot move to Director Review: still missing <list>. Finish the follow-up first.` or `Cannot skip Director Review: ...`.
- UI mirror (a proxy, never stricter): `src/lib/pipeline.ts:directorReviewBlockers(candidate, app)` shows "Needs ..." in `CandidateRow.tsx` and disables/annotates in `RowActions.tsx`; `ta/applications.ts:get` returns the backend answer as `directorReviewBlockers`. `tests/notdisclosed.test.ts` compares both.

Ways in: `SendToDirectorReview` button (moveStageInline stage `director_review`, shown in `LiveFollowUp.tsx`); row "Change stage"/bulk bar (`BULK_STAGES` in `src/lib/bulkStages.ts`); follow-up sweep auto-advance (`convex/crons.ts:evaluateFollowUpStage`, when `blockers.length===0` and custom questions answered, patches the three flags true then `sweepMove(second_shortlist)`); Excel Tables "Add to pipeline" (`pipelineFromLink`); and the EOD send itself: after the email is accepted `sendEod` moves anyone still in `ai_follow_up|ta_follow_up|follow_up` to `director_review` ("Sent to the Director in the end-of-day email"; failures are listed as "Still in Follow-up - move by hand: ..."). In the live Convex path `isEodCandidateEligible` (`src/lib/eodEligibility.ts`) requires them ALREADY at director_review/second_shortlist, owned by the sending TA when the sender is a TA, and on an Add-on day `isAddOn && lastStageChangedAt >= sessionStart`; `dailyEmails:begin` re-derives the eligible list server-side and refuses ("The candidate list changed. Reload...").

Details form: `src/components/ReviewDetailsForm.tsx` (candidate page, "Details for Director review") -> `actions.ts:saveReviewDetails` -> `src/lib/candidates/reviewWrites.ts:writeCandidateReview(action:"details")`: `decideOn(opening.act, ownerTaId)`, builds currency-prefixed salaries (`withCurrency`), notice via `noticePeriodToDays`, custom lines into `application.notes`, then `repo.saveReviewDetails` (candidate patch + notes in one store commit; one retry on conflict after re-priming). Success "Details saved." It writes candidate fields only, never the `followUp*` flags (so an explicit `false` flag is not cleared by it - unverified in practice).

Review groups: the EOD page lists people waiting on a reviewer via `repo.waitingOn(openingId, kind)`; the history is `reviewRounds` with `status === "returned"`, newest first, searchable by `sp.q`. People are grouped by round (day sent), not by stage time. `store.waitingOn` newest round first, skips people already decided (non-hold).

### 4. Review rounds, tokens, send

A round is born when an email is accepted:
- Live: `finalizeDailyEmail` inserts `reviewRounds { kind:"director", token:"C141-MAIL-<dailyEmails _id>", applicationIds, sentBy, sentAt, sentTo: snapshot.to[0], trackedAt, subject, researchLink, setNumber?, dispatch:"sent", status:"awaiting", decisions:[] }`. A correction (`parentId`) reuses the parent's round and appends `revisedAt`. Recipients never see the token; matching uses Microsoft thread headers.
- Local/client path: `repo.openReviewRound` (`makeReviewToken`, 6 chars from `[A-HJ-NP-Z2-9]` after `C141-`; `reviewToken()` in `lib/shortlistReply.ts` matches `C141-XXXXXX`). Client rounds are `dispatch:"held"` (only recorded, never emailed from here).
- `sendEod` for `kind==="director"` on Convex delegates to `sendDailyEmail`; dedup: anyone in an earlier non-`recoveryReopenedAt` round of that kind is dropped; `eodInFlight` blocks double submits in-process.
- Rounds are also created from Outlook threads: `mailIntake/aiReader.ts:createRoundFromThread` with token `C141-THREAD-<messageId last 40>` (idempotent by `by_token`).

### 5. Reading Director/client replies

Four entry points, one rule family. Decisions are `shortlisted | rejected | hold`.

A. TA paste box (EOD page "Their reply", `readEodReply`) and "A reply came into <inbox> - place it for me" (`readInboundReply`): both -> `actions.ts:readReplyFor(openingId, kind, body, roundId?)`:
1. `repo.replyRoster` = one round (newest open or the named one) in its ORIGINAL order, decided people included so numbers never shift (13 Sep review).
2. `extractReplyText`, then `src/lib/reviewReply.ts:parseReply` (deterministic `readReply` in `src/lib/replyReader.ts` first; if the whole roster is cleanly read and nothing refused, no model; else `gemini("parse")` fills gaps only and disagreement removes both reads).
3. If nothing decided: "Nobody has been moved - read this part yourself: ..." or "Nothing in that reply could be read as a decision...".
4. `withUnpickedRejected(parsed, ids)` is now a NO-OP returning `parsed.decisions` (since 19 Oct `460fee9`; "silence is not evidence of rejection"). The 25 Sep rule "everyone not picked is not selected" is gone. UI copy on the EOD page and the comments in `actions.ts`/`review-reply/route.ts` still describe the old behaviour.
5. `repo.applyReviewDecisions(roundId, decisions(confirmed:false), body)` (`src/data/store.ts`): merges into `round.decisions`; skips repeats; `hold` recorded only; moves only people still at an `awaiting` stage (director: director_review, ai_follow_up, ta_follow_up, new_cv, matched; client: director_shortlist) else `stale`; moves via `store.moveStage(... force:true, actorType: round.kind)`; round `status` = `returned` when non-hold decisions >= roster size else `partial`.
`readEodReply`/`readInboundReply` only need `opening.act` (a TA transcribing the reviewer's mail is allowed to decide). `matchReviewReply` (`src/lib/routing.ts`) for `readInboundReply`: sender must be a People director (exact address) or a client contact; In-Reply-To beats subject; subject must name the opening title (and client when named); client contact only answers its own client's rounds; several rounds -> same stripped subject, then date in subject (`dateInSubject`), else newest with a stated guess. Failure shows `Could not place that reply. <note>`.

B. `src/app/api/inbound/review-reply/route.ts` (POST webhook): off (404) unless `C141_INBOUND_REVIEW_SECRET` is set (>=16 chars) and sent in header `x-c141-secret` (sha256 + `timingSafeEqual`). Same `matchReviewReply` + `parseReply` + `applyReviewDecisions`. Returns 422 when no round matched. Nothing in the repo calls it (unverified who, if anyone, posts to it).

C. `actions.ts:syncEodReplies` (Graph poll of user, shortlist inbox and `MS_SENDER_EMAIL` via `src/lib/graphInbox.ts`, 25 messages) is exported but no page calls it (dead path).

D. Backend reader at shortlists@ (the live path). Crons only when `C141_MAIL_INTAKE=on` (`convex/crons.ts:addMailIntake`): `ta-mail-intake-sync` every 5 min (`mailIntake/sync:syncAll`), `ta-mail-intake-process` every 1 min (`mailIntake/process:processReady`); each mailbox is enabled in Settings -> Mailboxes (`backfillFrom` = moment reading started, so older mail is never read; 385 mails from 6-23 Oct were therefore missed until the catch-up). `process.ts:handleShortlistMessage`:
- auto-reply/bounce -> skipped.
- Copy of the TA's own EOD (CVs attached) -> `decisions:attachRoundTransport` teaches the round its Graph `conversationId/internetMessageId/messageId` (by token in subject else `roundForCopy`: same subject, from the sending TA, within 1 h, exactly one) and the original is skipped, never filed as a shortlist (22 Oct).
- No CV attached -> `decisions:processReply` (a reply).
- CVs attached: only a recorded Director address (`DIRECTOR_MAILBOXES` = joborders@career141.com, shamra@career141.com, plus active People with desk role director, their `email` and `routingEmail`) with a house subject counts; the house subject from anyone else is held for a lead; opening from `parseHouseSubject`/`matchHouseSubject` (client AND position must both agree, tie held) or `inferOpening` for a client (score >= 5 and lead by >= 3, else held); `shortlist.ts:moveShortlisted` moves forward only (`shouldMove`, `ORDER`), never pulls back, leaves rejected/dropped for a person, reports `missing` (process.ts then creates the application first), `decidedByReviewer:true` (skips the details gate), `skipAutoOutreach:true`, actor id string `"shortlist-mail"`, records decision `confirmed:false`.

`decisions.ts:processReply` (action) -> `planReply` (shared by live reader, `dryRun`, and the catch-up):
1. `context` query builds every non-returned round with roster and `senderAuthorized`: director rounds trust `DIRECTOR_MAILBOXES` + People directors; client rounds trust `job.clientContactEmail` or the same non-career141 domain as `round.sentTo`.
2. `assessReply`: round by `matchReplyRound` order conversation -> In-Reply-To -> token in subject -> subject (only `senderAuthorized` rounds, and subject match alone is never "clear"). `parseShortlistReply` (strict, from `src/lib/replyReader.ts`: negation, masked set numbers/dates, "others/remaining" and optional/hold words each add review reasons; unknown capitalised names with decisive verbs add "Could not uniquely match"). Anyone the reply would leave in place or take off a shortlist gives a review reason (`placement()`); an automatic read never undoes a move.
3. No round and the sender is a Director mailbox or any non-career141 address: `aiReader.findSetInThread` rebuilds the set from the TA's email with CVs in the same thread (shortlists@ then joborders@; Graph `$filter` by conversationId then exact subject; CV file names -> candidates via `matchCvFiles`: two shared name words, or one when the file has one; tie or no match -> left out; for a client, the email to that client's company domain and any open opening's people at director_review/director_shortlist/client_review/interview); `createRoundFromThread` unless dry run.
4. If not clear and sender authorized: `aiReader.readDirectorReply` (model task `"shortlist_reply"` via `getModelForTask`, temperature 0, JSON, 45 s). `directorReplyAi.readAiAnswer` requires every candidate decided once, nobody unknown, `confident:true`; mapping `shortlisted|optional -> shortlisted` ("Optional - reason" in evidence), `not_shortlisted -> rejected`, `no_decision -> hold`, task text kept as "TA task: ...".
5. `createReview` inserts `shortlistDecisionReviews` (idempotent per `sourceMessageId`). Automatic apply iff `clear && (historical ? args.applyClear===true : process.env.C141_SHORTLIST_AUTO_APPLY === "on")` -> `applyAutomatic` -> `apply(..., confirmed:false)`; status `auto_applied`. Otherwise `requireReview` (status `review_required`) and a `candidate_replied` notification "Shortlist reply needs review" to the round's `sentBy` and the job's `taLeadId` (none for historical).
6. `apply`: per decision, `placement(kind, stage, outcome, confirmed)`: `move` (stage in AWAITING: director rounds any pre-review stage incl. second_shortlist; client rounds only director_shortlist), `already`, `correct` (reviewer said no but person is already on that shortlist, only when a person confirmed), `left` (recorded, reported for a person). Moves use `executeStageTransition(bypassRoleCheck, skipAutoOutreach, decidedByReviewer)` to `director_shortlist`/`client_review`/`rejected`; the decision is always stored on the round whatever happens to the stage; `hold` is stored not moved; round `status` returned/partial; `replyBody` appended with `---` separators.

Shortlist decisions page (`/shortlist-decisions`, `src/app/shortlist-decisions/page.tsx`; menu item in `TopNav.tsx` for admin/director/ta_lead/ops): lists last 100 (`decisions:list`, cap 200) sorted review_required/pending first; per item "Use this set" (`rematch`, re-parses with the strict reader), "Confirm selected decisions" (`confirm`, `apply(confirmed:true, actor)`, can correct a wrong shortlist), "Keep for review", "Ignore email" (reason required). Server actions in `actions.ts` of that folder; backend `requireReviewer` uses `deskRole` (explicit `taRole` wins).

Catch-up (23-24 Oct, owner decision): `decisions:reconcileFromMailbox({dryRun (required), days (1-60, default 21), applyClear, clients})`, run by the pipeline only. Lists shortlists@ inbox (up to 20 pages of 200) from `now-days` to the mailbox's `backfillFrom`; first teaches rounds their threads from TA copies; then reads Director replies (no attachments, from `DIRECTOR_MAILBOXES`) oldest first within thread, two threads at a time (six overloaded the backend: "Too many concurrent requests"), `graph_429`/busy retried up to 5x with `attempt*3 s` backoff, stops starting replies after 4 minutes and reschedules itself (`ctx.scheduler.runAfter(0, ...)`, real run only); `clients:true` appends client threads. `reconcileRecent` (older, `dryRun` required) only queues reviews, never moves. `setCvs.ts` files CVs of TA sets onto openings when the person was never added (26 Oct). `audit:directorDecisionReport` is a read-only query for records the pre-22-Oct reader may have mis-moved.

### 6. Who decides, and moves between shortlist stages

Manual: `movePipelineCandidate` requires `can(user,"decide.director"|"decide.client")` for stage `director_shortlist`/`client_shortlist`. `decide.director`: admin, director, ta_lead, or an assignment role `director`; `decide.client`: admin, director, ta_lead, or assignment `client_contact`; a TA gets "Moving somebody to the director's shortlist says the director approved them. Record their reply instead." The `viaRecordedReview` flag in `AuthContext` allows it, but only `tests/auth.test.ts` passes it (no production caller; TAs reach the same effect through the paste box, which checks `opening.act` only). The state machine reserves these two targets for `["director","primary_recruiter"]` unless `bypassRoleCheck` (the TA layer bypasses and checks itself).

`ALLOWED_TRANSITIONS` (app, `src/lib/pipeline.ts`): director_review -> director_shortlist | ta_follow_up | rejected | dropped_out; director_shortlist -> client_shortlist | rejected | dropped_out; client_shortlist -> interview | offer | rejected | dropped_out. The backend DAG is advisory only (`bypassRoleCheck` logs a warning, still moves). Client "yes" moves director_shortlist -> client_review; the interview move is booking an interview (`scheduleInterview`, store requires `client_shortlist` or `interview`) or the interviews@ invitation (/email-intake).

Reinstating: stage `rejected`/`dropped_out` -> `ta_follow_up` ("Brought back"): `actions.ts:reinstate` (lock: refuses if owner is another TA and caller is not desk-wide: "<name> owns this candidate here. Ask them or the TA lead to bring them back."), calls `backend.moveStage(... "ta_follow_up","Brought back")`, which claims when ownerless (`moveStage` -> `claimForTa`) and the state machine clears `isActive`, `rejectedBy/At/Reason/FromStage`, `droppedOutReason`. `shortlist` itself refuses closed cards. Rejecting/dropping needs a reason (`movePipelineCandidate`: "Say why they were rejected." / "Say why they dropped out.").

## UI surface

| Place | Control | Calls |
|---|---|---|
| Candidate row (`CandidateRow.tsx`) | Shortlist (when `claimable`), "Shortlisted by X - You cannot contact" when locked | `claimCandidate` |
| Candidate page `[appId]/page.tsx` | "Save to pipeline"; Details for Director review (`ReviewDetailsForm`); decide buttons by `canDecideDirector/Client` | `claimCandidate`, `saveReviewDetailsInline`, `moveStageInline` |
| Candidate list bulk bar | "Shortlist selected", bulk stage control (`BulkStageControls`, `bulkStages()` filters by decide caps) | `confirmShortlist`, `moveSelectedCandidates` -> `movePipelineCandidates` |
| `RowActions.tsx` | Add-on / Backup toggles, Change stage menu | `toggleAddOnInline`, `toggleBackupInline`, `moveStageInline` |
| `LiveFollowUp.tsx` | `SendToDirectorReview` | `moveStageInline` stage `director_review` |
| `/openings/[id]/eod?kind=director|client` | reply paste box, "place it for me", set explainer, history | `readEodReply`, `readInboundReply` |
| `/shortlist-decisions` | review queue | rematch/confirm/ignore/keepForReview |
| Mobile API `api/mobile/v1/openings/[id]/pipeline/move` | same move policy | `movePipelineCandidates` |

Visibility: `src/lib/visibility.ts:visibleToSeat` (the filter every candidate list uses) lets a TA on a shared opening see the unclaimed pool plus their own; `deskScope` adds colleagues' shortlisted rows as `takenBy` for the desk assistant; `scopeApplications` (posts-based, also shows others' shortlisted rows as `takenBy`) is used only by `linkedin-job/page.tsx`. Leads, directors, admin, ops are never narrowed.

## Data

- `applications` (`convex/schema.ts`): `currentStage`, `ownerTaId`, `shortlistedAt`, `setNumber`, `isAddOn`, `addedOnAt`, `backupForApplicationId`, `lastStageChangedAt`, `stageHistory`, `isActive`, `followUp*` flags, `reviewNotes`, `rejectedBy/At/Reason/FromStage`, `droppedOutReason`. Indexes used here: `by_jobId`, `by_job_stage`, `by_candidateId`, `by_owner`, `by_workday_owner (jobId, ownerTaId, shortlistedAt)`.
- `reviewRounds`: `openingId, kind, token, messageId, conversationId, internetMessageId, setNumber, applicationIds[], sentBy, sentAt, sentTo, trackedAt, subject, dispatch (held|sent), status (awaiting|partial|returned), returnedAt, replyBody, researchLink, revisedAt[], recoveryReopenedAt, decisions[{applicationId, outcome, decidedAt?, note, confirmed}]`, `workLocationId/Name`, `submissionType`. Indexes `by_opening`, `by_token`, `by_opening_kind`. Mapped to the app by `identity("reviewRounds", [...])` in `convex/ta/model/tables.ts`; written from the web store through `convex/ta/commit.ts:apply` (optimistic compare of every changed field; a changed field refuses the whole commit).
- `shortlistDecisionReviews`: `sourceMessageId, graphMessageId, conversation/internetMessage/inReplyTo, receivedAt, fromAddress, subject, replyText (<=20,000), roundId, openingId, matchMethod (conversation|reply_header|token|subject|none), matchNote, senderAuthorized, decisions[{applicationId,outcome,evidence}], reviewReasons[], status (pending|auto_applied|review_required|confirmed|ignored), historical, createdAt, appliedAt, reviewedAt/By, reviewNote`. Indexes `by_source_message`, `by_status_received`.
- Others: `pipelineEvents` (every transition; store also writes `shortlisted`, `sent_for_review`), `mailIntakeMessages`/`mailIntakeMailboxes` (kind `"shortlist"`), `jobAssignments.workingStage`, `taSettings` (`shortlistInbox` setting default `DEFAULT_SHORTLIST_INBOX`), `dailyEmails.roundId`, `notifications` (`candidate_replied`).
- Evidence caps: decision `note`/`evidence` sliced to 240 (`recordShortlistDecision`, parsers); review note to 500.

## Backend wiring

- Public-to-app Convex functions are all `internal*` (the Next server calls with the admin key): `ta/applications:{shortlist,moveStage,get,listForOpening,listAll,excludeFromMatches}`, `mailIntake/decisions:{processReply,context,list,rematch,confirm,ignore,keepForReview,applyAutomatic,requireReview,createReview,attachRoundTransport,findRoundForCopy,existing,reconcileFromMailbox,reconcileRecent}`, `mailIntake/shortlist:{context,applicationsFor,moveShortlisted}`, `mailIntake/aiReader:{readDirectorReply,findSetInThread,createRoundFromThread,taCandidates,clientCandidates}`, `mailIntake/setCvs`, `mailIntake/audit:directorDecisionReport`, `admin/unshortlist:run` (migration, dryRun default, clears owner/shortlistedAt/setNumber only).
- Crons: `ta-mail-intake-sync` (5 min), `ta-mail-intake-process` (1 min), both only with `C141_MAIL_INTAKE=on` (and a mailbox enabled); `ta-evaluate-follow-up` (7 min, `taOnly:true`, needs `C141_TA_FOLLOW_UP=on`) feeds Director Review; sweep reads 60 apps per run from a saved cursor.
- Env/flags (names only): `C141_SHORTLIST_AUTO_APPLY` (on = clear live replies apply without a person), `C141_MAIL_INTAKE`, `C141_INBOUND_REVIEW_SECRET`, `C141_DISABLE_CRONS`, `C141_TA_FOLLOW_UP`, `MS_SENDER_EMAIL`; Graph credentials via `getGraphToken`; model routing via `getModelForTask("shortlist_reply")` in `convex/lib/llm.ts` (which model serves it is unverified here; project memory says only one OpenRouter model is served).
- Providers: Microsoft Graph (read-only for shortlists@; the TA's EOD is sent from the TA's own mailbox elsewhere), the system LLM, Gemini for `parseReply` in the app.
- Nothing in this feature sends to candidates: shortlist mail moves and reviews never send; claim triggers outreach only through the Follow-up path, guarded by `followUpOn(job)` and `convex/lib/outreachSafety.ts`.

## Access and roles

- `src/lib/auth.ts:can`: `opening.act` (assignment required unless desk-wide `admin|director|ta_lead|ops`; `client_contact` refused; collision lock for `isTa` = `ta`/`ta_support`: "Another recruiter has claimed this candidate."), `decide.director`, `decide.client`, `review.note`, `opening.read`. `viewer` can only read. Deactivated account refused.
- Three lock layers: (1) `can(opening.act, {ownerTaId})` in every server action via `authorize()` / `decideOn()` (data can be ~30 s old); (2) backend `assertNotAnotherTasCandidate(user, app)` in `convex/ta/guard.ts` (live row, same transaction; used by moveStage, followUp, dispatchRecord, outreach, voice, workdays) - note it uses `isTaOnOwnDesk` (explicit `taRole` ta/ta_support wins, else role recruiter/ta/test_ta); (3) read narrowing `visibleToSeat`/`scopeApplications`. Leads/directors can still act ("somebody has to unstick a desk").
- `assertJobAccess(WORKS_THE_DESK)`: admin and ta_manager bypass; else an active assignment as primary_recruiter/supporting_recruiter/director, or being in `job.assignedTaIds` or the job's `taLeadId`. Message "You are not assigned to this opening. Ask the TA lead to add you to its team."
- Workday gate: `assertWorkdayScope` on `shortlist` and `moveStage`.
- 22 Oct rule (`2644328`): two TAs MAY hold the same LinkedIn person as Excel Tables rows; only your own row (or a lead's) counts as "already in the table"; whoever SHORTLISTS first owns and works them; the second TA reads "<Name> shortlisted them first". The application-level lock above is unchanged.
- Shortlist decisions page/actions: admin, director, ta_lead, ops only (`REVIEWERS`; backend `requireReviewer`).
- Placed -> anything: desk-wide only (`executeStageTransition`).

## Invariants and safety

1. Claim and stage change in one transaction; claim returns `{ok:false, ownerTaId}` instead of throwing (2 Oct `38943a8`, `fc5f763`).
2. Shortlisting never moves anyone backwards or out of closed stages; only `PULLED_INTO_FOLLOW_UP` stages are pulled (2 Oct). Closed candidates must be brought back explicitly.
3. Auto outreach on claim obeys the opening's follow-up switch (`followUpOn`); all sending goes through `convex/lib/outreachSafety.ts` / `outboundGuard.ts`. Shortlist-mail moves use `skipAutoOutreach:true`. Never set `OUTREACH_LIVE` in code.
4. Set rule lives once in `convex/lib/sets.ts`; the live and local numbering must both call it (28 Sep, `e9601b3`: UTC midnight bug fixed, Colombo day only).
5. Director Review's details gate is one rule shared by the state machine, cron and UI; "Not disclosed"/"Negotiable" count (28 Sep `ad6ff18`); only the reviewer's own mail bypasses it (`decidedByReviewer`).
6. A reply answers ONE email: numbers refer to that round's original order (13 Sep audit). Never renumber against "everyone waiting".
7. Silence is never rejection; unreadable parts block automatic apply (22 Oct `75ac7c4`: old reader shortlisted on "2 not selected" and "Hi all").
8. An automatic read never takes someone off a shortlist or touches someone past the waiting stages; only a person's confirmation (`confirmed:true`) corrects (`placement` "correct"/"left", 22 Oct).
9. Replies are trusted only from `DIRECTOR_MAILBOXES`/People directors (director) or the recorded client contact/company domain (client), never a career141 address for a client; subject-only matches always need a person.
10. The TA's own EOD copy at shortlists@ (with CVs) is never filed as the Director's shortlist (22 Oct).
11. Idempotent writes: `shortlistDecisionReviews.by_source_message`, `createRoundFromThread` by token, `recordShortlistDecision` short-circuits on an identical prior outcome, `applyReviewDecisions` skips repeats, `claimForTa` on own candidate is a no-op.
12. `shortlistDecisionReviews` and `reviewRounds.decisions` record what the reviewer said even when the stage is left alone, so reports match reality (22 Oct).
13. Data repairs are migrations with `dryRun` required/defaulted, run by the release pipeline (`run_function`), e.g. `admin/unshortlist:run`, `reconcileFromMailbox`; never ad hoc against live.
14. Colombo days: `colomboDay`, `workdayDate` (`src/lib/workday.ts`) - never UTC midnight.
15. The Director's mailbox is not on People; do not make trust depend on People alone (22 Oct `b558d23`).

## Known quirks, gaps and unverified items

- Two code paths move people on a reply: the web store (`applyReviewDecisions` -> `store.moveStage(force:true)` -> `commit.apply`, no `executeStageTransition`, so stats/follow-up-stop/Meta events are skipped; per the comment "the store's write reaches the backend itself", mechanism not re-verified) and the backend reader (`executeStageTransition`). The web store path does not call `recordShortlistDecision` but writes `round.decisions` itself.
- `withUnpickedRejected` is a deliberate no-op but its name, three call sites, EOD page copy ("the rest of that email are marked not selected") and `actions.ts` comments are stale. `tests/reviewreply.test.ts` pins the no-op.
- `syncEodReplies` has no caller; `/api/inbound/review-reply` has no known caller.
- `viaRecordedReview` has no production caller.
- `setCvs.ts`, `findSetInThread` and the catch-up make many Graph calls; `findSetInThread` uses Graph `$filter` on exact subject (apostrophes doubled) - a subject edit by the sender defeats it.
- Local `repo.shortlist` and live `claimForTa` differ slightly: local requires `ownerTaId===taId && shortlistedAt` for idempotence and only claims from `new_cv|matched|ai_follow_up`; live pulls rejected/dropped too. Keep behaviour changes in both.
- `isTaOnOwnDesk` (backend) vs `isTa` (app) are not the same predicate.
- `directorReviewBlockers` in `src/lib/pipeline.ts` is a proxy; it can over-report, never under-report. A `followUp*` flag explicitly `false` is not flipped by saving details (unverified end to end).
- `toggleAddOn` toast promises lead notification; not seen in `setAddOn` (unverified).
- Whether `C141_SHORTLIST_AUTO_APPLY` is on in production, and which model serves `shortlist_reply`, are not checkable from the repo.
- Client sets sent outside the system have no round until a client reply triggers `findSetInThread`; client rounds from the app are `dispatch:"held"`.
- Set numbers are never recomputed after a TA's rows change owner (`admin/unshortlist` clears `setNumber` on that row only).

## How to change it safely

Where to edit:
- Set rule: `convex/lib/sets.ts` only, then `tests/sets.test.ts`; check both `ta/applications.ts:nextSetNumber` and `src/data/store.ts:nextSetNumber/setsForOpening`, `src/lib/eod.ts` subject, `eod-format.ts:setsCell`, the explainer text on the EOD page, `lib/sla.ts`, reports.
- Claim rule: `ta/applications.ts:claimForTa` AND `src/data/store.ts:shortlist`, plus `ta/hhUpload.ts` callers and `lib/openings/pipelineWrites.ts`. Add fields in `convex/schema.ts`, map them in `convex/ta/model/tables.ts` (`applications` row mapper at ~line 289), `src/data/types.ts`, `src/data/convex/map.ts`, seed data.
- Backup rule: `convex/lib/backup.ts` (both copies call it); EOD column in `effortBucket`.
- Director Review gate: `convex/ta/stages.ts` first; then `src/lib/pipeline.ts` proxy, `crons.ts` (calls the shared function), state machine message text; tests `followupsweep.test.ts`, `notdisclosed.test.ts`.
- Reply reading: deterministic rules in `src/lib/replyReader.ts` (shared by the app box and backend `lib/shortlistReply.ts`); trust/matching in `mailIntake/decisions.ts` (`context`, `assessReply`, `planReply`); placement rules in `lib/shortlistReply.ts:placement`/`AWAITING`; AI prompt and answer checks in `lib/directorReplyAi.ts` (pure); shortlists@ filing in `lib/shortlistMail.ts` + `mailIntake/shortlist.ts` + `process.ts`. A new decision outcome must be added to the schema validators (`reviewRounds.decisions`, `shortlistDecisionReviews.decisions`, `decisionValidator`), the page selects, `placement`, and the AI mapping.
- UI copy changes that alter what users see are for the owner to decide; flag them. Anything that changes what candidates receive must be flagged too.

Tests (`npm test` runs every `tests/*.test.ts` as its own process; `node tests/run.mjs <substring>` runs one): `sets`, `shortlistcopy`, `taseparation`, `auth`, `bulkStages`, `followupsweep`, `notdisclosed`, `candidate-review-writes`, `reviewreply`, `reply`, `replyrouting`, `routing`, `shortlistmail`, `shortlistreply`, `directorreplyai`, `eodEligibility`, `eodeffort`, `eodresend`, `dailyEmails`, `hhupload`, `stagenames`, `reviewnotes`. Extend `sets.test.ts` for set rules, `shortlistreply.test.ts`/`directorreplyai.test.ts` for reader rules, `shortlistmail.test.ts` for subject/trust rules.

Commands: `npm test`; `npx tsc --noEmit -p .`; `npx tsc --noEmit -p convex`.

Pre-merge checklist:
1. Both numbering/claim copies changed together; `tests/sets.test.ts` and `taseparation.test.ts` pass.
2. Any new mutation checks `assertJobAccess`, `assertWorkdayScope`, and `assertNotAnotherTasCandidate` (or documents why not).
3. Reply paths: dry-run output reviewed; no automatic undo of moves; subject-only match still needs a person.
4. No outbound send added; claim/reader never bypass `outreachSafety.ts`/`outboundGuard.ts`; no `OUTREACH_LIVE` in code.
5. Data repair = internal function with `dryRun`, run by the pipeline; never `convex run`/`deploy`/`import` from a laptop against api.career141.com or the VPS.
6. Branch `<person>/<topic>`, PR to main, no secrets, owner informed of any change to what users see or what candidates are sent. Anything touching live needs the owner's explicit go-ahead.

## History

- 14 Sep 2026 `7470f4f` Initial platform: collision lock, local store `shortlist`, `applyReviewDecisions` (13 Sep audit rules: merge decisions, skip repeats, no moves for people who moved on).
- 15 Sep `1f7473f` Convex TA function layer (`ta/applications.ts` shortlist/moveStage, owner in same transaction).
- 16 Sep `e341a1a`/`4bb6b75` `assertJobAccess` uses `first()` and honours `assignedTaIds` (duplicate assignment rows failed every claim; 21 Sep testing).
- 21 Sep `127cc2c` Review of PR #2: reinstate keeps the lock for closed rows; EOD move to Director Review reports failures.
- 22 Sep `6e4e2af`/`2773973` AI Follow-up is the AI's shortlist, TA Follow-up the TA's (a TA claim had gone to AI Follow-up 23-24 Sep by mistake; restored 24 Sep).
- 25 Sep `d1f0855` (PR #56) automated review-reply ingestion; owner rule that unpicked people become not selected; the 25 Sep set rule "five to a set, the sixth starts the next" (per the `sets.ts` comment; code since replaced).
- 28 Sep `e9601b3` set rule becomes "five or more in one Colombo day closes the set" (`convex/lib/sets.ts`); `8ce23da` backups tagged at claim (`backup.ts`), add-ons on Add-on days, EOD counts only CVs sent today; `ad6ff18` "Not disclosed" is an answer for the gate.
- 29 Sep `8698590` shortlists@ reader: Director subject `CLIENT > POSITION > SET 01`, client opening inferred, forward-only moves, nothing sent.
- 1 Oct `fc5f763` two TAs work apart: `visibleToSeat`, backend `assertNotAnotherTasCandidate`.
- 2 Oct `38943a8` move-and-claim in one transaction; `3076005` skipping Director Review needs the same details, Placed undone only by desk-wide roles.
- 5-9 Oct `825caa1`, `39618c9` Excel rows per TA; TA Support seat.
- 19 Oct `460fee9` reliable shortlist reply processing (backend reader, `/shortlist-decisions`, `withUnpickedRejected` becomes a no-op).
- 22 Oct `75ac7c4` negation-safe reader, own EOD copy skipped, moves record decisions (`recordShortlistDecision`), `placement()` corrections, audit report; `b558d23` trust `joborders@`/`shamra@`; `2644328` two TAs may hold the same LinkedIn person, first to shortlist works them.
- 23 Oct `0362628`/`7efccba` catch-up of missed Director replies (385 mails, 115 replies, none applied; owner chose: move clear ones, review the rest); `86d1414` AI reader and sets rebuilt from the thread; `ac8dd86` client replies move Director shortlist -> Client shortlist/Rejected.
- 24 Oct `16f977e`, `ba4ef75`, `b53590c`, `5103067` catch-up hardened (two threads at a time, retries, 4-minute stop and continue, clients in the queue).
- 26 Oct `2b9c52f` a person on the opening twice counts as on it (CVs not refiled); setCvs repair of set CVs not on the opening.

<!-- skill-meta
verified-commit: d078fcb
verified-hash: d3e8629aa771f13d9e66ec6bd04da3295b6ec889
verified-date: 2026-10-27
sources:
  tests/addToAssignedJob.test.ts
  convex/lib/sets.ts
  convex/lib/backup.ts
  convex/lib/shortlistDecision.ts
  convex/lib/shortlistMail.ts
  convex/lib/shortlistReply.ts
  convex/lib/directorReplyAi.ts
  convex/lib/dailyEmail.ts
  convex/ta/applications.ts
  convex/ta/guard.ts
  convex/ta/stages.ts
  convex/pipeline/pipelineStateMachine.ts
  convex/mailIntake/decisions.ts
  convex/mailIntake/shortlist.ts
  convex/mailIntake/aiReader.ts
  convex/mailIntake/setCvs.ts
  convex/mailIntake/audit.ts
  convex/mailIntake/process.ts
  convex/crons.ts
  convex/admin/unshortlist.ts
  src/lib/auth.ts
  src/lib/visibility.ts
  src/lib/routing.ts
  src/lib/reviewReply.ts
  src/lib/replyReader.ts
  src/lib/pipeline.ts
  src/lib/eod.ts
  src/lib/eodEligibility.ts
  src/lib/openings/pipelineWrites.ts
  src/lib/candidates/reviewWrites.ts
  src/data/store.ts
  src/app/actions.ts
  src/app/api/inbound/review-reply/route.ts
  src/app/shortlist-decisions/**
  src/components/SendToDirectorReview.tsx
  src/components/ReviewDetailsForm.tsx
  src/components/CandidateRow.tsx
  tests/sets.test.ts
  tests/shortlistreply.test.ts
  tests/shortlistmail.test.ts
  tests/directorreplyai.test.ts
-->
