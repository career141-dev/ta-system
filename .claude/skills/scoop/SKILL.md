---
name: scoop
description: Scoops = CVs a Director, TA Lead or Ops person sent a TA by email or chat, which the TA uploads on the opening's Scoops tab (PDF/Word, 10 MB, 10 at a time, optional "Sent by"), read by the CV platform, flagged scoopReceivedAt/scoopFromUserId, shortlisted from the list and counted in the EOD SCOOP column once sent to the Director. Aliases - scoop upload, scoops tab, lead-sent CVs, SCOOP column. Use when changing, debugging or extending Scoops.
---

# Scoops

## Scope and boundaries

In this skill: the Scoops tab (`/openings/[id]/scoops`), the upload component and "Sent by" picker, the upload API route, the Convex scoop mutations, the scoop flag on `applications`, how a scoop is read (the shared CV reading queue, urgent lane), the `Processing` badge, how scoops are counted in the End-of-day SCOOP column, the support-TA "scoop credit" fields, and the history of the abandoned TA-mailbox design.

Neighbours (do not duplicate, link):
- /follow-up - what happens after the TA presses Shortlist (claim, set number, move to Follow-up). Scoops only flags the application; Shortlist does the claim.
- /sets-shortlist - sets (five CVs per TA per opening), the Shortlist claim itself, `claimForTa`.
- /cv-extraction - the reading pipeline, `cvExtraction.ts`, the reading queue internals, failures and retries.
- /eod-email - the End-of-day email composer and the Director send; this skill only documents the SCOOP column rule.
- /workday - `assertWorkdayScope` semantics.
- /email-intake - shared mailboxes (cv@, linkedin@, job@, shortlists@, interviews@). Per-TA mailbox rows still exist in the schema but are switched off.
- /database-search, /excel-tables, /openings, /strategy-planner, /voice-agent - unrelated except as noted below.
- HH (headhunted) CV upload (`convex/ta/hhUpload.ts`, `src/app/api/hh/upload/route.ts`) is the sibling that Scoops was modelled on; same queue, same progress translator. Only compared here.

**Terminology trap.** Owners sometimes say "scoops" when they mean sets (the five-CV batches, `setNumber`, the SETS cell of the EOD sheet). In code, "scoop" is only the lead-sent CV described here. Also, `taSourcingChannel`/`sourcingChannel` = `"SCOOP"` is a different thing: the Guidelines tab's code for a *database pick* (TBR, "Database - shortlisted and reviewed"). It is not a Scoops-tab upload and `effortBucket` deliberately treats it as no column. Four different "scoop" markers exist (see Data).

## How it works now

### Flow 1 - Upload (TA, Scoops tab)

1. Trigger: the TA opens `/openings/[id]/scoops`, picks "Sent by" (optional), clicks "Choose CVs" or drops files on the dashed zone. Component: `src/components/ScoopUpload.tsx` (`send()`).
2. Client limits: `MAX_FILES = 10` per drop (the rest are cut; message "Up to 10 CVs at a time - the first 10 are being added."); uploads run with concurrency `Math.min(3, files)` via `Promise.all` of `uploadNext` workers. One `FormData` per file: `openingId`, `file`, `fromUserId` (only if chosen). `accept` = `.pdf,.doc,.docx` + MIME types.
3. POST `/api/scoops/upload` (`src/app/api/scoops/upload/route.ts` `POST`). Checks in order:
   - `content-length` > 10 MB + 64 KB -> 413 "That file is over 10 MB. Save a smaller PDF and try again." (before the body is read).
   - No session (`currentUser()`) -> 401 "Your session has ended. Sign in again."
   - `formData()` unreadable -> 400 "The upload could not be read. Try again."
   - Missing/empty file -> "Choose a CV file first."; `file.size > MAX_BYTES (10*1024*1024)` -> "<name> is over 10 MB..."; type not in `TYPES` (pdf, msword, docx MIME) and name not `.pdf/.doc/.docx` -> "<name> is not a PDF or a Word document."
   - `mayUpload(openingId)`: `primeStore({openingId})`, opening must exist (404 "That opening no longer exists. Reload the page."), then `allows(user, "opening.act", { openingId, assignment })` else 403 "You are not on this opening, so you cannot add scoops to it."
   - `!isConvex()` (local file-store build) -> 501 "CV files are read by the candidate database, which this local build is not connected to." Scoops cannot be exercised on the pure seed store.
