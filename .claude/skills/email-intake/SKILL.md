---
name: email-intake
description: How incoming email becomes work in the Career141 TA System - Microsoft Graph client, the two mailbox readers (CV-platform poller pollEmailInbox and TA mail intake convex/mailIntake), crons, every mailbox (linkedin@ cv@ job@ shortlists@ interviews@ per-TA .jobs@ per-job inboxes), post routing, LinkedIn applicant mail, candidate replies, Settings > Mailboxes. Aliases mail intake, mailbox poller, inbox reader, linkedin@, Graph webhook, intake queue. Use when changing, debugging or extending any of it.
---

# Email intake

## Scope and boundaries

In this skill: everything between "an email lands in a Career141 mailbox" and "a candidate, application, stage move or note exists in the TA System", plus the plumbing that proves it is working (health, alerts, Settings > Mailboxes) and the test-mode rules for the outbound Graph mail that shares the same client.

Not in this skill (read the neighbour first when the change crosses over):

| Neighbour | What lives there |
|---|---|
| /follow-up | The chase sequence, the AI that answers a candidate's reply (`communications/inboundExtraction.extractDetailsFromText`), reminders, `sendGraphEmail`/`sendFollowUpEmail` content. Intake only records the reply and hands off. |
| /sets-shortlist | Meaning of Director/client decisions, review rounds, Shortlist decisions page, EOD email content. Intake only reads and routes the mail (plumbing in `mailIntake/decisions.ts`, `process.ts`). |
| /scoop | TA-mailbox scoops are no longer read (29 Sep); scoops are uploaded on the opening. |
| /cv-extraction | What happens after a CV file is handed to `pipeline/ingestion:processCvIngestion` (text, AI read, dedupe, scoring). |
| /openings | Job posts (`jobPosts`), LinkedIn link on a post, campaign code, alias keywords, openings on hold. This skill reads those; it does not own their editing UI. |
| /excel-tables | The Chrome extension's captured LinkedIn profile rows (`/api/extension/*`); not mail. |
| /workday, /eod-email | EOD/midday mail is sent through the same `lib/graphMail.ts`; schedule and content live there. |
| /strategy-planner, /voice-agent, /database-search | Unrelated except that the database holds the people intake files. |

Two readers coexist on purpose and read the same mailboxes against the same database (see Invariants). Always say which one you mean.

| | CV-platform poller | TA mail intake |
|---|---|---|
| Code | `convex/communications/emailAgent.ts` `pollEmailInbox` | `convex/mailIntake/{sync,process,model,...}.ts` |
| Reads | linkedin@, cv@, job@, per-job inboxes | linkedin@, cv@, job@, shortlists@, interviews@ (switchable per mailbox) |
| Mechanism | list by date (and unread), cursor, **marks mail read** | Graph **delta** query, never touches the mailbox |
| Registered | always (unless `C141_DISABLE_CRONS=true`) | only with `C141_MAIL_INTAKE=on`; each mailbox also switched on in Settings |
| Files CVs through | `processSingleEmailAttachment` -> `processCvIngestion` | `ingestCvs` (process.ts) -> `processCvIngestion` |

## How it works now

### 0. Microsoft Graph client and senders

