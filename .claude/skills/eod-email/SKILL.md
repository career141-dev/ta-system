---
name: eod-email
description: End-of-Day (EOD) and Midday daily emails from a TA to the Director desk (joborders@) - composer, two tables, prepared-CV PDFs + Excel workbook, Graph send, 31-day retention, REVISED corrections, reconcile, work locations. Also typed as EOD, end of day, midday email, daily email, Director Review email, REVISED resend, activity-only. Use when changing, debugging or extending these emails.
---

# EOD and Midday emails

## Scope and boundaries

In this skill: everything between "TA presses Send on the opening's End of Day / Midday page" and "the email is accepted, finalized, kept 31 days, purged": composer UI, content builders, recipients, attachments, durable reservation (`dailyEmails`), Graph transport, reconcile, correction (REVISED), retention, work-location scoping, recoveries.

Lives elsewhere:
- /workday - the Today's Checks logic (`requiredChecks`, `emailBlockers`, `refreshWorkdayChecks`, exceptions, `autoCompleteWorkday` internals, the sidebar). This skill only calls it.
- /sets-shortlist - reading the Director's reply (`readEodReply`, `readInboundReply`, review rounds' decisions, set numbering in `convex/lib/sets.ts`). The reply panels render on the same page but are not this feature.
- /follow-up (candidate chasing, same `graphMail.ts` sender), /scoop (SCOOP column source), /excel-tables (L sheets, `linkVault`, workbook layout `buildLinkExportLayout`), /openings (work location setup), /cv-extraction (candidate fields shown in Table 1), /database-search, /email-intake, /strategy-planner, /voice-agent: neighbours only.

Naming: UI says "End of Day Submission" and "Midday email"; code says `eod` / `midday` (`SubmissionType`), `dailyEmails` (new, 16 Oct), `eodEmailCopies` (legacy, 8 Oct), `taWorkdayMail` (receipt per send).

## Adding a candidate to another job

The shared actions module includes `addCandidateToJob`; destination shortlisting follows the existing set and workday rules and does not alter EOD sending.

## How it works now

### Flow A - Original EOD (director kind)

1. Page `src/app/openings/[id]/eod/page.tsx` (`EodPage`) primes the store, `requireSourcingSeat(id)` (src/app/openings/[id]/sourcingGate.ts), loads `ta/workdays:eodContext` (server-authoritative `workType` + `sessionStart`; TA only), `ta/dailyEmails:list`, builds `shortlistRows(...)`, `effortRow(...)`, subject, referee calls, and renders `EodComposer`.
2. Candidate list = `shortlistRows` in `src/lib/eod.ts`: applications in the selected work location, not in a Director round (`reviewRounds` kind director without `recoveryReopenedAt`), passing `isEodCandidateEligible` (`src/lib/eodEligibility.ts`), and for a TA owned by them (`ownerTaId`), sorted by `setNumber`. Eligibility: stage `director_review` (app model) or `second_shortlist` (Convex spelling) only; on an **Add-on** day also `isAddOn` and `lastStageChangedAt >= sessionStart`. `sessionStart` = `workSessionStart(entry)` in `src/lib/workdayRequirements.ts` (last Add-on entry in `modeHistory`, else `addedAt`).
3. Press Send -> form `#eod-send` in EodComposer posts `sendDailyEmail` when `dailyDraft || dailyParentId || (useDailyEmail && kind==="director" && !resend)`, otherwise `resendEod` (legacy) / `sendEod`. `sendEod` itself forwards to `sendDailyEmail` when `isConvex()` and kind is director, so admins/leads also use the durable path. The legacy `sendEod`/`resendEod` bodies only run for the client copy ("Record that it went to the client") and non-Convex local mode.
4. `sendDailyEmail` (src/app/actions.ts): `authorize(formData, parentId ? "opening.read" : "opening.act")`, then:
   - lists the user's `dailyEmails`; resolves `parent` (own, accepted EOD with snapshot) for corrections;
   - `requireWorkLocation(opening, workLocationId)` (src/lib/workLocations.ts) - a correction forces the parent's location;
   - `baseRows` = `parent.snapshot.rows` or `shortlistRows(...)`; `rows = shortlistRowsFromForm(formData, baseRows)` (fields `shortlist_<appId>_<field>`); `effort = effortFromForm(formData, ...)` (`effort_*`, `target_*`, `effort_kind`, `effort_date`, `effort_assignee`); the server forces `effort.hundredOrFollowUp = submittedMode` (parent mode, else `context.workType`);
   - referee calls via `currentRefereeCalls` (EOD only; formData `includeRefereeCalls`=`no` drops them; `refereeCallResults` JSON <=20,000 chars moves rows between positive/negative);
   - `parseAddressList` on `extraTo`/`extraCc`; any bad address aborts ("Correct the invalid To or Cc email addresses."); `eodRecipients(...)` (see Recipients);
   - research link: midday and corrections use `checkResearchSubmission({role:"ta",...})` (link + confirm tick always required, even for admin); an original EOD uses `eodResearchSubmission` -> `ta/workdays:emailPreflight` (blockers) + `researchExceptionAllowed`;
   - subject: `revisedSubject(raw)` for a correction, else the typed subject;
   - calls `emailEod(...)`.