4. Store the file: `convexMutation("ta/cv:uploadUrl", {actorId})` -> POST the bytes to `internalUploadUrl(url)` (503-style failure -> 502 "<name> could not be stored (<status>). Try again.") -> `{storageId}`.
5. Queue: `convexMutation("ta/scoopUpload:queue", {actorId, openingId, fromUserId, storageId, fileName, fileSize, fileType})` (`convex/ta/scoopUpload.ts` `queue`, `internalMutation`):
   - `requireActor`; job must exist ("That opening no longer exists.").
   - `assertJobAccess(ctx, user, job._id, WORKS_THE_DESK)` - `WORKS_THE_DESK = ["primary_recruiter","supporting_recruiter","director"]` in `convex/ta/guard.ts`. `admin` and `ta_manager` bypass; others need a `jobAssignments` row, or presence in `job.assignedTaIds`/`job.taLeadId`. Else "You are not assigned to this opening. Ask the TA lead to add you to its team."
   - `assertWorkdayScope(ctx, user, job._id)` (`convex/lib/workdayScope.ts`): only for mapped roles `ta`/`ta_support`. If they have a workday today (not finished, or closed by EOD) the job must be in it ("Add this assigned position to your workday first."); else, if they ever had a workday, "Start your workday before continuing recruitment work."; accounts with no workday history pass.
   - If `fromUserId` given: `normalizeId("users")`, must exist and `isScoopSender(user)` else "Scoops come from the Director, a TA Lead or Ops."
   - Inserts `cvUploads` { storageId, `storageProvider:"convex"`, fileName/Size/Type, `source:"Scoop"`, `assignToJob: job._id`, `uploadedBy`, `scoopedBy: user._id`, optional `scoopFromUserId`, `status:"uploaded"`, `processingStage:"queued"`, `queuedAt`, `stageChangedAt` }.
   - Inserts `ingestionLog` { jobId, `channelType:"manual_upload"`, `routingStatus:"routed"`, `cvFileId`, `stage:"queued"`, `candidateName: fileName`, `rawSender: user._id` } (cast `as never`).
   - `enqueueExtraction(ctx, cvUploadId, { storageId, storageProvider:"convex", fileType, sourceChannel: SCOOP_CHANNEL ("scoop"), uploadedBy, cvUploadId, logId })` from `convex/cvs/cvUploads.ts`. Returns `{cvUploadId}`.
6. Route returns `{ok:true, id, fileName}`; any exception -> `safeErrorMessage(e, "<name> could not be queued. Try again.")` with status 500; the raw error is `console.warn("[scoop upload]")`.
7. Client sets the row to `reading` / stage `queued` / label "Waiting for a CV reader" / progress 8, and starts polling.

Note the route's check is `opening.act` *without* `ownerTaId`, so the collision lock never fires at upload time; the lock bites at Shortlist.

### Flow 2 - Reading and filing (backend, automatic)

1. `enqueueExtraction` (`convex/cvs/cvUploads.ts`): if the upload is not already in `cvExtractionQueue` (`inExtractionQueue`, index `by_cvUploadId`), insert `{cvUploadId, args, urgent:true}` - `isUrgentUpload` (`convex/lib/extractionQueue.ts`) is true when `headhuntedBy || scoopedBy` is set. Then `startNextTurns`.
2. `startNextTurns`: held slots = rows with `startedAt` (index `by_startedAt`, `take(100)`); `planTurns` (pure, in `extractionQueue.ts`) computes lapsed slots (held longer than `EXTRACTION_LEASE_MS = 10 min`, deleted), `free = MAX_CONCURRENT_EXTRACTIONS (3) - live`, `backgroundFree = min(free, BACKGROUND_SLOTS (2) - liveBackground)`. Urgent waiting rows (index `by_startedAt_urgent`, `startedAt` undefined, `urgent` true) start first, from all `free`; background fills what is left. Each started row gets `startedAt: now` and `scheduler.runAfter(0, internal.cvs.cvExtraction.processCvExtraction, {...row.args, leaseId})`. A scoop therefore starts at once unless three TA uploads are already being read.
3. `processCvExtraction` (`convex/cvs/cvExtraction.ts`, see /cv-extraction) reads the CV, finds or creates the candidate, runs `createApplication` against `cvUpload.assignToJob`. After the application exists it calls `internal.ta.scoopUpload.fileScoop` at three sites: (a) the candidate already existed (duplicate-candidate branch, ~line 1204), (b) the normal new-candidate branch (~1565), (c) the "preserved despite extraction error" fallback (~1684, `score: false`). The guard everywhere is `cvUpload?.scoopedBy`.
4. `fileScoop` (`convex/ta/scoopUpload.ts`, `internalMutation`, args `{cvUploadId, candidateId, jobId}`): returns `{handled:false}` if the upload has no `scoopedBy`, job id does not normalise, candidate (followed through `mergedInto`) or application (`by_candidateId` + `jobId` filter) is missing. Otherwise `scoopFlag(app, Date.now(), upload.scoopFromUserId ?? null)` (`convex/lib/scoopMail.ts`) and patch the application. It does NOT set `ownerTaId`, stage or set number - on purpose: if the owner were set, the TA's own Shortlist would see "already mine" and skip the move to Follow-up. If `app.ownerTaId` exists and differs from `upload.scoopedBy`, it writes `cvUploads.routeNote = "Already shortlisted on this opening by <name>."`; the application is still flagged.