- Token: `convex/lib/graphClient.ts` `getGraphToken()` (client-credentials, module cache, refresh inside 5 min of expiry, throws when env missing). `emailAgent.ts` has its **own** exported `getGraphToken()` returning `null` instead of throwing (cache until expiry minus 300 s). Two helpers, two caches; `mailIntake/*`, `graphEmail.ts`, `graphSubscriptions.ts` use the first, `pollEmailInbox` and the rescan the second.
- Env names: `MS_GRAPH_TENANT_ID|MS_TENANT_ID`, `MS_GRAPH_CLIENT_ID|MS_CLIENT_ID`, `MS_GRAPH_CLIENT_SECRET|MS_CLIENT_SECRET`. App registration needs Mail.Read (application) on every read mailbox; sending needs Mail.Send. A 403 from the delta query is turned into the message "The app registration needs the Mail.Read application permission for this mailbox" on the mailbox card.
- Sending: `convex/lib/graphMail.ts` `sendFollowUpMail(mail, getToken, fetchImpl)`; pure, fake Graph in `tests/graphmail.test.ts`. Gate order: `resolveRecipient` (outreachSafety) -> `emailAllowed` (outboundGuard) -> copies filtered -> sender list (`from`, then `fallbackFrom` only on 403/404). Result is always `MailResult` with a reason; `x-c141-candidatejobid` header stamps the application id so replies can be tied back. `attachmentMode: "draft"` (EOD) creates a draft, adds attachments (inline < 3 MiB, upload session in 3 MiB chunks above), then sends.
- Test-mode recipient rules (`convex/lib/outreachSafety.ts`): `OUTREACH_LIVE=true` sends to the real person; anything else redirects to `OUTREACH_TEST_EMAIL` (or the mail's own `testInbox` env, `EOD_TEST_EMAIL` for the end-of-day email) and refuses when none is set. Copies (`cc`/`alsoTo`) are dropped in test mode except addresses at `keepInternalInTest` (`career141.com`, passed only by `ta/eodMail.ts`). `C141_OUTBOUND_LOCK=true` additionally allows only `C141_OUTBOUND_ALLOW_EMAILS`/`_PHONES`; held recipients are named in the result note. `deploy/convex-env/production.env` pins `EOD_TEST_EMAIL` to the job-orders inbox so test EOD mail never leaves Career141. Thread replies (`graphEmail.replyToMessage`) use `mayReplyTo`: in test mode only to the test recipient, and not at all while the outbound lock is on.
- Intake never sends. The only outbound near intake is the follow-up hand-off (section 6), which goes through the gates above.

### 1. CV-platform poller: `emailAgent.pollEmailInbox`

Trigger: crons `poll-linkedin-inbox` (13 min, linkedin@), `poll-cv-inbox` (11 min, cv@), `poll-jobs-sender-inbox` (3 min, job@), `poll-per-job-email-inboxes` (17 min, `scheduleEmailPolling`), and the Graph webhook (section 8). Args `{inboxEmail, jobId?, ignoreReadStatus?}`. Any inbox whose address contains "sanjeev" is skipped (developer mailbox guard, also in the webhook).

Sequence:

1. Cursor: `getLastEmailFetchTimestamp` (`appSettings` row key `email_fetch_<inbox>`, falls back to key `system`).
2. `fetchInboxEmails`: `receivedDateTime ge max(cursor - 5 min, now - 30 days)`, plus `isRead eq false` **unless** the mailbox is read by log (`readsByLog`: linkedin@, cv@, or `LINKEDIN_SHARED_INBOX`) or `ignoreReadStatus`. `$select=id,isRead,receivedDateTime`, `$top=500`, follows every nextLink. Any page failure sets `fetchedAll=false` (cursor frozen). Only ids and dates are listed; bodies are fetched one message at a time (`fetchFullMessage`, text passed through `cleanMessage`/`wellFormed`).
3. By-log mailboxes: `startMailLog` sets `appSettings.mailLogSince` on first run; `loggedSince` reads `mailboxLog` rows from the oldest listed message (take 8000); `notYetHandled` drops logged ids and mail that was already read before `mailLogSince`.
4. Oldest first, batch `pollBatch(byLog)`: `POLL_BATCH=15`, `LOG_POLL_BATCH=40` (`lib/mailCursor.ts`). The rest is `waiting`.
5. Per message (own try/catch; a failure is logged as `failed`, run continues):
   - `checkAndRecordEmailReply({senderEmail, subject, body, messageId, inboxEmail})` (see section 6).
   - CV attachments = pdf/msword/wordprocessingml content type or .pdf/.doc/.docx name. (Looser than `isCvAttachment` used by mail intake: no size cap, no rtf, inline images not excluded.)
   - No CV: if a reply was recorded -> outcome `reply`; else, with `postRoutingOn() && !jobId`, `holdLinkedInApplicant` (section 5) -> `held`; else `no_cv`.
   - CV present: job = pinned `jobId`, else (`C141_POST_ROUTING=on`) `routeByPosts` (section 4), else the old title/keyword match plus an `email_routing` LLM guess (only while post routing is off). No match -> the candidate goes to the database, never dropped.
   - One `processSingleEmailAttachment` scheduled per CV attachment (2 s stagger, extraction delay +10 s each). It downloads, hashes (SHA-256), and if the hash exists with post routing on and a job it re-files through `processCvIngestion` (the same CV for another job); otherwise uploads to R2 and calls `processCvIngestion` (with `metaHeadline` = subject when post routing on). With `C141_TA_INTAKE=true` (exact string) it calls `ta/intakeReceive.receiveCv` instead and the CV waits as an `intakeItems` row (section 4).
   - Sender not LinkedIn's `jobs-listings@linkedin.com` and not `@career141.com`: schedules `extractAndApplyEmailBodyDetails` (salary/notice from the body).
   - `finish()`: `markEmailAsRead` (skipped when `outboundLocked()`), then for by-log boxes `logMailboxMessage` (`mailboxLog`, once per mailbox+messageId; subject sliced 300, note 500).
6. Cursor commit (`nextCursor`): not fetched in full -> unchanged; outbound-lock deployment reading by flag -> run start; otherwise the **oldest still-waiting** message's date, else run start. On commit, `markMailboxRead` writes `mailPollOkAt` and `mailWaiting`.

Rescan on late-pasted link: `queueRescanForLink` (called by `addJobPost`/`updatePost` in `src/app/actions.ts` via `rereadMailboxFor`) schedules `rescanMailboxForLink` after 5 s: Graph `$search` of linkedin@ (or `LINKEDIN_SHARED_INBOX`) for the link's project/job number and the post's titles (pages 10 x 50), last 30 days, each hit re-routed with today's posts, only those routing to a post carrying this link are filed (CV via `processSingleEmailAttachment`, no-CV via `holdLinkedInApplicant`), cap `RESCAN_MAX=300`. Needs `C141_POST_ROUTING=on`.

### 2. TA mail intake: sync

Trigger: cron `ta-mail-intake-sync` (5 min) -> `mailIntake/sync.syncAll`; or Settings "Sync now" -> `model.syncNow` (schedules `syncMailbox` now and `process.processReady` after 1 s).

- `ensureMailboxes` (mutation) creates rows, **disabled**, for `DEFAULT_MAILBOXES` (linkedin@, cv@, job@), `SHORTLIST_MAILBOX` (shortlists@, kind `shortlist`), `INTERVIEW_MAILBOX` (interviews@, kind `interview`), and switches off any `kind: "ta"` row. `backfillFrom` starts at row creation time.
- `syncMailbox({mailbox})` skips when missing, disabled, or `kind === "ta"`. URL = stored `nextLink`, else `deltaLink`, else `/users/<mb>/mailFolders/inbox/messages/delta?$select=subject,from,receivedDateTime,hasAttachments,conversationId,internetMessageId&$filter=receivedDateTime ge <backfillFrom>`. Header `Prefer: odata.maxpagesize=50`. `MAX_PAGES=20` per run (resumes from stored `nextLink` next tick).
- Per page: drop `@removed`; map to `{messageId, receivedAt, subject(500), fromAddress, hasAttachments, conversationId, internetMessageId}`; keep `receivedAt >= backfillFrom`; `recordMessages` inserts unseen ones (`by_messageId`) as `status: "waiting"`, `nextAttemptAt = receivedAt + grace`.
- Grace: `GRACE_MS = 20 min` (so the poller files a CV first and intake reuses it by file hash); 0 for kind `shortlist` and `ta` (nothing else reads shortlists@). interviews@ gets the 20 min grace too (the code only zeroes `ta` and `shortlist`).
- State: `deltaLink` saved when Graph returns one (`done`); 410 clears both links with error "Sync token expired; starting a fresh sync." and the next run restarts from the backfill window (already logged ids are skipped); 429/5xx and other errors are saved as `lastSyncError` (500 chars) and retried next tick. `totals.seen` increments with `recorded`.
- Windowing rule: `setEnabled` moves `backfillFrom` to now when a mailbox goes off -> on. Mail received before that is never filed (`claimDue` closes it `skipped`: "Received before this mailbox was switched on"). `startFromNow` (internal) moves it without switching off.

### 3. TA mail intake: process

Trigger: cron `ta-mail-intake-process` (1 min) -> `process.processReady({ignoreGrace?})`; `process.processMessage({id})` handles one named message (pipeline/dashboard use; no Settings button).

`model.claimDue({limit: PER_RUN=3})`: reads up to `limit+200` waiting rows with `nextAttemptAt <= now` (index `by_status_next`); closes without work: mailbox disabled -> `skipped`, received before `backfillFrom` -> `skipped`, `attempts >= MAX_ATTEMPTS (4)` -> `failed` (keeps the stored error); otherwise leases (`status: "processing"`, `attempts+1`, `nextAttemptAt = now + 15 min`). Up to 10 expired `processing` leases are reset to `waiting`. Throughput ceiling: 3 messages a minute. Errors thrown by `handleMessage` -> `retryLater(delay = 10 min x attempts, error)`.

`handleMessage` (process.ts) fetches the message (`$select=subject,body,from,toRecipients,conversationId,internetMessageId,internetMessageHeaders`; 404 -> `skipped` "deleted before it could be read"), stores transport ids via `noteTransport`, then branches on `mailIntakeMailboxes.kind`:

| Branch | Rule | Outcome |
|---|---|---|
| `ta` | not read any more | `skipped` |
| `interview` (interviews@) | section 7 | `filed` (moved/noted/already_recorded) else `skipped` |
| `shortlist` (shortlists@) | section 7 | `filed`, `held`, `skipped`, `failed` |
| shared | `isNotAnApplication(from, subject)` (own `@career141.com`/`*.onmicrosoft.com`, auto-replies, bounces) | `skipped` |
| shared, no CV | LinkedIn sender with no named applicant ("job expiring", summaries) | `skipped` |
| shared, no CV, not LinkedIn | `model.replyingCandidate` finds the sender by `candidates.by_email` and a live application; if found -> `recordInboundEmail` + `extractDetailsFromText` (with `applicationId` and `subject` since 29 Oct; it re-guessed the application) | `filed` "A reply from X, read into their record" else `no_cv` |
| shared, no CV, LinkedIn with name | find by `candidateByLinkedin` (`candidates.by_linkedinUrl`) or `createCandidate`; `noteCandidate` records the id at once so a retry reuses it; `placeCandidate` | `filed` (routed) or `database` |
| shared with CV(s) | `ingestCvs`; CV already held by hash -> person placed and noted; other upload still being read -> waits on it | markExtracting, or `duplicate`/`filed`/`failed` |

Routing on the shared branch: `livePosts({withLinkOnly: true})` then `routeShared({subject, body: parsed.text, linkedinOnly: channel==="linkedin"}, posts)` (section 4). Channel by mailbox: `channelFor` -> `linkedin` (linkedin@ or `LINKEDIN_SHARED_INBOX`), `email` (cv@), else `email_campaign` (job@).

`ingestCvs(ctx, token, mailboxPath, cvs, opts, known)`: per attachment, download base64, SHA-256, `uploadByHash` (`cvUploads.by_fileHash`), else `storage.r2.uploadBufferToR2` and `pipeline.ingestion.processCvIngestion` (`metaCampaignId = "TA System mail intake - <mailbox>"`, `shortlistCopy` flag for shortlists@). Attachment filter is `lib/mailParse.isCvAttachment`: real fileAttachment, not inline, <= `MAX_CV_BYTES` 25 MB, .pdf/.doc/.docx/.rtf or CV mime (octet-stream decided by name).

Extraction wait: `markExtracting` sets `status: "extracting"`, `nextAttemptAt = now+2 min`. `processReady` then takes up to 10 due extracting rows -> `finishExtracting`: while uploads are `pending|processing|uploaded|healing|pending_retry` it re-checks every 2 min, up to `EXTRACTION_TIMEOUT_MS = 3 h`; then `placeCandidate` on every destination and `finishMessage` (`failed` if no candidate, `filed` if routed, else `database`).

Placement: `placeOnPosts` (exported; also used by the poller) skips an application that already exists (`setApplicationPost` returns true and only records the post, never over an existing post) - `createApplication` on an existing application moves New CVs -> Matched, which moved 196 applicants on 17 Sep - otherwise `createApplication` (`metaHeadline` = subject, 200) then `setApplicationPost`. New applicants land in New CVs.

Outcomes written to `mailIntakeMessages.outcome` and `mailIntakeMailboxes.totals` (`finish` in model.ts, `TOTAL_KEY`): filed, database, duplicate, no_cv (-> `noCv`), skipped, failed, held (-> counted under `database`).

### 4. Routing mail to a job post

Rules live in `convex/lib/postRouting.ts` (pure; tests `tests/mailintake.test.ts`, `tests/postfiling.test.ts`, `tests/routing.test.ts`). `src/lib/routing.ts` is the app's copy of the headline rules; `convex/ta/intakeRouting.ts` is the Convex copy. Keep all three in step (comments in each say so).

`routeShared` order, strongest first:

1. LinkedIn job number (`linkedinJobId`, URL shapes `jobs/view/..`, `comm/jobs/view`, `currentJobId=`, `hiring/jobs/`) in the body, else the subject, against each post's `externalUrl`.
2. LinkedIn Recruiter project number (`linkedinProjectId`: `talent/hire/<n>` or `talent/...project=<n>`, `&amp;` and URL-encoded forms) in the body only.
3. Campaign code (`postByCampaignCode`) on **listed** (live) posts, exactly one hit.
4. Headline via `rankPosts` (wrappers like "New application:", "You have a new applicant ready for review for" are stripped by `titleCandidates`); LinkedIn mailbox restricts to posts with `channel` linkedin. Only `exact` (100 exact, 90 previous title, 80 title followed by place/client, 75 advert head) and `keyword` (70 alias) confidence returns; `partial` never routes on shared mailboxes. Ties: region (`city`/`country` in text), then the more specific title, then same title across different openings files to **all** (`alsoTo`), newest post per opening.

`livePosts` (model.ts) feeds it: live (and draft with `includeDraft`) posts on **active** openings; with `withLinkOnly`, also paused/closed posts that have a link, and posts on **on_hold** openings, marked `linkOnly` - reached only by their own LinkedIn job/project link (5 Oct, owner's option A). Filled/cancelled/draft openings never collect. `processCvIngestion` accepts `on_hold` only when a `jobPostId` is passed (`ingestion.ts` line ~40).

The poller's version: `pipeline/postFiling.ts` `routeByPosts` (same `livePosts`, includeDraft + withLinkOnly) and `postRoutingOn()` = `C141_POST_ROUTING === "on"` (set in `deploy/convex-env/production.env`). With the flag off the old title/keyword + `email_routing` LLM route runs. Mail intake does **not** check the flag: it always uses post rules.

Per-TA addresses and alias fields:
- `users.routingEmail` (`<name>.jobs@career141.com`, edited in People, `PeopleAdmin.tsx`/`actions.ts` ~2795): used by `ta/intakeRouting.routeInbound` (address -> TA, headline -> that TA's live posts via `jobPosts.by_assignedTa`; auto-file only when `autoFile`: exact or keyword) and `src/lib/routing.ts classifyInbound`. Neither mail reader polls these addresses by default; they matter only through `intakeReceive` (needs `C141_TA_INTAKE=true`) or when someone also adds the address as a per-job inbox (unverified whether any live `.jobs@` box is polled).
- `jobPosts.routingEmailAlias` (`jobs+<slug>-<n>@career141.com`, generated in `src/data/store.ts` `addJobPost`) is stored and shown but no reader routes on it (unverified use). `aliasKeywords` and `previousTitles` are used by `scorePost`. `jobPosts.campaignCode` is made by `makeCampaignCode`.
- Per-job inboxes: `jobChannels.emailInbox` with `isEnabled` and channelType `email_campaign|email`; `scheduleEmailPolling` skips linkedin@/cv@/job@, de-duplicates, polls each unique inbox with `jobId` pinned (routing skipped, 15 s stagger, read flag, batch 15, no `mailboxLog` rows).
- `intakeItems` queue (`convex/ta/intake.ts`, `intakeReceive.ts`, `src/app/intake/`): only fed when `C141_TA_INTAKE=true` (and `.env.production.example` shows it commented out). `receiveCv` is idempotent on `fileHash`, routes with `routeInbound`, extracts text, AI-parses, and sets `ready` (parsed) or `needs_review`. A person admits or merges on `/intake`. `src/lib/sla.ts` raises the `cv_waiting` alert for `needs_review`, or no opening after >= 1 working day, assigned to the routed TA else all TA leads, link `/intake/<id>`. Whether the flag is on in production is unverified.
- Unmatched CVs list (`ta/unmatched.list`, `/intake` "Mailbox CVs that matched no job"): `ingestionLog` rows with `routingStatus: "unrouted"` in the last 14 days (`by_channel_time`, take 2000 per channel, max 200 rows) whose candidate has no application. Placed by `actions.placeUnmatched` (`opening.act`), lands in New CVs on the post.

### 5. LinkedIn applicant mail

`lib/mailParse.parseApplicationEmail` (pure, `tests/mailintake.test.ts`): `isLinkedIn` = sender at `*.linkedin.com`; applicant name from subject ("... from Nimal Perera", "Nimal Perera applied to ..."); public profile URL normalised to `https://www.linkedin.com/in/<slug>`; first non-ours email and an SL/international phone from the body; text capped at 20 000.

Both readers handle the no-CV applicant the same way: not our own mail, parse, `isLinkedIn && applicantName`, route, find/create the candidate (`candidateByLinkedin` then `createCandidate`), `placeOnPosts`. Poller: `holdLinkedInApplicant`, outcome `held`, requires post routing on. Intake: inline in `handleMessage`, `database` when no post matched. Notices without a named applicant are not applicants. Commits: a654565 (5 Oct), earlier 184d2ef (reply path).

Chrome extension touchpoint (not mail): `POST /api/extension/capture` (`src/app/api/extension/capture/route.ts`) and `GET /api/extension/openings` use `x-c141-token` (token stored as setting `extension.token`, `lib/extension.ts authorised`), only an active recruiter can be named (`extensionUser`), `can(user, "opening.sourcing")` per opening, Recruiter list pages refused (422), result is an Excel Tables link row, then `matchLink` against held CVs. Owned by /excel-tables.

### 6. Candidate replies (job@) and hand-off to /follow-up

Poller path: `emailAgent.checkAndRecordEmailReply` (mutation, so the check+insert is one transaction): maps the test mailbox sender back to the last outbound's candidate when `!outreachLive()` and `OUTREACH_TEST_EMAIL` matches; looks up `candidates.by_email` with the sender as written (no lower-casing); dedupes on `communications.by_externalMessageId` (the 2 Oct double-AI-reply bug); picks the newest application in a follow-up stage (`isFollowUpStage`) else `apps[0]`; inserts an inbound `communications` row (`deliveryStatus: "read"`); only if an application is in Follow-up it schedules `inboundExtraction.extractDetailsFromText` with `applicationId` and `subject` (the subject spots out-of-office replies). The body is passed raw; the extraction itself cuts it to the new words (`lib/mailParse.ts latestReplyText`). Returns `isFollowUpReply` (stage `follow_up`, or rejected for "Did not complete requirements within 7-day window"). That is where intake stops; the AI reading and any reply are /follow-up's (and go through `mayReplyTo` + do-not-contact guards).

Intake path (only if job@ is enabled in Settings): `replyingCandidate` + `recordInboundEmail` (dedupe by `sentAt === receivedAt` among inbound rows, sets `applications.lastCandidateReplyAt`), `applicationIdFrom` reads an `x-c141-candidatejobid` echo from the quoted body to pick the application, else the one last written to. Candidate mail with a CV attached goes down the CV branch instead.

### 7. shortlists@ and interviews@ (intake side)

shortlists@ (`kind: "shortlist"`, no grace). `handleShortlistMessage`:
1. Auto-replies/bounces (`isAutoReply`) -> `skipped`.
2. `attachRoundTransport` teaches the matching `reviewRounds` row its Graph thread ids; the TA's own tracked EOD copy (same subject, sender in the round, within 1 h, no In-Reply-To) -> `skipped` (22 Oct fix: it carried CVs and was filed as the Director's shortlist).
3. **No CV**: `decisions.processReply` reads the reply (rules `lib/shortlistReply.parseShortlistReply`, then the AI reader `aiReader.readDirectorReply` for set rebuilds) into a `shortlistDecisionReviews` row. Applied automatically only when `C141_SHORTLIST_AUTO_APPLY === "on"` and the read is clear (historical catch-up needs `applyClear`); otherwise `requireReview` and a `candidate_replied` notification "Shortlist reply needs review" to the set's sender and TA lead. Outcome `filed` (auto) or `held`.
4. **CVs attached**: sender must be a recorded Director (`shortlist.context`: `DIRECTOR_MAILBOXES` = joborders@ and shamra@ plus active People entries with the director role, both `email` and `routingEmail`); a house subject from anyone else is `held` unread. Director subject `CLIENT > POSITION > SET 01` (`parseHouseSubject`, `matchHouseSubject`) names the opening; a Director without the house subject, or a client, uses `inferOpening`. CVs go through `ingestCvs` with `shortlistCopy: true` (writes nothing onto a held person, 2 Oct), then `fileShortlist` -> `shortlist.moveShortlisted` (forward only via `shouldMove`; missing people get an application first; stage change by `executeStageTransition` as actor `shortlist-mail`, `skipAutoOutreach`, `decidedByReviewer`; `recordShortlistDecision`). Targets: director -> `director_shortlist`, client -> `client_review`. No opening decided -> `held` (a lead places them). Nothing is ever sent.

interviews@ (`kind: "interview"`, 20 min grace): `interviews.readOne` -> `handleInterviewMail` -> `lib/interviewMail.readInterviewMail`. Subject `CLIENT [INTERVIEW] > ROLE > CANDIDATE`; from `@career141.com` = invite (cancel when subject starts "Canceled:", a "Re:" from a TA is ignored); from anyone else = candidate reply (`readAnswer`: confirmed/declined/replied); "CAREER141 INTERVIEW" is the firm's own hiring and ignored. `findApplication`: by recipient address (invite) or sender (reply) at the client (`sameClient`), every record with that address, furthest application wins, ties by `roleOverlap`, ambiguous -> unmatched; no address -> name match only among that client's applications at Second Shortlist or later. `applyInterviewMail`: idempotent through a marker `interviews@ <last 40 chars of message id>` on `pipelineEvents.metadata`; an invite moves to `interview` (actor `interview-mail`) from `second_shortlist|director_shortlist|client_review`, or from `new_cvs|matched_candidates|ta_shortlist|follow_up` only when found by their own address; otherwise it writes an `interview_mail` pipeline event.

Pipeline-only catch-ups (dryRun required, run through the release pipeline `run_function`, 4-minute deadline then self-reschedule): `decisions.reconcileFromMailbox`, `decisions.reconcileRecent`, `interviews.reconcileInterviews`, `setCvs.reconcileSetCvs` (TA sets sent to joborders@/shortlists@ filed onto openings), `repair.removeMisfiled`/`restoreToNewCvs` (16-17 Sep trial cleanup, max 15 per call, confirm literals), `audit.directorDecisionReport` (read-only).

### 8. Webhook, subscriptions, health

- `convex/http.ts` `/api/graph-webhook` (a **Convex** HTTP route, not a Next route): GET echoes `validationToken`; POST drops every notification whose `clientState` differs from `MS_GRAPH_CLIENT_STATE` (all if unset), parses the mailbox from `users/<email>/mailFolders...`, skips "sanjeev", schedules `pollEmailInbox({inboxEmail})`, answers 202.
- `graphSubscriptions` table, `createMailSubscription({taEmail})` (3-day expiry), cron `renew-graph-subscriptions` daily 03:00 UTC -> `renewExpiringSubscriptions` (renews rows expiring within 24 h to now+3 days). Nothing in the repo calls `createMailSubscription` (unverified whether live rows exist); crons cover everything if it does not.
- Health: `pollEmailInbox` stamps `appSettings.mailPollOkAt/mailWaiting`; cron `check-mailboxes-read` (30 min) -> `checkMailboxesRead`: for linkedin@, cv@, job@, if the last OK run is >= `STALLED_AFTER_MS` (1 h) and not yet reported for this stall (`stalledUnreported`, `mailStallReportedAt`), inserts a `mailbox_stalled` notification "Problem: <inbox> has stopped" for each active admin/TA lead (`taRole` admin or ta_lead, or `role` admin); bell href `/settings?tab=mailboxes` (`ta/notifications.ts`). `inboxHealth` (query) feeds the panel with today's counts from `mailboxLog` since Colombo midnight (`now+5.5h`): outcome `reply`->replies, `no_cv`, `failed`, note matching /database/ -> toDatabase, else toJob.
- `emailBackfill*.ts` + cron `watchdog-mailbox-scan-healer` (5 min, `recoverStalledMailboxScans`) are historical bulk mailbox scans/recoveries (`recoverMailboxCVs`, `recoverCvFullInbox`); not part of daily intake.

## UI surface

| Where | What | Who | Action / route |
|---|---|---|---|
| `/settings?tab=mailboxes` (`src/app/settings/page.tsx`) | "Application inboxes" panel: linkedin@, cv@, job@ as Working / Catching up / Stopped, last read, backlog, today's counts (linkedin@ and cv@ only); red box when stalled | admin (`pageUser("user.manage")`) | reads `backend.inboxHealth` -> `communications/emailAgent:inboxHealth` |
| same | Mailbox cards (all non-`ta` rows): On/Off/Problem, last sync, totals Seen/Filed/Database/Already held/No CV(+skipped)/Failed; "Start reading"/"Stop reading"; "Sync now" when on; "Latest messages" table (50, outcome pill, opening and candidate links, note/error), queue counts, auto-refresh 20 s | admin | `setMailboxEnabled` -> `mailIntake/model:setEnabled`; `syncMailboxNow` -> `model:syncNow`; page calls `mailIntake/model:ensureMailboxes` then `status` |
| Bell | `mailbox_stalled` -> Settings | admins, TA leads | `ta/notifications.ts` |
| `/intake`, `/intake/[id]` | `intakeItems` queue (only with `C141_TA_INTAKE=true`), unmatched mailbox CVs with `PlaceUnmatched` | `intake.handle` (all but clients/viewers); unmatched list only for desk-wide roles with Convex | `actions.placeUnmatched`, `dropIntake` |
| Alerts | `cv_waiting` "CV waiting" | routed TA else TA leads | `src/lib/sla.ts` |
| Job post editor (`PostManager.tsx`) | saving a LinkedIn link says "Checking linkedin@ for the last 30 days..." | opening editors | `addJobPost`/`updatePost` -> `queueRescanForLink` |
| People page | `routingEmail` field | admin edits | `actions.ts` ~2795-2885 |
| `/shortlist-decisions` | decisions queue fed by shortlists@ | admin/director/ta_lead/ops | owned by /sets-shortlist |

Copy to fix if touched: `setMailboxEnabled`'s success message still says "The first sync imports the last 30 days", but since `setEnabled` sets `backfillFrom = now` only mail after switch-on is read (the header copy on the page is correct).

## Data

| Table | Fields / index | Written by |
|---|---|---|
| `mailIntakeMailboxes` | `mailbox`, `enabled`, `kind` (shared absent / `ta` / `shortlist` / `interview`), `taUserId`, `deltaLink`, `nextLink`, `backfillFrom`, `lastSyncAt`, `lastSyncError`, `totals{seen,filed,database,duplicate,noCv,skipped,failed}`; index `by_mailbox` | model.ts |
| `mailIntakeMessages` | `status` waiting -> processing -> extracting -> done; `outcome` filed/database/duplicate/no_cv/skipped/failed/held; `attempts`, `nextAttemptAt`, `openingIds`, `jobPostId`, `route`, `shortlist`, `candidateIds`, `cvUploadIds`, `conversationId`, `internetMessageId`, `inReplyTo`, `note`, `error`, `processedAt`; indexes `by_messageId`, `by_status_next`, `by_mailbox_received`, `by_receivedAt` | sync/process/model |
| `mailboxLog` | poller log: `mailbox`, `messageId`, `receivedAt` (ISO string), `subject`, `fromAddress`, `outcome` cv/held/no_cv/reply/failed, `note`, `loggedAt`; `by_mailbox_message`, `by_mailbox_received` | `logMailboxMessage` |
| `appSettings` (key `email_fetch_<inbox>`) | `lastEmailFetchTimestamp`, `mailLogSince`, `mailPollOkAt`, `mailStallReportedAt`, `mailWaiting`; `by_key` | poller |
| `graphSubscriptions` | `subscriptionId`, `taEmail`, `resource`, `expiresAt`, `createdAt` | `graphSubscriptionQueries` |
| `intakeItems` | `status` received/parsed/ready/needs_review/admitted/merged/rejected, route fields, `fileHash`; `by_status`, `by_fileHash`, `by_opening`, `by_routedTa`, `by_receivedAt`. Mapped in `convex/ta/model/tables.ts` (`intake: identity("intakeItems", [...])`) | `ta/intake.ts` |
| Read narrowly | `jobPosts` (`by_status`, `by_assignedTa`), `jobs`, `users` (`routingEmail`, `by_routingEmail`), `jobChannels`, `candidates` (`by_email`, `by_linkedinUrl`), `applications` (`by_candidateId`, `by_candidate_job`, `by_jobId`), `communications` (`by_externalMessageId`, `by_applicationId`), `cvUploads` (`by_fileHash`), `ingestionLog` (`by_channel_time`), `notifications`, `pipelineEvents`, `reviewRounds`, `shortlistDecisionReviews` | various |

The three `mailIntake*`/`mailboxLog` tables are not mapped in `convex/ta/model/tables.ts`; only `intakeItems` is. Adding a field to a mapped table means updating that mapping and `src/data/convex/map.ts` types.

## Backend wiring

Crons (`convex/crons.ts`; the whole `crons` registry is replaced by the `quiet` registry when `C141_DISABLE_CRONS=true`):

| Cron | Interval | Function | Gate |
|---|---|---|---|
| `poll-linkedin-inbox` | 13 min | `emailAgent.pollEmailInbox {inboxEmail: linkedin@}` | `C141_DISABLE_CRONS` off |
| `poll-cv-inbox` | 11 min | same, cv@ | same |
| `poll-jobs-sender-inbox` | 3 min | same, job@ | same |
| `poll-per-job-email-inboxes` | 17 min | `emailAgent.scheduleEmailPolling` | same |
| `check-mailboxes-read` | 30 min | `emailAgent.checkMailboxesRead` | same |
| `renew-graph-subscriptions` | daily 03:00 UTC | `graphSubscriptions.renewExpiringSubscriptions` | same |
| `watchdog-mailbox-scan-healer` | 5 min | `emailBackfillMutations.recoverStalledMailboxScans` | same |
| `ta-mail-intake-sync` | 5 min | `mailIntake.sync.syncAll` | `C141_MAIL_INTAKE=on`; **also runs on the quiet registry**; each mailbox needs `enabled` |
| `ta-mail-intake-process` | 1 min | `mailIntake.process.processReady` | same |

HTTP: Convex `/api/graph-webhook` GET/POST (`convex/http.ts`). Next routes: `/api/extension/capture`, `/api/extension/openings` (token, not Graph), `/api/inbound/review-reply` (secret `C141_INBOUND_REVIEW_SECRET`, >= 16 chars, else 404; a separate way to post a Director reply, with `matchReviewReply`; not used by the Graph readers).

Env flags (names only): `C141_MAIL_INTAKE`, `C141_DISABLE_CRONS`, `C141_POST_ROUTING`, `C141_TA_INTAKE`, `C141_SHORTLIST_AUTO_APPLY`, `C141_OUTBOUND_LOCK`, `C141_OUTBOUND_ALLOW_EMAILS`, `C141_OUTBOUND_ALLOW_PHONES`, `OUTREACH_LIVE`, `OUTREACH_TEST_EMAIL`, `EOD_TEST_EMAIL`, `LINKEDIN_SHARED_INBOX`, `MS_SENDER_EMAIL`, `OUTBOUND_EMAIL_SENDER`, `MS_GRAPH_CLIENT_STATE`, the `MS_*` tenant/client/secret trio, `C141_INBOUND_REVIEW_SECRET`. Kill switches: stop reading a mailbox in Settings (intake), unset/off `C141_MAIL_INTAKE` and release (intake crons), `C141_POST_ROUTING=off` + release (poller back to old routing; the pipeline only sets values, it never removes one), `C141_DISABLE_CRONS=true`. Whether `C141_MAIL_INTAKE` is on in production is unverified: `deploy/convex-env/staging.env` sets it, `production.env` does not.

External providers: Microsoft Graph (read, delta, search, sendMail, drafts, subscriptions), Cloudflare R2 (`storage.r2.uploadBufferToR2`), OpenRouter via `lib/llm` (`email_routing` task for the old route, `shortlist_reply` task for the Director reader), the CV extraction pipeline.

## Access and roles

- Settings > Mailboxes and every mailbox action: `user.manage` (admin only), checked in the page (`pageUser`) and in each server action (`authorize(formData, "user.manage")`). The Convex functions are `internal*`; the Next app reaches them with the admin key after its own authorisation (`src/data/convex/backend.ts`).
- `/intake`: `intake.handle`; placing an unmatched CV: `opening.act` on the target opening. Shortlist decisions page and confirm/ignore: admin, director, ta_lead, ops (`requireReviewer` in decisions.ts).
- Extension: shared token plus `extensionUser` (active TA/TA Support only) plus `can(user, "opening.sourcing")`.
- Stall notifications go to active users with `taRole` admin/ta_lead or `role` admin.
- Collision lock and workday gate do not apply to intake: system actors (`shortlist-mail`, `interview-mail`, `mail intake`) write with `bypassRoleCheck`. Anything that moves people from a mailbox is therefore a backend guard question, not a UI one.
- Backend guards on moves: `shouldMove` (forward only; rejected/dropped left for a person), `decidedByReviewer`, `skipAutoOutreach`, marker idempotency on interviews, Director-address check on shortlists@.

## Invariants and safety

1. **Intake sends nothing and changes no mailbox** (delta + Mail.Read only). Outbound only through `lib/graphMail.ts` -> `outreachSafety` -> `outboundGuard` (repo hard rule 4). Never set `OUTREACH_LIVE` in code/config.
2. **Two readers, one database**: the 20-minute `GRACE_MS` and file-hash reuse (`uploadByHash`, `checkFileHashExists`) stop a CV being created twice. Do not shorten the grace or change hashing in one reader without the other. Origin: f04349a/084acca (16-17 Sep).
3. **An existing application is never moved by intake**; only its post is recorded (ee9b983, 17 Sep: 196 applicants moved to Matched).
4. **No guessing across the desk**: shared mailboxes route only `exact`/`keyword`; a miss goes to the database where nothing is lost (4c88bc3, 22 Sep; "General Sales Manager" filed 169 applicants to "Sales Manager", f04349a).
5. **The poller's cursor must never pass an unhandled message** and must never list bodies (448b388 5 Oct 15-per-run cap; 1e6fdb7 / #261 23 Oct 64 MB out-of-memory). Keep listing to `id,isRead,receivedDateTime`, one `fetchFullMessage` per handled mail, `nextCursor` to the oldest waiting.
6. **Mail text passes through `wellFormed`/`cleanMessage`** before it is a Convex argument; a lone surrogate stopped linkedin@ for the same message on every run (4755ef8, 23 Oct). Each message is handled in its own try/catch.
7. **linkedin@ and cv@ are read by log, job@ by read flag**: a reply handled twice is answered twice (55b4bdd, 5 Oct). `markEmailAsRead` is skipped under the outbound lock so a test deployment never steals live mail.
8. **Reply recording is once per Graph message** (`by_externalMessageId`, 2 Oct) and one reply gets one AI answer (the poller must not also schedule `generateAndSendAiEmailReply`).
9. **A mailbox takes only mail after it was switched on** (`backfillFrom`; 16-17 Sep, 11,000 messages filed over a night on linkedin@).
10. **Shortlist mail**: only a recorded Director's CVs move people to Director Shortlist; the TA's own EOD copy is skipped; a no-CV reply needs review unless `C141_SHORTLIST_AUTO_APPLY=on` and clear; forward-only moves (75ac7c4, b558d23, 22 Oct; 53c03dc, 2 Oct; 7efccba, 23 Oct: 115 unread Director replies).
11. **Colombo day** for health counts (`inboxHealth`) and working-day ageing for `cv_waiting`.
12. **Never touch live from a laptop**; catch-up repairs are `dryRun` internal functions run by the pipeline (repo rules 1 and 5).

## Known quirks, gaps and unverified items

- The poller's CV filter (`pollEmailInbox`) and intake's `isCvAttachment` differ (size, rtf, inline).
- `renewExpiringSubscriptions` and `createMailSubscription` set expiry to 3 days (4320 min) while the code's own comment cites a Graph maximum of about 2.94 days (4230 min): renewals may be refused (unverified). No caller of `createMailSubscription` exists in the repo.
- `checkAndRecordEmailReply` looks up `candidates.by_email` with the sender as written (case-sensitive); intake lower-cases.
- If job@ is enabled in intake and the poller also reads it, a reply can be recorded twice: poller uses `sentAt: Date.now()` and `externalMessageId`, intake's `recordInboundEmail` dedupes only on `sentAt === receivedAt`; both may schedule `extractDetailsFromText` (unverified on live; job@'s enabled state is unverified).
- `recordMessages` gives interviews@ the 20-minute grace although nothing else reads it.
- Mailbox totals count `held` as `database`; `no_cv` and `skipped` are shown together as "No CV" on the card.
- `C141_TA_INTAKE` compares to the string `"true"`, other flags to `"on"`; `intakeItems`/`/intake` queue is probably empty on live (unverified).
- `jobPosts.routingEmailAlias` appears unused for routing (unverified).
- A comment in `convex/lib/postRouting.ts` points to `tests/postrouting.test.ts`, which does not exist (rules are covered by `mailintake`, `postfiling`, `routing` tests).
- The two Graph token helpers differ (throws vs null); a fix to one is not a fix to the other.
- `pollEmailInbox` skips any inbox containing "sanjeev" (hard-coded developer guard).
- `setMailboxEnabled` success copy is stale (see UI surface).
- No Settings button retries a failed message (`process.processMessage` is function-only); `claimOne` also re-claims `done`+`failed`.
- Production state of crons/mailboxes/subscriptions cannot be read from the repo: do not assert it; the owner must confirm.

## How to change it safely

Where to edit:

| Change | Edit | Also change |
|---|---|---|
| Routing rule (title, link, code, tie) | `convex/lib/postRouting.ts` | `src/lib/routing.ts` (headline rules copy), `convex/ta/intakeRouting.ts` only if it re-implements; tests `mailintake`, `postfiling`, `routing` |
| What counts as a CV / an application | `convex/lib/mailParse.ts` | poller's inline filter in `emailAgent.ts` (two places: `pollEmailInbox`, `rescanMailboxForLink`) |
| New mailbox kind | `mailIntake/model.ts` (`ensureMailboxes`, grace in `recordMessages`, `status` order), schema `kind` union, `process.handleMessage` branch, `src/data/convex/backend.ts` `MailIntakeStatus.kind`, Settings card copy | mailbox enable is per mailbox in Settings; document the Graph permission |
| Poller batch/cursor | `convex/lib/mailCursor.ts` (pure) | `tests/mailcursor.test.ts`; keep `emailAgent.ts` call sites |
| Throughput | `PER_RUN`, cron interval in `process.ts`/`crons.ts` | mind Graph limits and the 15 min lease |
| New outcome | `finishMessage` validator, schema union, `TOTAL_KEY`, `OUTCOME` map in `settings/page.tsx`, `backend.ts` type | |
| Health/stall rule | `mailCursor.STALLED_AFTER_MS`/`stalledUnreported`, `emailAgent.checkMailboxesRead`, `WATCHED_MAILBOXES` (same constant list also in `scheduleEmailPolling`'s `SYSTEM_INBOXES`) | Settings panel copy |
| Interview/shortlist mail reading | `lib/interviewMail.ts`, `lib/shortlistMail.ts`, `lib/shortlistReply.ts`, then `mailIntake/{interviews,decisions,shortlist}.ts` | /sets-shortlist for semantics |
| Data fix on live | a new internal function with `dryRun` (see `repair.ts`, `reconcile*`), run by the pipeline | never `convex run` from a laptop |

Tests (real files in `tests/`): `mailintake.test.ts`, `mailcursor.test.ts`, `postfiling.test.ts`, `routing.test.ts`, `graphmail.test.ts`, `interviewmail.test.ts`, `interviews.test.ts`, `shortlistmail.test.ts`, `shortlistreply.test.ts`, `shortlistcopy.test.ts`, `replyrouting.test.ts`, `intake.test.ts`, `firstemail.test.ts`, `dailyEmails.test.ts`. Pure logic gets a case in the matching file in the same style (`eq(label, got, want)`); run one with `npm test -- mailintake` (filter on file name), all with `npm test`.

Commands before pushing: `npm test`, `npx tsc --noEmit -p .`, `npx tsc --noEmit -p convex`. Read `node_modules/next/dist/docs/` before touching any Next route or server action here (this Next.js has breaking changes).

Pre-merge checklist: pure logic has a test; any new flag is documented and defaults safe; nothing marks mail read, moves it or replies from `mailIntake/*`; new outbound goes through `sendFollowUpMail`; an existing application is not moved; Convex args pass through `wellFormed` where mail text is passed on; both readers still agree on dedupe; no secrets or addresses beyond what the repo already holds; no live call made.

Repo rules that apply: never run `convex deploy/run/import/env set` against live; work on a branch and merge by PR; outbound only through `convex/lib/outreachSafety.ts` and `convex/lib/outboundGuard.ts`; data changes are migrations with `dryRun` run by the pipeline. Tell the owner, and do not decide, anything that changes what users see (Settings copy, alerts, which stage a mail moves a person to) or what is sent to candidates (reply handling, follow-up hand-off, test-mode recipients).

## History

- 2026-10-29: CV failure filing preserves applicants and uses `createApplication(skipScoring:true)`; `pipeline/postFiling.filePosts(score:false)` propagates that guard to every additional opening. No implicit scoring, reactivation or stage advancement for an unread upload; see /cv-extraction.

- 2026-09-16 `084acca` read-only Graph mail intake for linkedin@, cv@, job@: delta sync every 5 min, 20-min grace, Settings > Mailboxes. `9df2be6`: follow-ups sent from the assigned TA's mailbox; EOD via Graph. Trial on staging read 11,207 messages.
- 2026-09-17 `f04349a` file only new mail (`backfillFrom` = switch-on), titles match whole/start/head only (169 wrongly filed to "Sales Manager"). `ee9b983` leave existing applications where they are. `50d9039`, `88136b6` clean up the trial (`repair.ts`).
- 2026-09-18 `184d2ef` a candidate's reply on job@ is read, not closed as "No CV"; `7ca148c` the assistant's answer is not cancelled by the advance it causes.
- 2026-09-22 `4c88bc3` shared-mailbox CVs routed by job post, never by guess (`C141_POST_ROUTING`); `18ec7fb` LinkedIn Recruiter project number routing.
- 2026-09-24 `442a01f` unmatched mailbox CVs list, posts without a link warn; `7fa351a` `EOD_TEST_EMAIL`.
- 2026-09-27 `504b1f4` scoops mailed to TAs read; 2026-09-29 `4e42d2b` TA mailboxes no longer read (scoops uploaded); `8698590` shortlists@ reader; `722a24a` EOD to joborders@ with desk copies.
- 2026-09-30 `7c562af`, `322bb9b` test EOD still reaches the desk; lock-held recipients shown on screen.
- 2026-10-02 `53c03dc` CV at shortlists@ writes nothing onto a held person; `e5d6225` webhook requires `clientState` (`MS_GRAPH_CLIENT_STATE`), extension limited to active recruiters; `checkAndRecordEmailReply` dedupes on Graph message id.
- 2026-10-05 `448b388` burst of applications no longer loses all but 15 (cursor moved past unhandled mail; `lib/mailCursor.ts`). `55b4bdd` linkedin@/cv@ read by `mailboxLog`, not the read flag (mail opened in Outlook was skipped). `a654565` LinkedIn applicant with no CV held and placed. `3e1909f` own-link applications reach on-hold/paused jobs. `f4ccc04c` saving a LinkedIn link re-reads linkedin@ 30 days. `4c1b9e6` extension refuses Recruiter list pages.
- 2026-10-22 `75ac7c4`, `b558d23` Director decisions read correctly; joborders@ and shamra@ trusted as Director; TA's EOD copy no longer filed as Director shortlist.
- 2026-10-23 `1e6fdb7` (PR #261 `548aef6`) linkedin@ unread 5-23 Oct: listing with bodies exceeded the 64 MB action limit; fix lists ids only, 40 per run, cursor to oldest waiting, adds `check-mailboxes-read`. `4755ef8` half-emoji (lone surrogate) stopped the same message every run (`wellFormed`). `dac2fd1` application-inbox health panel. `0362628`, `7efccba` catch-up of 115 unread Director replies in shortlists@ (385 emails 6-23 Oct). `86d1414` AI reader; `ac8dd86` client replies to Client shortlist.
- 2026-10-24 `a6118cc` interviews@ invitations move candidates to Interview; `7af4748`, `9e81d78` found by own address, furthest application, DeltaSpike; `16f977e`, `ba4ef75`, `b53590c`, `5103067` catch-up pacing (4-minute deadline, continue in fresh run).
- 2026-10-26 `5ed2893`, `f7aaab4`, `2b9c52f`, `5bd92af` `setCvs.ts`: CVs a TA put forward by email are filed onto their opening.

<!-- skill-meta
verified-commit: 8bb1c684
verified-hash: b312bddb383565030f04c06fa2145ebcf6f1f04f
verified-date: 2026-10-29
sources:
  convex/mailIntake/**
  convex/communications/emailAgent.ts
  convex/communications/graphEmail.ts
  convex/communications/graphEmailMutations.ts
  convex/communications/graphSubscriptions.ts
  convex/communications/graphSubscriptionQueries.ts
  convex/lib/graphClient.ts
  convex/lib/graphMail.ts
  convex/lib/mailCursor.ts
  convex/lib/mailParse.ts
  convex/lib/postRouting.ts
  convex/lib/interviewMail.ts
  convex/lib/shortlistMail.ts
  convex/lib/shortlistReply.ts
  convex/lib/outreachSafety.ts
  convex/lib/outboundGuard.ts
  convex/pipeline/postFiling.ts
  convex/ta/intake.ts
  convex/ta/intakeReceive.ts
  convex/ta/intakeRouting.ts
  convex/ta/unmatched.ts
  convex/crons.ts
  convex/http.ts
  src/lib/routing.ts
  src/lib/extension.ts
  src/lib/sla.ts
  src/app/settings/page.tsx
  src/app/intake/**
  src/app/api/extension/**
  src/app/api/inbound/review-reply/route.ts
  src/data/convex/backend.ts
  tests/mailintake.test.ts
  tests/mailcursor.test.ts
  tests/postfiling.test.ts
  tests/routing.test.ts
  tests/graphmail.test.ts
  tests/interviewmail.test.ts
  tests/interviews.test.ts
  deploy/convex-env/production.env
-->