5. `emailEod` (same file): requires >=1 CV or `activityOnly` ("Include at least one CV or send an activity summary."); rows renumbered `no = i+1` in sent order (Director replies number against this order); builds each CV attachment (see Attachments); Excel workbook; `eodEmailHtml(...)`; builds `DailyEmailSnapshot`; calls `ta/dailyEmails:begin` (durable reservation); then action `ta/eodMail:send`.
6. `begin` (internalMutation) sets status `sending`, `startedAt`, stores `snapshot`, inserts/patches the `dailyEmails` row, inserts `taWorkdayMail` receipt (`status:"sending"`, links `receiptId`). Guards - see table below.
7. `ta/eodMail:send` (`"use node"` internalAction) -> `sendFollowUpMail` (convex/lib/graphMail.ts) with `attachmentMode:"draft"`, `testInbox:"EOD_TEST_EMAIL"`, `keepInternalInTest:"career141.com"`, `fallbackFrom` = `MS_SENDER_EMAIL` || `OUTBOUND_EMAIL_SENDER` || `job@career141.com`. Then calls `ta/dailyEmails:result` (and `ta/workdays:mailResult` for the receipt).
8. `result`: only acts if status is still `sending`. Sets `accepted` / `failed` / `uncertain`, merges `delivered` ({from,to,cc} actually used) into the snapshot, then for `accepted` runs `finalizeDailyEmail`, then `refreshWorkdayChecks`.
9. `finalizeDailyEmail` (convex/lib/dailyEmail.ts, idempotent via `finalizedAt`): original -> inserts `reviewRounds` row (`kind:"director"`, `token:"C141-MAIL-<emailId>"`, `dispatch:"sent"`, `status:"awaiting"`, `setNumber` = min of apps' `setNumber`, `sentTo` = first To, `researchLink`, `trackedAt`); correction -> pushes `at` onto the original round's `revisedAt` (no new round); patches email `finalizedAt`, `expiresAt = at + 31 days`, `roundId`; extends each saved attachment's `expiresAt` (never shortens); patches receipt `accepted/finalizedAt`; for an **original EOD** with a receipt calls `autoCompleteWorkday(ctx, workdayId)` (src: convex/ta/workdays.ts; closes the workday when every required location has an accepted original EOD).
10. Back in `sendDailyEmail`: `saveEodEdits(rows, baseRows, ids)` writes the TA's edited designation/company/salaries/notice/notes to the candidate via `eodDetailChanges` (see below), `afterBackendWrite`, then redirects to `/openings/<id>/eod?[location=][mail=][sent=<id>&]msg=...`. If the email was sent but a later step throws, the message is "Email sent and recorded. Reload to see its saved copy." and the TA is never invited to retry. `?sent=` makes the page render `EodDraftCleanup` to clear browser drafts - only if the server confirms that id is the user's accepted+finalized email.

`begin` guards (all throw; messages shown to the TA via `backendMessage`):

| Guard | Message / effect |
|---|---|
| role not ta/ta_support/ta_lead/director/admin/ops (viewer allowed for reads only) | "You cannot access recruitment emails." |
| TA/support not assigned (`assertJobAccess` primary/supporting recruiter) | assert error |
| Correction: not own accepted retained EOD (`expiresAt` future, snapshot present) | "Only your retained EOD emails can be corrected." |
| Correction without `previewConfirmed` | "Review and confirm the revised email preview before sending." |
| Correction with different location | "A correction must keep its original work location." |
| Worker with no active workday containing the job (`workday()`; day matches `closureReason==="eod"` or unfinished) | "Start today's workday and add this opening before sending." |
| Location added after the workday began (`workEntry.workLocationIds` set and missing it) | "This location was added after today's work started. Its daily emails begin tomorrow." (entries with no `workLocationIds` adopt `activeWorkLocationIds(job)` on first send) |
| Any of this TA's own `dailyEmails` on the job + location (other TAs' do not block, 28 Oct) in `sending`, `uncertain` or `accepted && !finalizedAt` (any date) | "Your earlier email on this opening is still sending or needs reconciliation. Ask your TA Lead..." |
| `dailySendProblem(emails, type, requireMidday, revised)` | sending/uncertain; original EOD already accepted today; EOD without midday when required |
| `snapshot.workbookLinkIds` row missing / other opening / other location | "A workbook row changed location. Reload and review the email before sending." |
| Day finished (`finishedAt`) and entry `100%` without accepted original EOD | "The workday clock has stopped. Change this unfinished position to Follow-up or Add-on before sending." |
| `snapshot.workType` != server mode | "The work type changed. Reload and review the email before sending." |
| Saved CV attachment not owned by user/job/application or not in `applicationIds` | "The saved CV attachment does not belong to this email." |
| Midday: link invalid or not `confirmed` | link reason / "Confirm your ChatGPT link before sending." |
| EOD: `checkResearchSubmission` with `excused` from the `chatgpt:` check's exception | reason |
| `snapshot.rows` ids != `applicationIds` (set compare) | "The email preview does not match its candidate list. Reload before sending." |
| empty subject / no To | "Add a subject and a recipient." |
| Correction roster != parent roster or different order | "A correction must keep the original candidates and their order." |
| Original: roster != recomputed eligible list (excludes apps already in a director round, in any accepted `dailyEmails`, wrong location; EOD uses `isEodCandidateEligible`; midday uses `currentStage === "second_shortlist"` + ownership for workers) | "The candidate list changed. Reload, review the updated list and send again." |
| Original EOD: `setup.eodChecks` not complete/excused, excluding keys `director_cv`, `chatgpt`, `midday_email` | "Complete Today's Checks: <labels>" |
| `taWorkdayMail` receipts for the day in sending/uncertain/accepted-unfinalized (same or unknown location) | "An earlier email needs reconciliation before sending." |
| Legacy original EOD receipt already accepted for the location | "The end-of-day email has already been sent today for this location." |
| `draftId` on an EOD | "Only a midday email can use this draft." |
| Midday draft not this user's/job/day/location, not draft/failed, or `revision` mismatch | "This midday draft changed. Reload it before sending." |

Order of work in `emailEod` matters: CV PDFs and the workbook are built **before** `begin`, so a preparation failure never reserves anything.

### Flow B - Midday email