`scoopFlag` rules: set `scoopReceivedAt = now` only if empty; set `scoopFromUserId` only if the application has none and one is given; returns `null` (no patch) if nothing changes. So re-uploading a known scoop never moves the date or changes the sender, but fills a blank sender.

State after a good upload: application in the "new CVs" stage (`currentStage` `new_cvs`; the app's `toTaStage` calls it `new_cv`), `ownerTaId` empty (unless somebody already owned it), `scoopReceivedAt` set. The person sits in the Scoops list as "Not shortlisted yet".

### Flow 3 - Progress panel (poll)

- `ScoopUpload` polls every 4 s (`setInterval(tick, 4000)`, plus one immediate call) while any row is `reading` with an id: GET `/api/scoops/upload?openingId=&ids=` (`GET` in the route; ids capped at 20; same `mayUpload` gate; `!isConvex()` or no ids -> `{ok:true, files:[]}`).
- `ta/scoopUpload:status` (`internalQuery`, `optionalActor`, no job-access check of its own; first 20 ids): per id returns `missing` ("That upload no longer exists.") or `uploadProgress(upload, businessState)` from `convex/lib/cvUploadProgress.ts` plus `fileName`, candidate `name`, `applicationId`, `stage` (via `toTaStage`) and `note` (`errorMessage ?? "The CV could not be read."` if failed, else `routeNote`).
- `businessState` = `app?.scoopReceivedAt ? (upload.routeNote ? "held" : "done") : null`. `uploadProgress` only honours it when the upload has no `processingStage` (legacy) or `stage === "completed"`; the application row can exist a few mutations before filing ends.
- UI states and wording (`LINE` map): `uploading` "Uploading...", `reading` (label from step map), `done` "Added as a scoop", `held` "Not added" (label from progress: "Needs attention"), `failed` "Could not be read", `missing` "Not found".
- Step map in `cvUploadProgress.ts` (`STEPS`): queued 8% / 90 s estimate, downloading 16 / 75, extracting_text 28 / 65, ocr 38 / 150, structuring 62 / 60, validating 78 / 25, saving 88 / 15, filing 95 / 10, completed 100. `FAILED` statuses: failed, failed_retry, extraction_failed_permanent, cancelled, paused, needs_review. Percentages are phases completed, not a timer.
- When a row first reaches `done`/`held`, the client calls `router.refresh()`; the route also calls `resetStore()` + `revalidatePath("/openings/<id>", "layout")` on any `done`/`held` result so the next render reads the flag (the web app caches a Convex snapshot).

### Flow 4 - Queue persistence and the Processing badge (client only)

- `ScoopUpload` mirrors its `rows` to `localStorage["scoop-upload-queue:<openingId>"]` (removed when empty) and dispatches `window` event `scoop-upload-sync` with `{openingId}` on every change.
- On mount it restores rows, drops those with `createdAt` older than 24 h, and marks any `uploading` row with no server id as `failed` ("Upload was interrupted before reaching the server. Please upload again."). Restored `done`/`held` ids are put in `seenDone` so no spurious refresh.
- "Clear finished" keeps only `uploading`/`reading` rows.
- `src/components/ProjectSidebar.tsx` listens to `storage` and `scoop-upload-sync` and shows the pulsing `Processing` pill on the Scoops rail link while any stored row is `uploading` or `reading`. It is per browser, not a server fact.

### Flow 5 - Shortlisting a scoop

On the Scoops tab `CandidateList` is rendered with `claimable` and `basePath=/openings/<id>/scoops`. A row is claimable only if `!a.ownerTaId`. "Shortlist selected" posts `confirmShortlist` (`src/app/actions.ts`): per id, `can(user, "opening.act", {..., ownerTaId})` (skipped if another TA owns it), then `backend.shortlist` -> `ta/applications:shortlist` -> `claimForTa` (`convex/ta/applications.ts`): refuses `{ok:false, ownerTaId}` if another TA owns it; sets `ownerTaId`, `shortlistedAt`, `setNumber` (via `nextSetNumber`), `isAddOn` on an Add-on working day, `backupForApplicationId` if someone is at interview/offer. Result message: "N shortlisted and sent to Follow-up." with skipped/failed suffixes. See /sets-shortlist and /follow-up.

### Flow 6 - EOD SCOOP column

- `effortBucket(app, headhunted)` in `src/lib/eod.ts` returns, in order: `backUp` if `backupForApplicationId`; `scoop` if `app.scoopFrom || app.scoopReceivedAt`; `addOns` if `isAddOn`; else `cvSource(...)` (`src/lib/cvSource.ts`; `sourcingChannel === "SCOOP"` -> "database" -> no column). A scoop therefore stays a scoop on an Add-on day. Order is backup > scoop > add-on > source.
- Only CVs sent to the Director today are counted: `sentToDirectorToday(openingId, taId, since, workLocationId)` = applications in today's (Colombo day start, `colomboDayStart`) `director` review rounds sent by this TA (excluding `recoveryReopenedAt`) plus people waiting in tonight's Director email (`shortlistRows(...,"director")`). `effortRow` loops them, `count.scoop++` per scoop bucket, `scoop: count.scoop || null` (blank not 0). Six scoops uploaded, one sent to the Director -> SCOOP 1 (`tests/eodeffort.test.ts` "six mailed in").
- The TA can overtype every EOD cell (`effortFromForm`, `form.set("effort_scoop")`); `MANUAL_EFFORT` is an empty set, so nothing is forced manual. `EffortSheet.tsx` explains: "SCOOP if you uploaded it under Scoops (add any that came on WhatsApp)". WhatsApp scoops the system never saw are added by typing.
- `dayTotal` (`src/lib/eod-format.ts`) sums `CV_COLUMNS = ["da","scoop","l","post","addOns","backUp"]`; the SETS cell reads "<set> - <total> CVs".

### Flow 7 - Support-TA "scoop credit" (older, separate mechanism)

`ta/cv:attach` (`convex/ta/cv.ts`, called by `src/app/api/cv/upload/route.ts`) replaces/attaches a CV file on an existing application. If `app.ownerTaId` is set and is not the uploader, it patches `applications.scoopByUserId = uploader`, `scoopAt = now` (plan 6.4, 21 Sep: a support TA's upload credited to them, owner unchanged). These are projected (`convex/ta/model/projections.ts` `scoopBy`, `scoopAt`) and mapped (`src/data/convex/map.ts`), typed on `Application` (`src/data/types.ts`), but nothing in `src` reads `scoopBy`/`scoopAt` to compute a column (verified by grep: only types, map and projections). Treat as stored-but-unused credit.

### Flow 8 - Mailbox history (what replaced what)

See History. Today: `mailIntake/sync.ts` `syncMailbox` returns `{recorded:0,done:true}` for `box.kind === "ta"`; `mailIntake/process.ts` closes any leftover message of a `ta` mailbox with outcome `skipped` and note "A TA's mailbox is not read any more - scoops are uploaded on the opening's Scoops page."; `mailIntake/model.ts` seeding switches off any `kind:"ta"` mailbox that is enabled; Settings -> Mailboxes filters `m.kind !== "ta"` out of the cards. Schema leftovers: `mailIntakeMessages.scoopTaId`, `scoopFromUserId` (`convex/schema.ts` ~3349, `convex/mailIntake/model.ts` ~397).

## UI surface

| Place | What | Server side |
|---|---|---|
| Rail "Scoops" link (`ProjectSidebar.tsx`, right under Pipeline) | shown if `canSeeSourcing`; `Processing` pulse from localStorage | none |
| Mobile section list (`src/lib/mobile/openings.ts`, `openingsTypes.ts`) | `"scoops"` section id pushed when `seat.canSeeSourcing` | check how the mobile app renders it (unverified, no mobile page in `src/app`) |
| `/openings/[id]/scoops` (`page.tsx`) | H1 "Scoops", `ProjectHeader`, `StatRow` ("Scoops on this opening", "Not shortlisted yet"), `ScoopUpload` if `canAct`, `CandidateList` | `requireSourcingSeat(id)` (redirects to `/unavailable` unless `seatFor(...).canSeeSourcing`) |
| `ScoopUpload` panel | "Upload scoops", "Sent by" select (options "Not said" + senders), drop zone "Choose CVs / or drop them here", "Uploads & extractions" list with spinner/progress bar/elapsed/estimate, "Clear finished" | `POST/GET /api/scoops/upload` |
| `CandidateList` (title "Scoops", `claimable`) | per-row Shortlist, bulk "Shortlist selected", bulk stage controls, "Remove from this job" for `opening.manage`, download CVs, filters via URL (`applyFilters`) | `confirmShortlist`, `removeApplications` |
| Settings -> Mailboxes (`src/app/settings/page.tsx`) | heading "Scoops and shortlists mailboxes" (name is stale; TA mailbox cards are filtered out) | admin only |
| EOD composer (`EffortSheet.tsx`) | SCOOP column | `sendEod`, see /eod-email |
| Platform guide / assistant (`src/lib/platformGuide.ts`, `src/lib/deskAssistant.ts`) | text: "upload CVs a director, lead or ops person sent you, with who sent them. Up to 10 at once."; `deskAssistant` whitelists the path `/openings/<id>/scoops` | none |

Visibility: the list is `repo.applications(id).filter(a => a.scoopReceivedAt || a.scoopFrom)` - every scoop ever flagged on the opening, all TAs', not only today's; `applyFilters(..., user.id)` can narrow to mine. Upload panel only if `allows(user,"opening.act",{openingId, assignment})`. The "Sent by" options come from `repo.users()` active with *mapped* role `director`, `ta_lead` or `ops` (page.tsx), while the backend validates with `isScoopSender` (raw role/taRole). Keep both lists in step.

## Data

- `cvUploads` (schema ~lines 800-880): `source:"Scoop"`, `scoopedBy: Id<users>` (the uploading TA; this is the trigger for `fileScoop` and for `isUrgentUpload`), `scoopFromUserId` (the sending lead), `assignToJob`, `uploadedBy`, `status` ("uploaded" at insert), `processingStage` (queued, downloading, extracting_text, ocr, structuring, validating, saving, filing, completed, needs_review, failed), `queuedAt`, `stageChangedAt`, `completedAt`, `processingStartedAt`, `errorMessage`, `routeNote` (set by `fileScoop` when another TA owns the person, `held` in the UI), `candidateId`.
- `ingestionLog` row per upload (`channelType:"manual_upload"`, stage updated by extraction).
- `cvExtractionQueue` (`cvUploadId`, `args`, `startedAt`, `urgent`; indexes `by_cvUploadId`, `by_startedAt`, `by_startedAt_urgent`).
- `applications` (schema ~1305-1325): `scoopReceivedAt` (number, the flag the EOD and the list read), `scoopFromUserId` (`v.id("users")`), plus the credit pair `scoopByUserId` (string), `scoopAt`. Reads use index `by_candidateId` then filter by `jobId`. Projection names: `scoopReceivedAt`, `scoopFrom` (from `scoopFromUserId`), `scoopBy`, `scoopAt` (`convex/ta/model/projections.ts`, `src/data/convex/map.ts`, types in `src/data/types.ts`).
- `taSourcingChannel` / `sourcingChannel` `"SCOOP"` = database pick, NOT this feature. `convex/ta/model/tables.ts` maps `SCOOP: "manual_upload"`; `convex/ta/backfill.ts` and `convex/ta/matching.ts` (`taSourcingChannel:"SCOOP"`) set it for database picks; `src/data/seed.ts` and `src/data/store.ts` use it as the default for non-intake origins. Pages `database/page.tsx` and `linkedin-job/page.tsx` and `lib/reporting.ts`, `lib/sla.ts` exclude it from applicant counts.
- `notifications.type` includes `scoop_received` (declared in `convex/schema.ts` ~2205 and `convex/ta/notifications.ts`). No emitter exists anywhere in `convex` or `src` (grep). Nobody is notified when a scoop lands.
- `mailIntakeMessages.scoopTaId/scoopFromUserId`, `mailIntakeMailboxes.kind:"ta"`: legacy, unused.
- Browser: `localStorage["scoop-upload-queue:<openingId>"]`, event `scoop-upload-sync`.

## Backend wiring

Convex functions (all `internal*`; the web app calls them through `convexMutation`/`convexQuery` in `src/lib/convexServer.ts`, so there is no public Convex surface for scoops):
- `ta/scoopUpload:queue` (internalMutation), `ta/scoopUpload:fileScoop` (internalMutation, called from `cvExtraction.processCvExtraction`), `ta/scoopUpload:status` (internalQuery), `SCOOP_CHANNEL = "scoop"`.
- `ta/cv:uploadUrl` (generates the storage upload URL; shared with HH).
- `cvs/cvUploads:enqueueExtraction` (helper), `enterExtractionQueue`, `leaveExtractionQueue`, `holdsExtractionSlot`, `startWaitingExtractions`.
- Pure helpers: `convex/lib/scoopMail.ts` (`isScoopSender`, `scoopFlag`), `convex/lib/extractionQueue.ts` (`planTurns`, `isUrgentUpload`, constants), `convex/lib/cvUploadProgress.ts` (`uploadProgress`).

Crons: `process-unextracted-cv-queue` (every 2 min, `crons.ts`; also registered as `ta-cv-queue` under `C141_TA_MAINTENANCE=on` via `addMaintenance`) runs `processUnextractedQueueCron`, which first calls `startWaitingExtractions` (start missed turns, take back lapsed slots) then claims up to 10 `uploaded` rows. `recover-stuck-uploads` (29 min; `ta-cv-stuck-uploads` under maintenance) revives stuck uploads. Whether the 2-minute `claimUploadedBatch` can pick up a scoop upload that is still `status:"uploaded"` while it waits in `cvExtractionQueue` - `enqueueExtraction` dedups by `cvUploadId`, but verify before relying on it (unverified). `C141_DISABLE_CRONS=true` switches the main cron registry off (dev/staging).

Next API routes: `src/app/api/scoops/upload/route.ts` (POST upload, GET status), `src/app/api/cv/upload/route.ts` (support-TA credit, via `ta/cv:attach`). HH sibling: `src/app/api/hh/upload/route.ts`.

Env flags: `C141_DISABLE_CRONS`, `C141_TA_MAINTENANCE`, `C141_MAIL_INTAKE` (only matters for shared mailboxes now). No scoop-specific flag or kill switch exists. Outreach flags (`OUTREACH_LIVE`) are not involved: a scoop sends nothing to the candidate. Providers: the CV reading model via OpenRouter (see /cv-extraction; only the model the deployment serves), Convex `_storage`.

## Access and roles

- Page: any seat with `canSeeSourcing` (`seatFor` in `src/lib/visibility.ts`: unscoped roles - director, ta_lead, ops, admin - always; a scoped TA needs an assignment other than `client_contact` or a strategy assignment; viewers read only; client seats redirected to `/unavailable`).
- Upload UI and route: `opening.act` (`src/lib/auth.ts`): desk-wide (admin, director, ta_lead, ops, via `isDeskWide`) may always; others need an assignment that is not `client_contact`; denial text "You are not on this opening." / "A client seat reads its shortlist; it does not work the pipeline.". The `ownerTaId` branch of the lock is not evaluated at upload.
- Backend: `assertJobAccess(..., WORKS_THE_DESK)` (admin and ta_manager bypass; assigned primary/supporting recruiter or director; else job `assignedTaIds` or `taLeadId`) and `assertWorkdayScope` (TA and TA Support only). Note the client check lets a lead/ops without an assignment pass `opening.act`, but the backend then needs `ta_manager`/`admin` bypass or an assignment - a plain ops or senior user without a `jobAssignments` row will see the panel and be refused by the backend ("You are not assigned to this opening...") (inferred from the two guards, unverified by running).
- Sender validity (`isScoopSender`): inactive -> false; explicit `taRole` wins (only `director`, `ta_lead`, `ops`); else raw role in `director`, `ops`, `ta_manager`, `senior_ta`. Another TA is never a valid sender (the desk, 27 Sep).
- Collision lock: Shortlist refuses a person another TA owns; `fileScoop` still flags the application and leaves the "Already shortlisted ... by <name>" note.

## Invariants and safety

1. A scoop upload sends nothing to anyone. No outbound message, no `OUTREACH_LIVE`, no `outreachSafety`/`outboundGuard` call is involved; keep it that way. Any future "notify the lead" or "email the candidate" feature must go through `convex/lib/outreachSafety.ts` and `convex/lib/outboundGuard.ts`.
2. `fileScoop` must not set `ownerTaId`. Created with `scoopFlag` design on 29 Sep (commit 4e42d2b); setting it makes Shortlist think the person is already the TA's and skip the claim/move to Follow-up.
3. Owner check before flagging side effects: HH upload copied the pattern on 2 Oct (38943a8) after a refused claim still changed channel and counted a row on the uploader's sheet. Do not flag-then-check.
4. `scoopFlag` is idempotent and never rewrites `scoopReceivedAt` or an existing sender (tests/scoopmail.test.ts). Re-uploading a CV must not move a scoop to a different day, because the SCOOP column's identity is the flag, not the day.
4a. A scoop is filed with no `workLocationId`; stage pages show one location at a time. `claimForTa` and `moveStage` (`placeInOnlyLocation`) give it the opening's only active location (28 Oct), else it sits under "Location not assigned" after Shortlist. Openings with several locations still need the TA to pick the tab.
5. SCOOP column counts only CVs sent to the Director today by that TA, one column per CV, order backup > scoop > add-on > source (the desk, 28 Sep, 8ce23da; `tests/eodeffort.test.ts`). Colombo day, via `colomboDayStart`, never the server's UTC day.
6. The CV platform is the only reader: nothing in `scoopUpload.ts` parses a CV. Merge safety for contact details (agency phone on a scoop CV) lives in `convex/lib/sameCandidate.ts` and `samePerson.ts` (59d0d0a, 1 Oct).
7. Urgent lane: a TA-watched upload (`scoopedBy` or `headhuntedBy`) is started before background work and one slot of three is always free for it; `BACKGROUND_SLOTS = MAX - 1` (56768fa, 26 Oct). Test: `tests/extractionqueue.test.ts` also asserts via source text that `scoopUpload.ts` contains `await enqueueExtraction(ctx, cvUploadId,` and no `runAfter(0, internal.cvs.cvExtraction.processCvExtraction`, and that `eq("urgent", true)` appears before `eq("urgent", undefined)` in `startNextTurns`. Renaming those breaks the test on purpose.
8. Size/type limits are enforced twice on the server (header pre-check at 10 MB + 64 KB, then actual `file.size`); the 10 MB limit is a client-visible promise in `ScoopUpload` copy and `platformGuide.ts`.
9. `status` returns max 20 ids and is a read of the TA's own upload ids; it does not verify the id belongs to this opening or user (see quirks).
10. Backend mutations are `internal*` and reached only via the server-side Convex client with `actorId`; keep new scoop functions internal and always call `requireActor` + `assertJobAccess` + `assertWorkdayScope` for any write (workday gate, 13 Oct, 23e6794).
11. TA mailboxes must stay unread (29 Sep decision): sync, process and seeding all guard `kind === "ta"`. Do not re-enable.

## Known quirks, gaps and unverified items

- `scoop_received` notification: declared, never emitted (grep of `convex` and `src`). The 27 Sep mailbox design emitted it; the 29 Sep removal dropped the emitter but kept the literal.
- `scoopByUserId`/`scoopAt` (support-TA credit): written by `ta/cv:attach`, projected and mapped, read by nothing that computes counts. The EOD SCOOP column uses `scoopFrom`/`scoopReceivedAt` only. The 21 Sep commit message (690a125) says it is "counted in their SCOOP column" - that is no longer true.
- A scoop whose reading fails (`failed`/`needs_review`) never gets `scoopReceivedAt` unless extraction reached the "preserved despite error" branch; it then does not appear in the Scoops list (list filter is the flag). The failure is visible only in the upload panel/localStorage queue, which is per browser and expires after 24 h.
- `held` ("Not added") is shown when another TA already owns the person, but the application *is* flagged and listed; the red label overstates a refusal.
- The sender is optional and a scoop uploaded again later can only add a missing sender, never correct a wrong one.
- Scoops list has no date window; EOD relies on the Director send, not the list.
- The status query ignores job ownership and uses `optionalActor` (a null actor passes); the route's `mayUpload` is the real gate. Any other caller of `ta/scoopUpload:status` loses it.
- Stale text: Settings heading "Scoops and shortlists mailboxes"; `src/lib/eod.ts` comment "(convex/mailIntake)" and `convex/schema.ts` comment "mailed the CV to the TA's own mailbox" describe the abandoned design. `docs/SCENARIO-REVIEW.md` mentions a HH/Scoop panel spinning forever on `needs_review` (check whether still true; `FAILED` now includes `needs_review`).
- Sender list mismatch risk: page uses mapped role (`director`, `ta_lead`, `ops`), backend uses `isScoopSender` raw role/taRole; `ta_manager`/`senior_ta` raw roles map to lead in `src/data/convex/map.ts` (unverified mapping detail).
- Pure local store (`isConvex()` false) cannot upload; tests exercise the helpers, not the route.
- Mobile app rendering of the "scoops" section: unverified.
- Whether the 2-minute `claimUploadedBatch` can double-queue a scoop upload: unverified (see Backend wiring).
- No test covers `queue`, `fileScoop`, `status` against a Convex mock, the route, or the `ScoopUpload` component; only the pure helpers and the source-text queue assertions.

## How to change it safely

Common edits:

| Change | Edit | Also change |
|---|---|---|
| Who may be named as sender | `convex/lib/scoopMail.ts` `SENDER_ROLES`/`SENDER_TA_ROLES` | page senders filter in `scoops/page.tsx`, `tests/scoopmail.test.ts`, copy in `ScoopUpload.tsx` and `platformGuide.ts` |
| Size/type/file count | `MAX_BYTES`/`TYPES` in the route, `MAX_FILES` and `accept` in `ScoopUpload.tsx`, copy text, `platformGuide.ts` | HH route uses `HEADHUNT_MAX_BYTES` separately |
| What the flag writes | `scoopFlag` in `scoopMail.ts` and `fileScoop` | `src/data/types.ts`, `map.ts`, `projections.ts`, schema `applications`, `tests/scoopmail.test.ts` |
| New progress step or wording | `STEPS` in `cvUploadProgress.ts` and `LINE` in `ScoopUpload.tsx` | `tests/cvuploadprogress.test.ts`, HH panel shares the translator |
| EOD column rule | `effortBucket`/`effortRow` in `src/lib/eod.ts` | `eod-format.ts`, `EffortSheet.tsx` help text, `tests/eodeffort.test.ts`, /eod-email |
| Make failed reads visible on the list | persist failure server-side (list only shows flagged apps) | `status`, `page.tsx` |
| Emit `scoop_received` | add an emitter after `fileScoop` flags, via `ta/notifications:create` | owner decision first (users see it) |
| New field on `applications` or `cvUploads` | `convex/schema.ts` | `convex/ta/model/tables.ts` mapping if the Convex row name differs from the app's, `projections.ts`, `map.ts`, `types.ts`, seed |
| Touch the reading queue | `convex/lib/extractionQueue.ts`, `cvUploads.ts startNextTurns` | `tests/extractionqueue.test.ts`; HH shares it |

Gotchas: `enqueueExtraction` must stay in the same mutation as the insert (test enforces it); every new `fileScoop`-style call needs all three `cvExtraction.ts` call sites; Next.js here has breaking changes - read `node_modules/next/dist/docs/` before changing route handlers, server actions or caching (`revalidatePath`) behaviour; the route is a route handler rather than a server action because a CV is larger than the 1 MB action body.

Tests to run and extend (real files): `tests/scoopmail.test.ts`, `tests/eodeffort.test.ts`, `tests/extractionqueue.test.ts`, `tests/cvuploadprogress.test.ts`, `tests/workday.test.ts`, `tests/samecandidate.test.ts`. Commands, from the repo root:

```
npm test
npx tsc --noEmit -p .
npx tsc --noEmit -p convex
```

Pre-merge checklist:
- All three commands pass; add a test for any new pure rule (put it in `convex/lib`, as `scoopMail.ts` does).
- Re-read the three `fileScoop` call sites if extraction changed.
- Check Scoops page, EOD SCOOP cell and HH upload still behave (HH shares queue and progress code).
- Flag to the owner any change to what users see (labels, columns, who can upload, list contents) or to anything sent to candidates (none today).
- Local run only with `deploy/local/start-app.sh`; the local store cannot upload scoops.

Repo hard rules that apply: never run `convex deploy`/`convex run`/`convex import`/`convex env set` or touch api.career141.com / the VPS from a laptop (live changes go through `.github/workflows/deploy-production.yml`); work on a branch and merge through a PR; backfills of scoop flags are migrations (an internal function with a `dryRun` arg, run by the pipeline) - never ad-hoc scripts; outbound only through `convex/lib/outreachSafety.ts` and `convex/lib/outboundGuard.ts`; no secrets in code or docs.

## History

- 2026-09-21 `690a125` EOD editable L-sheet; first "scoop" fields: `applications.scoopByUserId`/`scoopAt` for a CV uploaded on someone else's candidate (support-TA credit, plan 6.4).
- 2026-09-21 `2676699` UI fixes, Database CVs without pipeline rows (neighbour of the `"SCOOP"` database-pick channel).
- 2026-09-25 `e590da3` EOD: sets fill to five; scoop column typed by hand because scoops arrived outside the system; database picks (TBR) no longer counted as scoops.
- 2026-09-27 `504b1f4` Mailbox design: Director/TA Lead/Ops mail CVs to a TA; mail intake read each TA's own mailbox (attachments from those senders only, never logged otherwise), `scoopTaId`/`scoopFromUserId`, `scoopReceivedAt`, `scoop_received` notification, Settings "TA mailboxes - scoops" off by default, SCOOP prefilled from mail. Merged via `830350a`.
- 2026-09-28 `4a6cd96`, `8ce23da` EOD counts only CVs sent to the Director today, one column each (backup, scoop, add-on, source); SCOOP stays a scoop on an Add-on day.
- 2026-09-29 `4e42d2b` (PR #84, `7cbe014`) Scoops tab replaces mailbox reading: upload on the opening, optional "Sent by", `fileScoop`, `ta/scoopUpload.ts`; per-TA mailbox reading removed, TA mailbox rows switched off, shared mailboxes untouched.
- 2026-10-01 `59d0d0a` Stop merging two people on a shared agency phone/email seen on scoop CVs (`sameCandidate.ts`).
- 2026-10-02 `38943a8` Move-and-claim in one transaction; HH upload checks the owner first "as scoopUpload does". `e5d6225` closed the open Convex backend (upload paths go through server-side internal calls).
- 2026-10-13 `23e6794` Workdays: `assertWorkdayScope` added to `queue`.
- 2026-10-20 `bdd78a1` (PR #223) persist scoop upload progress in localStorage, `Processing` badge, sync event; `c0a68c7` friendlier error recovery.
- 2026-10-21 `3528eba` real progress steps (`cvUploadProgress.ts`), `processingStage`, shared HH/Scoop translator.
- 2026-10-26 `56768fa` (PR #293, `0a5d8c4`) urgent lane: a TA's own HH/Scoop upload is read first with a slot kept for it; `enqueueExtraction` called inside the upload mutation (reading queue itself came in `138de24`, same day).

<!-- skill-meta
verified-commit: ddec547
verified-hash: 178d8636807b2c43d8694b0a27e8eb15d7966141
verified-date: 2026-10-28
sources:
  convex/ta/scoopUpload.ts
  convex/lib/scoopMail.ts
  convex/lib/extractionQueue.ts
  convex/lib/cvUploadProgress.ts
  convex/lib/workdayScope.ts
  convex/cvs/cvUploads.ts
  convex/cvs/cvExtraction.ts
  convex/ta/cv.ts
  convex/ta/guard.ts
  convex/ta/applications.ts
  convex/ta/notifications.ts
  convex/ta/model/projections.ts
  convex/ta/model/tables.ts
  convex/mailIntake/sync.ts
  convex/mailIntake/process.ts
  convex/mailIntake/model.ts
  convex/schema.ts
  convex/crons.ts
  src/app/api/scoops/upload/route.ts
  src/app/api/cv/upload/route.ts
  src/app/openings/[id]/scoops/page.tsx
  src/app/openings/[id]/sourcingGate.ts
  src/components/ScoopUpload.tsx
  src/components/ProjectSidebar.tsx
  src/components/CandidateList.tsx
  src/components/EffortSheet.tsx
  src/lib/eod.ts
  src/lib/eod-format.ts
  src/lib/cvSource.ts
  src/lib/auth.ts
  src/lib/visibility.ts
  src/data/convex/map.ts
  src/data/types.ts
  src/app/actions.ts
  tests/scoopmail.test.ts
  tests/eodeffort.test.ts
  tests/extractionqueue.test.ts
  tests/cvuploadprogress.test.ts
-->