- Trigger: Midday page `src/app/openings/[id]/midday/page.tsx` is a 8-line wrapper that calls `EodPage` with `mode:"midday"`. "Add midday email" button -> `addMiddayEmail` -> `ta/dailyEmails:createDraft` (needs workday + job on it, `dailySendProblem(emails,"midday",false)`, number = max midday number today in that location + 1, `revision:0`, `status:"draft"`, `expiresAt` +31 days) -> redirect to `/midday?mail=<id>&location=<id>`.
- Drafts autosave: composer debounces 750 ms on input/change/click, posts `saveMiddayDraft` -> `ta/dailyEmails:saveDraft` (`revision` optimistic lock, 250,000-char JSON cap, only own draft/failed rows, only today's date). Fields whitelisted by regex `subject|introText|outroText|chatgptLink|extraTo|extraCc|removed|skipAttachments|shortlist_*|effort_*|target_*`, plus `baseSubject`, `base_effort_*`, `base_shortlist_<appId>_<key>` (so a later profile change wins over an older edit - `candidateDraftBases` in src/lib/eodDraft.ts).
- Send: same `sendDailyEmail` path with `submissionType=midday`, `dailyDraftId`, `dailyDraftRevision`. Midday needs a confirmed ChatGPT share link but no completed tasks, no Today's Checks blockers, and may tick "Send without CV attachments" (`skipAttachments=yes`; honoured only when `type==="midday"`). Midday never gets the Excel workbook and tolerates per-CV preparation failures (`preparationFailures` ignored when `isMidday`).
- Midday roster: remaining unsent Director Review (`second_shortlist`) candidates; sending them removes them from the later EOD (accepted emails' `applicationIds` count as sent). An empty midday is an activity summary. Midday emails never create a Director reply round beyond the `reviewRounds` row `finalizeDailyEmail` inserts when `applicationIds.length > 0` (`submissionType:"midday"` on the round).
- Requirement policy: `middayRequired(ctx,date)` (convex/lib/dailyEmail.ts) = a `dailyEmailPolicy` row `key:"midday"` exists and `date >= requiredFrom`. Only workers (`ta`,`ta_support`) are held to it. Activated by pipeline `ta/dailyEmails:enableRequirement` (`{"dryRun":true}` first; sets `requiredFrom` = next Colombo day; re-running keeps the saved date). Before activation midday is available, not compulsory. docs/MIDDAY-EMAILS.md has the release steps.
- Sent midday emails are read-only (`saveDraft` refuses non-draft/failed).

### Flow C - Correction ("Edit and resend" / REVISED)

- Entry: `DailyEmailView` link `/openings/<id>/eod?mail=<emailId>&revise=yes`, or legacy `?resend=<copyId>` (an `eodEmailCopies` row adopted into `dailyEmails`; see Retention). Page computes `correction` = selected accepted EOD, own, with snapshot.
- Composer shows the original's rows (`correction.snapshot.rows`), effort, recipients (`snapshot.to[0]`, `snapshot.cc`), subject `revisedSubject(snapshot.subject)`, a mandatory "I reviewed this ..." tick (`previewConfirmed`, required; button disabled until ticked) and "regenerateAttachments" tick.
- `sendDailyEmail` with `dailyParentId`: roster = `parent.applicationIds` (order kept); To = parent's first To + added extras minus `removed`; Cc = parent Cc + extras minus removed; saved PDFs are re-fetched through `ta/dailyEmails:attachment` and `internalUploadUrl(url)` unless `regenerateAttachments=yes` (then PDFs are rebuilt from the records). The Excel workbook is rebuilt fresh (`!isMidday && !skipAttachments`).
- `begin` with `parentId`: skips the workday requirement and day-bound guards (`day = null`), `dailySendProblem(..., revised=true)` only blocks while another send is sending/uncertain; the new row has `parentId = parent.parentId ?? parent._id` (always the root), `number:1`, own `expiresAt`; `finalizeDailyEmail` appends to the round's `revisedAt` and gives that version its own 31 days. Corrections work after the workday ended and do not need another midday or checks. No receipt/`autoCompleteWorkday` for corrections (`!email.parentId` condition; a correction also has no `receiptId` because `day` is null).
- `revisedSubject`: strips any leading "REVISED -" / "REVISED:" repeats, prefixes `REVISED - ` once. Reply matching ignores it (`lib/routing strippedSubject`).

### Flow D - Failure, uncertainty, reconcile

- Graph failure classification (`ta/eodMail:send`): result `ok:false` -> `uncertain` when the error matches `/could not be reached|returned 5\d\d/i`, else `failed`. A thrown error in the action -> `uncertain` and rethrown. **Uncertain is never retried automatically**; `dailySendProblem` and `begin` block every later send on that location until reconciled. `failed` drafts (midday) can be retried; a failed EOD shows "Return to the composer to retry".
- `ta/dailyEmails:reconcile` (UI: `DailyEmailView` form -> `reconcileDailyEmail` action): only `admin` or the job's `taLeadId` lead; status must be `sending`/`uncertain`/`accepted` with no `finalizedAt`; reason 1-1000 chars ("Record how you verified the sending mailbox and its message reference."); `sending` needs >=5 min old ("Wait five minutes and check the sending mailbox before reconciling."); `accepted` cannot be turned into failed. "Verified sent" -> `accepted` + `acceptedAt` + `finalizeDailyEmail` (no resend); "Verified not sent" -> `failed`. Patches `reconciledBy`, `reconciliationReason` on email and receipt, then `refreshWorkdayChecks`.
- Today's Checks also surfaces reconcile (Workday UI; see /workday).
- Stuck sends (30 Oct): cron `ta-flag-stuck-sends` (every 5 min, `flagStuckSends`, index `dailyEmails.by_status`) turns any `sending` email older than 15 minutes into `uncertain` (and its receipt) so the Lead sees it; before this a dead action left `sending` for days (Sameera 29 Oct, Priya 23 Oct) and blocked that sender. It never resends.

### Flow E - Retention and purge

- `EMAIL_RETENTION_MS = 31 * 86400000` (src/lib/dailyEmail.ts). Each accepted version: `expiresAt = acceptedAt + 31d`; saved PDFs in `dailyEmailAttachments` (`_storage` copies, independent from the candidate's CV) get `expiresAt >= email's`.
- Cron `ta-purge-eod-copies` (convex/crons.ts, `registry.interval`, 41 minutes) -> `ta/eodCopies:purgeExpired`: batch 200 each of (1) `eodEmailCopies` past `expiresAt` deleted; (2) `dailyEmails` with `expiresAt` in (0, now] and status not `sending`/`uncertain` get `snapshot: undefined, fields: {}, expiresAt: undefined` (the row, numbering, `roundId`, `applicationIds` stay for duplicate prevention/audit); (3) `dailyEmailAttachments` past expiry: if any referencing email is sending/uncertain or unexpired the file's expiry is pushed to max(now+1 day, that email's expiry), else `storage.delete` + row delete. Reschedules itself at 0 delay when a batch is full.
- Reads hide content as soon as `expiresAt <= now`: `list` blanks `fields`/`snapshot`; `attachment` throws "This attachment is no longer retained."; `sent` excludes them. Do not rely on the cron for correctness.
- `ta/eodCopies:normalizeRetention` (pipeline migration, `dryRun` arg): lifts accepted emails whose `expiresAt < acceptedAt + 31d` and their attachments; imports still-live legacy `eodEmailCopies` that no `dailyEmails.legacyCopyId` adopted as accepted EOD rows (rebuilds HTML with `eodEmailHtml`, `attachmentNames: []`, chains to a root by `roundId`). Returns `{dryRun, affected, legacyCopiesToImport}`.
- Sidebar "sent emails" list: `ta/dailyEmails:sent` (user's own accepted finalized EOD with snapshot, via `by_user_accepted`, plus un-adopted legacy copies marked `legacy:true`).

### Content builders

`src/lib/eod-format.ts` (no data access, safe in client bundles):
- `eodEmailHtml({rows, effort, senderName, senderTitle?, introText?, outroText?, attachmentNote?, researchLink?, refereeCalls?})`. Order: intro, Table 1 (only when `rows.length`), Table 2, Referee calls block, Research line, optional attachment note, outro. All inline styles. Default intro with CVs: "Dear Sir,<br><br>Please find the attached Shortlisted CV for the above-mentioned position"; activity-only: "...Please find today's activity for the above-mentioned position." Default outro "Thank You / Best Regards, <name> / Executive - Talent Acquisition". Custom `introText`/`outroText` replace them (blank lines -> `<p>`).
- Table 1 `SHORTLIST_COLUMNS`: NO, NAME, AGE, NOTICE, NOTES, CURRENT COMPANY, CURRENT DESIGNATION, CURRENT REMUNERATION, EXPECTED REMUNERATION (LOCATION removed 21 Sep). Notes use `formatNoteHtml`: `==highlight==` (yellow mark), `**bold**`, `*italic*`, leading `>` chevron, `- ` bullet. The table is omitted entirely when `rows` is empty (the "No new candidates for Director Review." fallback row is unreachable from `eodEmailHtml`).
- Table 2 `EFFORT_COLUMNS` via `effortColumns(kind)`: DATE, ASSIGNEE, 100% / FOLLOW UP, NO.OF L EFFORT (label "NO. OF CVs" on Follow-up), SETS, DA (Direct Applicant), SCOOP, L, POST, ADD-ONS, BACK-UP. One value row; SETS cell = `setsCell(sets, dayTotal(effort))` -> "2 · 14 CVs" (typed CV suffix stripped so it is not doubled). A second TARGET row ("Target" italic in column 2) appears when any `targets[key]` is set.
- Referee calls block: groups `positive` ("Positive – contacts available") and `negative` ("Not successful"); columns #, Company, Referral, Contact Number, Feedback. Omitted when empty.
- Research line: only if `validateResearchLink` passes: `<b>Research:</b> <a>View ChatGPT Research</a>` plus the URL in small type.
- `validateResearchLink`: <=300 chars, no whitespace, host exactly `chatgpt.com`/`www.chatgpt.com`/`chat.openai.com`, path `/share/<id>` or `/share/e/<id>` (>=8 chars), private `/c|g|gpts|chat` paths refused, normalised to `https://host/path` (query/hash dropped). `needsResearchLink(role, kind)` is true only for `ta`/`ta_support` + director kind (the workType argument is ignored). `checkResearchSubmission` also accepts `excused` (trusted backend evidence only; blank link allowed).
- Recipients: `EOD_TO = "joborders@career141.com"`; `EOD_CC_DEFAULTS = shamra@, asma@, opsteam@, cv@ (career141.com)`; `parseAddressList` (split on `,;` whitespace, lower-case, de-dupe, bad ones returned separately); `eodRecipients({removed, extraTo, extraCc, shortlistInbox})`: To = EOD_TO (unless removed) + extraTo; Cc = defaults + `repo.shortlistInbox()` (the reply-watching inbox, setting `shortlistInbox`, default `DEFAULT_SHORTLIST_INBOX`) minus removed + extraCc, nobody on both lines. Replies go to `replyTo: [user.email, shortlistInbox]`. On a correction the page rebuilds To/Cc from the parent snapshot (see Flow C).
- `eodDetailChanges(base, edited)` / `boxOverrides(change)`: diff of what the TA changed against the record -> `patch` (`currentTitle`, `currentEmployer`, `currentSalary`, `expectedSalary`, `noticePeriod` + `noticePeriodDays` via `noticePeriodToDays`) and `notes` (house lines `Total Experience - `/`Currently at ` and formatting marks stripped). Name and age edits stay email-only. `saveEodEdits` applies them after the send; `boxOverrides` feeds the prepared CV box so the PDF says what the email says.
- Dead setting: `DEFAULT_EOD_CC` (`azim@career141.com`), `repo.eodCopyTo()`, `setEodCopy` action and the composer `eodCc` prop (page passes `eodCc={null}`) are no longer used by the send path; the Cc comes from `EOD_CC_DEFAULTS`.

`src/lib/eod.ts`:
- `shortlistRowFor`: notice = `noticePeriod` text, else "Immediate" for 0 days, else "<n> days"; current remuneration default "Not disclosed"; expected default "Open to discuss"; notes via `HOUSE_NOTE`: `>Total Experience - <n>yr`, `>Currently at <employer>`, then every application note (de-duped).
- `effortRow(openingId, ta, date, workLocationId)`: `since = colomboDayStart`; `lEffort` = CVs sent (Follow-up) or scouted links (other kinds: this TA's `linkVault` rows added today, or approached/moved today, or logged today); `sets` = latest set number from `setsForOpening` (see /sets-shortlist); counts per bucket from `sentToDirectorToday`.
- `effortBucket(app, headhunted)`: **order is backUp (`backupForApplicationId`), scoop (`scoopFrom || scoopReceivedAt`), addOns (`isAddOn`), then `cvSource`** (`da`, `post`, `l`; `database` -> counted nowhere). `dayTotal` sums `CV_COLUMNS` (da, scoop, l, post, addOns, backUp) so each CV counts once.
- `sentToDirectorToday`: director rounds sent by this TA since Colombo midnight (excluding `recoveryReopenedAt`) plus the people waiting in tonight's email, once each, filtered to location.
- `subjectLine(client, title, setNumber, cvCount)` -> "SET 1 - CLIENT - TITLE - 3 CVs" (upper-cased; "1 CV" singular). The page uses `subjectTitle = title [- location name]`; no rows -> "<CLIENT> - <TITLE> - DAILY ACTIVITY" (midday subject matched to EOD 19 Oct).
- The file ends with a deliberate non-feature: no "please reply with numbers" text may be appended to the email (comment explains; the system adapts to the Director, not the reverse).

### Attachments (prepared CVs and workbook)

- One PDF per rostered candidate: `preparedCvFile(app, candidate, opening, {annotation})` (src/lib/preparedCvFile.ts, same as the drawer's Prepared CV) with `annotation = {...boxContent(app,c,opening), ...boxOverrides(eodDetailChanges(base,row))}`; name `preparedCvFileName(c.fullName)` (src/lib/pdf; shown as "<Name> - Career141.pdf").
- For daily emails each PDF is also uploaded: `ta/cv:uploadUrl` -> POST bytes to `internalUploadUrl(url)` -> `ta/dailyEmails:saveAttachment` (own candidates only for workers). The `{id,name,applicationId}` list goes in `snapshot.attachments`; download route `GET /api/eod/attachment?email=&attachment=` (src/app/api/eod/attachment/route.ts) -> `ta/dailyEmails:attachment` (owner TA or desk roles; retained only), served `application/pdf`, `private, no-store`.
- Workbook: `buildOpeningExcelAttachment(openingId, user, title, workLocationId)` (src/lib/linkExport.ts) - `getScopedLinkVaultEntries` for the user/location, `buildLinkExportLayout`, `buildXlsx`; filename from `excelFilename(client, title, location)`. Attached only when `rowCount > 0` and not midday and not `skipAttachments`. `linkIds` stored as `snapshot.workbookLinkIds` and re-checked in `begin` for opening+location. Workbook bytes are not retained; only names.
- **EOD is all-or-nothing**: any CV preparation failure returns "Not sent: could not prepare the CV attachment for <names>. No candidates have been marked as sent." (before `begin`). Also "No CV could be attached..." when rows empty and not activity-only. Midday tolerates failures.
- Graph transport (`sendDraftWithAttachments`): POST `/users/{from}/messages` (draft) -> per attachment: < 3 MiB (`SIMPLE_ATTACHMENT_LIMIT`) POST `/attachments`; >= 3 MiB `createUploadSession` and PUT chunks of 3 MiB (`ATTACHMENT_CHUNK`) with `Content-Range`, no bearer header on PUTs -> POST `/send`. Senders tried in order: the TA's own mailbox (`from`), then `fallbackFrom` only on 403/404. Any other status stops. A failed draft leaves an unsent draft in the mailbox (unverified whether cleaned up).
- Gates inside `sendFollowUpMail`: `resolveRecipient("email", to, "EOD_TEST_EMAIL")` (convex/lib/outreachSafety.ts) - unless `OUTREACH_LIVE=true`, the main To is swapped for the `EOD_TEST_EMAIL` inbox and, because of `keepInternalInTest:"career141.com"`, other `@career141.com` recipients still get it (others dropped, noted as `[TEST MODE: ...]`); `emailAllowed` (convex/lib/outboundGuard.ts, `C141_OUTBOUND_ALLOW_EMAILS`) holds back non-allowed addresses with `[OUTBOUND LOCK: not sent to ...]` in the result note, shown to the TA. Result note is shown in the redirect `msg`.

### Work locations (multi-location jobs)

- A job with `workLocations` has per-location midday drafts, EOD, workbook, subject (`<title> - <location>`) and receipts. `inWorkLocation(row, id)` filters `dailyEmails`, applications, `linkVault`, receipts; `requireWorkLocation(job, requested)` throws when a located job gets no/unknown location and returns undefined for jobs without locations.
- `taWorkdays.jobs[].workLocationIds` snapshots required locations when the job joins the day (`begin` fills it on first send for older days). `autoCompleteWorkday` only closes a day when every location has an accepted original EOD (`jobEodComplete` / `locationEodComplete` in src/lib/workLocations.ts via convex/lib/workLocationEmails.ts `acceptedEod`).
- `emailPreflight` drops `director_cv`, `midday_email`, `mail` blockers for located jobs (each location has its own checks via `dailySendProblem`). Activity-only EOD is allowed for a located job (`allowActivityOnly={!!location}`); for unlocated jobs the "activity only" mode exists via the same flag but the composer path with 0 rows requires `kind==="director"`.
- Browser draft keys include opening, actor, location and Colombo date: `eodDraftKeys(...)` in src/lib/eodDraft.ts. docs/work-locations.md is the user-facing doc.

## UI surface

| Where | What | Triggers |
|---|---|---|
| `/openings/[id]/eod` (`page.tsx`) | EOD page; `?kind=client` shows the client copy (legacy flow); `?location=`, `?mail=`, `?revise=yes`, `?resend=`/`?view=` (legacy copy ids), `?sent=` | server component |
| `/openings/[id]/midday` | wrapper -> same page, `mode:"midday"` | `addMiddayEmail` (button "Add midday email", disabled when `eodClosed`) |
| `EodComposer` (src/components/EodComposer.tsx, ~1,350 lines) | recipients chips (take off / add To or Cc), subject, intro, editable Table 1 cells, Table 2 inputs with targets, referee calls, ChatGPT link + private-window tick (`useChatgptResearch` -> `changeWorkday` in src/app/workday/actions.ts, syncing the link to Today's Checks), attachment list with live preview (`/api/prepared-cv/<appId>?...` overrides), "Send without CV attachments" (midday), `EodJobChecks` blockers (EOD, non-correction), Send button | form `#eod-send`: `sendDailyEmail` / `sendEod` / `resendEod`; `saveMiddayDraft` autosave |
| `DailyEmailHistory` / `DailyEmailView` (src/components/DailyEmailHistory.tsx) | list for the selected type and location; read-only view of one email in a sandboxed iframe, attachment links, reconcile form, "Edit and resend", retry link | `reconcileDailyEmail`; links to `?mail=` |
| `EodDraftCleanup` (src/components/EodDraftCleanup.tsx) | removes the localStorage draft keys after a confirmed accepted send | `?sent=` |
| `SentHistory` / `SentEmail` / `ResearchLine` (inside page.tsx) | legacy `eodEmailCopies` list ("Sent emails", Edit and send again -> `resendEod`, 8 Oct), read-back of a copy, research link in rounds | `repo.eodCopies` (hidden when `workLocationId` is set) |
| `WorkLocationTabs`, `LiveTableRefresh`, `EyeMarkedChecks` | location switcher; live refresh (EOD only); eye-marked profile checks (EOD, 100% mode, not a correction) | - |
| "Waiting on a reply" panels | `readEodReply`, `readInboundReply` - belongs to /sets-shortlist | - |

Who sees it: page needs a sourcing seat (`seatFor(...).canSeeSourcing`). Composer actions need `opening.act`; viewing/correcting an existing email needs `opening.read`. TA/support see only their own `dailyEmails` (`list` filters by `userId`); lead/director/admin/ops see the job's all. Reconcile controls only for `ta_lead` and `admin` (and server restricts to the job's TA Lead or admin). Correction link only for the email's owner.

Browser draft behaviour (src/lib/eodDraft.ts): an edit is stored with the record's value at edit time (`_base`) and the review-stage visit (`reviewStageChangedAt`/`_reviewStageChangedAt`); `applyCandidateDraft` drops an edit when the record has changed since or the candidate re-entered review (a draft without a visit stamp is treated as this visit's).

## Data

| Table | Use | Notes |
|---|---|---|
| `dailyEmails` (convex/schema.ts) | draft + send record + saved copy | indexes `by_user_job_date`, `by_job`, `by_expires`, `by_user_accepted`; status `draft/sending/accepted/failed/uncertain`; `submissionType`, `number`, `revision`, `fields` (draft form), `applicationIds`, `parentId` (root EOD), `roundId`, `receiptId`, `workType`, `workLocationId/Name`, `snapshot` (any: `DailyEmailSnapshot`), `startedAt/acceptedAt/finalizedAt/expiresAt`, `trackedAt`, `reconciledBy/Reason`, `recoveryReopenedAt`, `legacyCopyId` |
| `dailyEmailAttachments` | stored CV PDFs | `by_expires`; `expiresAt` required |
| `dailyEmailPolicy` | `{key:"midday", requiredFrom}` | `by_key` |
| `taWorkdayMail` | receipt per send; drives checks and `autoCompleteWorkday` | `by_workday_job`; `dailyEmailId`, `revised`, `submissionType`, `recoveryReopenedAt` |
| `reviewRounds` | Director round created by finalize | `by_opening`; `kind:"director"`, `submissionType`, `token C141-MAIL-<id>`, `revisedAt`, `recoveryReopenedAt` |
| `eodEmailCopies` | legacy 8 Oct copies (still read by `sent`, `repo.eodCopies`; legacy `sendEod`/`resendEod` still write them via `repo.saveEodCopy`) | `by_expires`; mapped in convex/ta/model/tables.ts as `identity("eodEmailCopies", ["researchLink"])` |
| `taWorkdays`, `taWorkdayCheckNotes`, `taSettings` | workday entry (`workType`, `modeHistory`, `workLocationIds`), saved ChatGPT link/confirmation, working stage fallback | owned by /workday |
| `applications`, `candidates`, `linkVault`, `refereeCalls` | read for rows/effort; candidate fields patched after send by `saveEodEdits` | |

`DailyEmailSnapshot` (src/lib/dailyEmail.ts): `subject, html, from, to[], cc[], attachmentNames[], attachments[{id,name,applicationId}], workType, rows, effort, refereeCalls, introText, outroText, researchLink, extraTo, extraCc, removed, workbookLinkIds`. After `result`, `to/cc/from` are overwritten with what Graph actually used (test-mode swaps visible). Adding a snapshot field: it is `v.any()` so no schema change, but update `normalizeRetention` rebuild and `DailyEmailView` if shown.

## Backend wiring

- Convex (all internal; called from Next via `convexQuery`/`convexMutation`/`convexAction` in src/lib/convexServer): `ta/dailyEmails:` `list`, `sent`, `createDraft`, `saveDraft`, `begin`, `result`, `reconcile`, `saveAttachment`, `attachment`, `enableRequirement`; `ta/eodMail:send` (action, Node); `ta/eodCopies:` `purgeExpired`, `normalizeRetention`; `ta/workdays:` `eodContext`, `emailPreflight`, `researchExceptionAllowed`, `mailResult`, `beginMail` (legacy), `refreshWorkdayChecks`, `autoCompleteWorkday`; `ta/cv:uploadUrl`; helpers `convex/lib/dailyEmail.ts` (`finalizeDailyEmail`, `dailyEmailsFor`, `middayRequired`), `convex/lib/workLocationEmails.ts`, `convex/lib/workdayChecks.ts` (`requiredChecks`), `convex/lib/graphMail.ts`, `convex/lib/graphClient.ts` (`getGraphToken`), `convex/lib/outreachSafety.ts`, `convex/lib/outboundGuard.ts`.
- Cron: `ta-purge-eod-copies`, every 41 minutes, no gate (convex/crons.ts).
- Next: server actions in src/app/actions.ts (`sendDailyEmail`, `sendEod`, `resendEod`, `addMiddayEmail`, `saveMiddayDraft`, `reconcileDailyEmail`, `emailEod`, `eodResearchSubmission`, `eodWorkContext`, `currentRefereeCalls`, `saveEodEdits`, `setEodCopy` (unused)); API route `GET /api/eod/attachment`; `GET /api/prepared-cv/[applicationId]` (preview only). `eodInFlight` (a per-process `Set`) guards the legacy path only; the durable guard for the new path is `begin`.
- Env names: `EOD_TEST_EMAIL`, `OUTREACH_LIVE`, `OUTREACH_TEST_EMAIL`, `C141_OUTBOUND_ALLOW_EMAILS`, `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `MS_SENDER_EMAIL`, `OUTBOUND_EMAIL_SENDER`. Setting `shortlistInbox` (taSettings, via `repo.setting`). No feature kill switch exists for daily emails; the outbound lock and `OUTREACH_LIVE` are the brakes.
- External: Microsoft Graph (`https://graph.microsoft.com`, via `GRAPH_BASE` in graphMail.ts). Never call it from a laptop-pointed-at-live setup.

## Access and roles

- Convex `access()` in ta/dailyEmails.ts: allowed roles `ta`, `ta_support`, `ta_lead`, `director`, `admin`, `ops` (+ `viewer` for read-only queries `list` and `attachment`); everyone except admin/ta_lead/director/ops must be `primary_recruiter`/`supporting_recruiter`/`ta_lead`/`director` on the job (`assertJobAccess`). `worker(u)` = `ta`/`ta_support`.
- `src/lib/auth.ts` capabilities: `opening.act` (desk-wide always; others need an assignment, client_contact denied, collision lock: a TA is refused on a candidate claimed by another recruiter), `opening.read`. `isTa(user)` narrows rows to the TA's own candidates and activates `eodContext`.
- Workday gate: workers must have an active workday (`finishedAt` undefined, or closed by `closureReason:"eod"` on the same date) that contains the job; leads/admin send without one (`day = null`: no receipt, no `autoCompleteWorkday`, no checks, no midday requirement, no `workLocationIds` adoption).
- Collision lock: roster for a worker is only `ownerTaId === user._id`; `saveAttachment` refuses another TA's candidate; `begin` recomputes the roster server-side.
- Reconcile: admin, or `ta_lead` equal to `job.taLeadId`.
- Only the sender can correct (`parent.userId === user._id`); the sender's own mailbox is the `from`, so no one can send as someone else.

## Invariants and safety

1. Reserve before transport: the `sending` row and receipt exist before Graph is called; acceptance is recorded in one mutation (`result` + `finalizeDailyEmail`). A second acknowledgement cannot make another round (`finalizedAt` early return). Created by the 16-17 Oct duplicates work (eacc9c2, 95a32e4).
2. Uncertain results are never auto-retried; reconcile never calls Graph (`finalizeDailyEmail` is shared with recovery). Do not add a "retry" for `uncertain`.
3. Outbound only through `sendFollowUpMail` (test inbox, `keepInternalInTest`, outbound lock). Never set `OUTREACH_LIVE` in code/config; never bypass the lock for "internal" mail. The lock note must stay visible to the TA (30 Sep, 322bb9b: a held-back Cc once showed a plain "Sent").
4. EOD is all-or-nothing on CVs; CVs are prepared before `begin` so failure reserves nothing (16 Oct 605df63 "send all CVs").
5. Original EOD: one per sender/job/location/Colombo day (`dailySendProblem`, receipts check). A correction reuses the original roster in the original order and the original round; it never adds or removes candidates.
6. Server recomputes the roster and checks `sameCandidateList` - the browser list is advisory. Both composer and reservation use `isEodCandidateEligible` (one policy).
7. Work type is server-authoritative (`eodContext`, `begin` check, `effort.hundredOrFollowUp` overwrite); the TA cannot waive tasks by editing the form (`eodResearchSubmission` header comment, 16 Oct c1bebc5).
8. ChatGPT link rules: share links only, exact hosts, private-window tick, link saved to Today's Checks (8 Oct 57b3ee8; excusable only with a recorded `chatgpt:` exception).
9. Colombo-day arithmetic: always `workdayDate(Date.now())` / `colomboDayStart`, never server-local dates (`saveDraft` refuses another day's draft).
10. `expiresAt` retention: 31 days per accepted version; extend, never shorten; uncertain/sending payloads are kept until resolved (purge filter). Reads hide expired content immediately.
11. Highlight/bold marks go into the email, not onto the candidate (`stripNoteFormatting` in `eodDetailChanges`; 30 Sep df81f97). House lines `Total Experience`/`Currently at` are not saved as notes.
12. Only people actually at Director Review go in the email (29 Sep b15af38). A TA Shortlisted candidate is not pulled in.
13. A profile saved after the TA typed must win over the older box edit (22 Oct cc0fca0, fa22cc4); do not reset edits on a stage revisit without a visit stamp (the #243 incident in the `fromEarlierVisit` comment).
14. Failure to save profile edits after a send must not invite a second send (`sendDailyEmail` swallows it into a message).
15. Press-once: `SubmitButton` pending label "Sending... this can take a minute" (6 Oct 7c824dc, because repeated presses sent repeated emails).

## Known quirks, gaps and unverified items

- The skill brief's `isEodCandidateEligible` and `workSessionStart` live in `src/lib/eodEligibility.ts` and `src/lib/workdayRequirements.ts`, not `src/lib/dailyEmail.ts` (which holds `dailySendProblem`, `sameCandidateList`, types, `EMAIL_RETENTION_MS`).
- Dead code: `setEodCopy`, `DEFAULT_EOD_CC`, `repo.eodCopyTo()`, composer `eodCc` prop; no UI calls `setEodCopy` (grep). `MANUAL_EFFORT` is an empty set kept deliberately.
- Midday and correction research checks hardcode role `"ta"` in `sendDailyEmail`, so an admin/lead must also supply and confirm a link there, while on an original EOD it is optional for them.
- `emailPreflight` runs only for original EODs of workers; it writes the confirmed link into `taWorkdayCheckNotes` as a side effect even if the send later fails.
- `sendEod` legacy path: kept for the client copy and non-Convex mode; it still writes `eodEmailCopies`. Whether the client-copy flow is still used in production is unverified.
- Legacy `?resend=`/`?view=` URLs map through `legacyCopyId` only for adopted copies; un-adopted ones show the SentHistory list when no location is selected.
- Partial Graph drafts after a failed attachment upload are not deleted by code (unverified whether they appear in the TA's Drafts folder).
- Referee calls come from `repo.refereeCalls` for today's date and the TA; `refereeCalls` on a correction use the saved snapshot. The referee call form `refereeCallResults` override only accepts "positive"/"negative".
- `deploy/convex-env/production.env` carries an `EOD_TEST_EMAIL` entry; whether production runs with `OUTREACH_LIVE=true` is not verifiable from the repo (check with the owner, never from code).
- `ta/dailyEmails:sent` filters to `submissionType==="eod"` only; midday emails are not in the sidebar list.
- `list` returns every email on the job for desk roles, unbounded (`by_job` collect), as does the `begin` guard (`all`); watch cost on busy openings.
- The `dailyEmails.snapshot` `v.any()` schema means shape drift is not type-checked at write.

## How to change it safely

Where to edit:

| Change | Edit | Also change |
|---|---|---|
| Table 1/2 columns, wording, sign-off, referee block | `src/lib/eod-format.ts` (`SHORTLIST_COLUMNS`, `EFFORT_COLUMNS`, `eodEmailHtml`) | `ShortlistRow` type, `shortlistRowFor`/`shortlistRowsFromForm` in `src/lib/eod.ts`, `EodComposer` inputs, `eodDetailChanges`/`boxOverrides`, `normalizeRetention` rebuild, legacy `eodEmailCopies.rows` validator in schema if a legacy row gains a field, `docs/` text |
| Effort column logic | `src/lib/eod.ts` (`effortRow`, `effortBucket`, `sentToDirectorToday`) | `tests/eodeffort.test.ts`; owner decides what is counted (desk rule 28 Sep) |
| Who is eligible | `src/lib/eodEligibility.ts` only | `begin` and `shortlistRows` already share it; midday uses the inline `second_shortlist` test in `begin` - keep in sync if you change it |
| Recipients | `EOD_TO`, `EOD_CC_DEFAULTS`, `eodRecipients` | page `fixedCc`/`toEmail`, composer chips; tell the owner |
| New send guard | `ta/dailyEmails:begin` (authoritative) and `dailySendProblem`; mirror the message in `emailPreflight` and composer if the TA should see it earlier | `tests/dailyEmails.test.ts` |
| Midday rules | `createDraft`, `saveDraft`, `middayRequired`, `enableRequirement` | `docs/MIDDAY-EMAILS.md` |
| Transport/attachments | `convex/lib/graphMail.ts`, `convex/ta/eodMail.ts`, `emailEod` | `tests/graphmail.test.ts` |
| Retention | `EMAIL_RETENTION_MS`, `finalizeDailyEmail`, `purgeExpired` | a migration (`normalizeRetention` pattern, `dryRun`) for existing rows |
| Locations | `src/lib/workLocations.ts`, `convex/lib/workLocationEmails.ts` | `tests/workLocations.test.ts`, docs/work-locations.md |

Any new `dailyEmails` column: `convex/schema.ts` (optional field) plus `DailyEmail` in `src/lib/dailyEmail.ts`; check `convex/ta/model/tables.ts` mapping (only `eodEmailCopies` is mapped there; `dailyEmails` is read directly via `ta/dailyEmails:list`).

Tests (real files): `tests/dailyEmails.test.ts` (real Convex handlers, synthetic db, no transport), `tests/eodresend.test.ts`, `tests/eoddraft.test.ts`, `tests/eodeffort.test.ts`, `tests/eodEligibility.test.ts`, `tests/eodcvbox.test.ts`, `tests/graphmail.test.ts`, `tests/researchlink.test.ts`, `tests/refereecalls.test.ts`, `tests/linkExport.test.ts`, `tests/workLocations.test.ts`, `tests/workday.test.ts`, `tests/reopenShihabEarlyEod.test.ts`, `tests/repairSanduniMistimedEod.test.ts`, `tests/outreachsafety.test.ts`.

Commands: `npm test`, `npx tsc --noEmit -p .`, `npx tsc --noEmit -p convex`. Local run: `deploy/local/start-app.sh` (local backend on 127.0.0.1 only).

Pre-merge checklist:
- [ ] All three commands above pass.
- [ ] A reservation path change has a test in `tests/dailyEmails.test.ts` (accept, fail, uncertain, correction, duplicate).
- [ ] Nothing sends outside `sendFollowUpMail`; no new env flag defaults to live.
- [ ] Anything that changes what the Director/desk reads (columns, wording, recipients, attachments) or who is emailed is flagged to the owner in the PR/merge report.
- [ ] Data changes ship as an internal function with `dryRun`, run by the release pipeline's `run_function` (like `enableRequirement`, `normalizeRetention`, `admin/reopenShihabEarlyEod:run`); never run from a laptop against `api.career141.com`.
- [ ] Docs updated (docs/MIDDAY-EMAILS.md, docs/work-locations.md) and this skill's `sources` still cover the files.

Repo hard rules that apply here: no `convex deploy/run/import/env set` against live; work on a `<person>/<topic>` branch and merge by PR; no secrets; real candidates are real (outbound via `convex/lib/outreachSafety.ts` and `convex/lib/outboundGuard.ts`; never set `OUTREACH_LIVE`); live changes only through `.github/workflows/deploy-production.yml`.

## History

Short hashes from `git log`; dates are commit dates.
- 2026-09-14 7470f4f - initial platform: first EOD email builder (two tables, spec section 10).
- 2026-09-16 9df2be6 - EOD sent via Microsoft Graph from the TA's own mailbox, Cc azim@ (the old `DEFAULT_EOD_CC`).
- 2026-09-21 690a1253 - editable L-sheet: kind of day (100%/Follow-up/Add-on), targets, real counts; 26766999 - LOCATION column removed.
- 2026-09-24 7fa351a - `EOD_TEST_EMAIL` own test inbox.
- 2026-09-25 e590da3 (sets fill to five), 2026-09-27 504b1f4 (scoops counted, SETS shows day total), 2026-09-28 e9601b3 (sets close on a five-CV day), 4a6cd96 (L EFFORT/L/POST from records; total counts each CV once), 8ce23da (only CVs sent to Director today, one column each) - the EOD counting rules were rewritten three times in four days at the desk's request.
- 2026-09-28 89abe5b - EOD fields editable; current salary mandatory (Gajani review).
- 2026-09-29 722a24a - recipients: To `joborders@`, desk Cc list, TA can add To/Cc (PR #86); b15af38 - only Director Review candidates; 25ac508 - CV box says what the email says; edits saved to candidate.
- 2026-09-30 46c46b6/2a02a29 - chip UI, desk addresses removable; 7c562af - test send still reaches the desk (`keepInternalInTest`); 322bb9b - say on screen what the outbound lock held back (1 Oct finding); 7c98be5/df81f97 - note highlighting and bold in email, not saved to the candidate.
- 2026-10-06 7c824dc - Send button busy and unpressable twice (repeated sends).
- 2026-10-08 57b3ee8 - ChatGPT share link + private-window tick required for TAs; 75753c3 - sent EOD kept (first a day, then a month), "Edit and send again", REVISED subject.
- 2026-10-09 fb9f193/3a97a8a - link box shown to admins/leads (optional) and moved first on the page; b290a81 - current designation and company in Table 1 and saved to the profile.
- 2026-10-13 23e6794 and 38fd1b5 - workday records and checks gate the EOD; 2026-10-14/15 7ac2ac8, 6be7cdf, da3529d, 9213e05, c815389 - the blocker set tuned (eye-marked pending allowed, four setup checks, LinkedIn/Suggestions/Director Review CV, research link synced with Today's Checks).
- 2026-10-16 eacc9c2 - midday emails, optional no-attachment sends, EOD gated on midday, corrections, draft autosave (PR #203); c1bebc5 - mode-aware work type; 605df63 - all CVs sent through Graph draft/upload sessions, drafts preserved; e41489c - midday subject matches EOD. `dailyEmails` introduced here (schema comment dated 16 Oct).
- 2026-10-17 95a32e4 - EOD completes the workday; versioned email backups (`dailyEmailAttachments`, 31-day retention, `normalizeRetention`).
- 2026-10-19 0a2ff43, 12369b5, f400737 - Sanduni late-Friday EOD repair migration (`admin/repairSanduniMistimedEod`).
- 2026-10-20 bdd78a1 - Excel workbook attached to EOD; 09c78f4, 25d2048 - `admin/reopenShihabEarlyEod:run` recovery (docs/RECOVERY-SHIHAB-EOD-2026-10-20.md): his early 20 Oct EOD reopened for submission checks without resending.
- 2026-10-28 - `admin/reopenSameeraEarlyEod:run` one-day recovery (docs/RECOVERY-SAMEERA-EOD-2026-10-28.md): Sameera's early EOD on Q COLLECTION's Industrial Engineering opening is reopened without touching the second TA's emails. The dry run reports all linked records; the write marks only her email, receipt and review round reopened, and opens her workday if EOD closed it.
- 2026-10-21 4dd30a8 - work locations: per-location drafts, receipts, EOD; 904e51f, 23fc0f3 - workbook tabs/names by client, position, location; e28b259 - auto-detect profile updates in the composer.
- 2026-10-22 cc0fca0, 5f8900e, fa22cc4 - TA note edits survive reload, profile updates win, drafts saved before review visits were stamped are kept (release of #243 had wiped box edits); REVISED correction flow reuses the original roster (see 95a32e4 / `previewConfirmed`).
- 2026-10-23 f3d57d6 - EOD can be sent without CVs (activity-only); c28e1b1 - referee calls section in the email (`refereeCalls` on snapshot, `eodEmailHtml`).

<!-- skill-meta
verified-commit: 83c80ee
verified-hash: ca82dc9e46d25731f5938f9950ab840447849c73
verified-date: 2026-10-30
sources:
  src/app/openings/[id]/eod/page.tsx
  src/app/openings/[id]/midday/page.tsx
  src/components/EodComposer.tsx
  src/components/EodDraftCleanup.tsx
  src/components/DailyEmailHistory.tsx
  src/components/useChatgptResearch.ts
  src/app/actions.ts
  src/app/api/eod/attachment/route.ts
  src/lib/eod-format.ts
  src/lib/eod.ts
  src/lib/dailyEmail.ts
  src/lib/eodDraft.ts
  src/lib/eodEligibility.ts
  src/lib/preparedCvFile.ts
  src/lib/linkExport.ts
  src/lib/workLocations.ts
  convex/ta/dailyEmails.ts
  convex/ta/eodMail.ts
  convex/ta/eodCopies.ts
  convex/lib/dailyEmail.ts
  convex/lib/graphMail.ts
  convex/lib/workLocationEmails.ts
  convex/admin/reopenShihabEarlyEod.ts
  convex/admin/reopenSameeraEarlyEod.ts
  convex/admin/repairSanduniMistimedEod.ts
  convex/schema.ts
  convex/crons.ts
  docs/MIDDAY-EMAILS.md
  docs/RECOVERY-SHIHAB-EOD-2026-10-20.md
  docs/RECOVERY-SAMEERA-EOD-2026-10-28.md
  docs/work-locations.md
  tests/dailyEmails.test.ts
  tests/reopenSameeraEarlyEod.test.ts
  tests/eodresend.test.ts
  tests/eoddraft.test.ts
  tests/eodeffort.test.ts
  tests/eodEligibility.test.ts
  tests/eodcvbox.test.ts
  tests/graphmail.test.ts
  tests/researchlink.test.ts
  tests/refereecalls.test.ts
  tests/workLocations.test.ts
-->
