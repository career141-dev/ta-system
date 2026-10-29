---
name: cv-extraction
description: The CV pipeline from file to candidate in the TA System - every way a CV file arrives (TA upload, Replace CV, HH, Scoop, mail, WhatsApp, ZIP/folder, Workable), cvUploads status/processingStage, text/OCR/DeepSeek reading, the fair reading queue, healer and recovery crons, dedup/merge, keep-details replace, referees, Prepared CV box, CV viewing and missing CV files. Aliases - CV reading, CV parsing, extraction queue, upload progress, Replace CV, Prepared CV, green box. Use when changing, debugging or extending any of it.
---

# CV extraction (file to candidate)

## Scope and boundaries

In this skill: everything between "a CV file exists" and "a candidate (plus optionally an application) exists with details, referees, text, vector and a score", plus how that file is later opened (`/api/cv/*`) and stamped (Prepared CV).

Lives in neighbouring skills (do not duplicate, link):
- /email-intake: mailbox polling, post routing, `mailIntake/*`, `C141_TA_INTAKE` intake queue (`ta/intakeReceive.ts`). This skill starts at `pipeline/ingestion.ts:processCvIngestion`.
- /follow-up: what happens after a score moves an application into AI Follow-up (`initiateFollowUpOutreach`, reminders, 7-day close). The outbound gates live there.
- /scoop and /sets-shortlist: scoop flag meaning, shortlist, Director review. Only `ta/scoopUpload.ts:queue/fileScoop` is covered here.
- /database-search: Qdrant search, reverse match, `matching/reindexVectors.ts`. Only the post-extraction embedding hand-off is here.
- /excel-tables: link vault rows, HH sheet, Referee Calls sheet (`refereeCalls`). Only the `referees` table writes are here.
- /workday: `assertWorkdayScope` gate (used by upload mutations). /eod-email: attaches the Prepared CV via `preparedCvFile` (callers in `src/app/actions.ts`). /voice-agent, /openings, /strategy-planner: not touched.

## How it works now

### 0. The one pipe

Every arrival ends as a `cvUploads` row and a scheduled call to `internal.cvs.cvExtraction.processCvExtraction` (`convex/cvs/cvExtraction.ts`). Nothing reads a CV anywhere else (exception: the Next-side referee reader, section 8, and Reference-CV blueprints for /database-search).

`processCvExtraction` (internalAction, args `ExtractionActionArgs` + `leaseId`):
1. No `leaseId` -> `cvUploads.enterExtractionQueue` -> `enqueueExtraction` and returns (every scheduler path comes in here, 26 Oct 138de24).
2. With `leaseId` -> `holdsExtractionSlot` (query) else "standing aside" -> `runCvExtraction` -> `finally leaveExtractionQueue` (deletes the lease row and calls `startNextTurns`).
3. Top-level catch writes `status:"failed", processingStage:"failed", errorMessage`.

### 1. Arrival paths (all create `cvUploads`)

| Path | Entry | Row `status` / `source` | Starts reading how |
|---|---|---|---|
| TA "Replace CV / Upload CV" on candidate card | `src/app/api/cv/upload/route.ts` POST -> `ta/cv:uploadUrl` -> PUT to Convex storage -> `ta/cv:attach` | `uploaded`, `source:"Manual"`, `replaceKeepDetails:true`, `candidateId` preset, `storageProvider:"convex"` | NOT enqueued by attach. Picked by `processUnextractedQueueCron` (<=2 min). |
| HH upload (TA Follow-up, Link vault) | `src/app/api/hh/upload/route.ts` -> `src/lib/openings/hhUpload.ts:queueHeadHuntCv` -> `ta/hhUpload:queue` | `uploaded` + `processingStage:"queued"`, `source:"Headhunting"`, `assignToJob`, `headhuntedBy`, `workLocationId` | `enqueueExtraction` inside the mutation, `sourceChannel:"headhunting"` (`HEADHUNT_CHANNEL`), urgent. |
| Scoop upload (`/openings/[id]/scoops`) | `src/app/api/scoops/upload/route.ts` -> `ta/scoopUpload:queue` | `uploaded` + queued, `source:"Scoop"`, `assignToJob`, `scoopedBy`, optional `scoopFromUserId` | same as HH, `sourceChannel:"scoop"` (`SCOOP_CHANNEL`), urgent. |
| Native app HH | `src/app/api/mobile/v1/openings/[id]/pipeline/cv-upload/route.ts` (same `queueHeadHuntCv`) | as HH | as HH |
| Mail attachment | `communications/emailAgent.ts` (3 call sites), `communications/emailBackfill.ts`, `mailIntake/process.ts` (`ingestCvs` -> `processCvIngestion`, `shortlistCopy` for shortlists@) | `pending`, `source` = `linkedin`/`email`/`email_campaign` | `ctx.scheduler.runAfter(extractionDelayMs, processCvExtraction)`; `paused` if `appSettings.channel_toggles.emailIngestion===false` (resumed by `cvs/ingestion:resumePausedUploads`). With `C141_TA_INTAKE==="true"` emailAgent sends the file to `ta/intakeReceive:receiveCv` instead (-> /email-intake). |
| WhatsApp document/image | `communications/whatchimp.ts` webhook -> `cvs/ingestion:processInboundCV` (Graph media download, sha256, `storage/r2:uploadBufferToR2`) -> `cvs/ingestion:insertCvRecord`. The older `communications/whatchimpActions.ts` path calls `processCvIngestion` | `queued` (insertCvRecord) / `pending` (processCvIngestion), `source:"whatsapp"`, hard-coded `fileType:"application/pdf"`, `candidateId` preset to a stub made from the phone | `processCvExtraction` direct; `paused` if `whatsappIngestion===false`. Needs `WHATSAPP_CLOUD_API_TOKEN`. |
| ZIP bulk | `integrations/zipMutations.ts:createCvFromZip` | `pending`, `source:"Workable_ZIP"` | direct, `skipLLM:true` (see quirks) |
| Folder import | `cvs/folderIngestion.ts:registerFolderCandidateUpload` / `uploadFolderCandidate` (dedup by `cvUploads:checkUploadedFile` on `by_source_fileName`) | `uploaded`, `source:"Manual Directory Import"` | `cvUploads:queueManualExtraction` (inserts `ingestionLog`, schedules with `delayMs = batchIndex*500`). No in-repo caller (operator tool). |
| Workable import | `integrations/workableActions.ts` -> `integrations/workable:insertCvUpload` | `pending`, `source:"Workable"` | direct, staggered `imported*1000` ms, passes `preExtractedData` with `skipLLM:false` (the preExtracted branch only fires when `skipLLM` is true). |
| Batches | `cvs/batches.ts` (`createBatch`, `updateBatchProgress`, `updateLogStage`, pause/cancel) + `cvUploads:checkAndTriggerNextBatch` (takes up to 15 `uploaded` rows of a batch, sets `queued`, schedules with 100 ms stagger when no batch row is `processing/queued/pending_retry`) | any | no UI in `src/`; operator tooling |
| Partner (Capacity Planner) | `convex/http.ts` `/integrations/v1/cv/uploads` + `/complete` -> `integrations/partnerReadHttp.ts` -> `integrations/partnerUpload.ts` | writes **`partnerCvFiles`**, never `cvUploads`: storage only, no extraction | n/a. Read-back `GET /integrations/v1/cv/<id>` resolves either table via `partnerRead:getCvDownload`. 10 MB, PDF/DOC/DOCX, signed 300 s PUT URL. |
| Chrome extension | `src/app/api/extension/capture` | no CV file, no `cvUploads` (profile capture; matching via `src/lib/cvMatch.ts`) | n/a |

HH and Scoop uploads share limits: 10 files per click (`MAX_FILES` in `HhUpload.tsx`/`ScoopUpload.tsx`), 10 MB (`HEADHUNT_MAX_BYTES`; routes also refuse by `content-length` > 10 MB + 64 KB with 413 before reading the body), PDF/DOC/DOCX by MIME or extension. Messages are plain: "That file is over 10 MB. Save a smaller PDF and try again.", "<name> is not a PDF or a Word document.", "Choose a CV file first.", "You are not on this opening, so you cannot add CVs to it." Local JSON-store builds answer 501 ("CV files are read by the candidate database, which this local build is not connected to.").

### 2. Storage

- Upload from the web goes to Convex file storage (`ta/cv:uploadUrl` -> `ctx.storage.generateUploadUrl`; Next PUTs through `internalUploadUrl`). Row gets `storageId`, `storageProvider:"convex"`.
- Mail, WhatsApp, ZIP, Workable, folder files go to Cloudflare R2 through `storage/r2.ts:uploadBufferToR2` (key `cvs/YYYY-MM/<ms>-<safe name>`; 3 attempts, 1 s/2 s back-off). Row gets `s3Key`, `storageProvider:"r2"`.
- Non-production deployments (`C141_OUTBOUND_LOCK==="true"`, `outboundLocked()`) never write to the production bucket: `uploadBufferToR2` and `uploadCvRawTextToR2` store in Convex storage and return `s3Key = "convex:<storageId>"`; `generateDownloadUrl`/`getResumeRawText`/`deleteCvFile` resolve that prefix; `deleteCvFile` skips R2 deletes when locked. Remember this when reading a staging row: an `s3Key` starting `convex:` is not an R2 object.
- Download resolution in extraction: `args.s3Key||row.s3Key` + provider r2 -> `storage/r2:generateDownloadUrl` (1 h signed URL), else `ctx.storage.getUrl(storageId)`; fetch has a 30 s timeout; zero bytes throws "The file retrieved from storage is empty (zero bytes)."
- List rows with no `cvFileName`: `candidatesByIds` (`src/data/convex/backend.ts`) asks `candidates/candidates:cvFileNames({ids})`, at most 50 ids per call, which answers from the documents alone (R2 key, or a Convex storage file present in `_storage`) without signing a link (29 Oct: lists used to call `getCvUploadUrl` once per row, and it hit its one-second limit). Both use `findCvUpload` in `convex/lib/cvUploadLookup.ts`.
- Viewing: `candidates/candidates:getCvUploadUrl` (accepts a cvUpload id, candidate id or application id; falls back to `by_fileHash`) returns a `/api/r2-file?key=` marker (route no longer exists, 2 Oct) or a Convex storage URL; `src/data/convex/backend.ts:cvLink/findCvFile` signs R2 server-side (falls back to a direct S3 presign using the four `R2_*` vars when the Convex action is rate-limited) and says "was lost when the system moved to its new server and is being recovered..." for migration-missing files.
- Raw text goes to R2 `cv-rawtext/<cvUploadId>/<cvUploadId>.txt` (`uploadCvRawTextToR2`, `candidateId` arg is the upload id) and `rawTextKey` is stored on the candidate and `candidateResumes`; read back with `storage/r2:getResumeRawText`.

### 3. cvUploads status and processingStage

`status` (free `v.string()`, no union) values in use: `uploaded`, `pending`, `queued`, `paused`, `processing`, `processed` (also the terminal for "not a CV" and out-of-credits), `completed` (only accepted by `checkUploadedFile`), `failed`, `failed_retry`, `pending_retry`, `extraction_failed_permanent`, `needs_review`, `healing`, `cancelled`, `replaced` (cvReplace). `processingStage` (union in schema, 21 Oct 3528eba): `queued, downloading, extracting_text, ocr, structuring, validating, saving, filing, completed, needs_review, failed`. Stage writes go through `candidates/candidates:updateCvUpload` (also stamps `stageChangedAt`; `countAttempt:true` increments `extractionAttempts`/`lastAttemptAt`; returns `upload.assignToJob`, which is how extraction learns the job to file on).

UI translation of stage -> label/percent/estimate is `convex/lib/cvUploadProgress.ts:uploadProgress` (pure; "Waiting for a CV reader" 8%, "Opening the CV" 16, "Extracting document text" 28, "Reading a scanned CV" 38, "Extracting all CV details" 62, "Checking extracted details" 78, "Saving the complete profile" 88, "Adding the candidate to the opening" 95, "Complete" 100). `FAILED` set = failed, failed_retry, extraction_failed_permanent, cancelled, paused, needs_review. HH/Scoop `status` queries (`ta/hhUpload:status`, `ta/scoopUpload:status`, max 20 ids) add business state `done`/`held` (held = `routeNote` set and not owner) and the panels poll every 4 s via GET on the upload routes; on `done`/`held` the route calls `resetStore()` + `revalidatePath`. A failed card shows **Try again** (PATCH on the upload route -> `ta/hhUpload:retry`, used by HH and Scoop: uploader only, job access + workday scope, resets `status:"uploaded"`, `extractionAttempts:0`, clears `errorMessage`, `enqueueExtraction` from the stored file into the same stub candidate) and **Remove** (drops the card from the list only).

### 4. The fair reading queue (`convex/lib/extractionQueue.ts`, `cvs/cvUploads.ts`)

| Constant | Value |
|---|---|
| `MAX_CONCURRENT_EXTRACTIONS` | 3 readings at once (backend has 6 action slots; reading may not take them all, 6 Oct ba21a64) |
| `BACKGROUND_SLOTS` | 2 (so one slot is always free for a TA's HH/Scoop upload, 26 Oct 56768fa) |
| `EXTRACTION_LEASE_MS` | 10 min; a slot older is taken back |
| per-upload lock | `lockExtraction` ttl 240 s (`extractionLockedAt`), released in `finally` |
| per-run deadline | `CV_EXTRACTION_DEADLINE_MS` 210 s (`checkDeadline`) |

`cvExtractionQueue` rows: `{cvUploadId, args (replayed), startedAt?, urgent?}`. `enqueueExtraction(ctx, cvUploadId, args)`: if not already queued, insert (`urgent:true` when `isUrgentUpload` = `headhuntedBy||scoopedBy`), set `processingStage:"queued"`, then `startNextTurns`. `startNextTurns`: delete lapsed held rows (log "Slot ... lapsed"), compute `planTurns(held, now)`, start urgent waiting rows first (index `by_startedAt_urgent`), then background up to `backgroundFree`; each started row gets `startedAt=now` and a `scheduler.runAfter(0, processCvExtraction, {...row.args, leaseId})`. `leaveExtractionQueue` and `startWaitingExtractions` (called every 2 min) re-run it, so a missed turn self-heals.

`processUnextractedQueueCron` (`cvs/cvExtraction.ts`, cron `process-unextracted-cv-queue`, 2 min):
1. `startWaitingExtractions`.
2. `claimUploadedBatch(limit 10)`: reads `by_status=uploaded` `limit*5`, skips rows already in the queue, fails rows with neither `s3Key` nor `storageId` ("File URL not found (neither R2 nor Convex storage)"), sets `processing`+`processingStartedAt`.
3. If nothing claimed: `requeueAllStuckUploads(limit 20)` (see section 7), then claim again.
4. Schedules `processCvExtraction` staggered `i*2500` ms with `sourceChannel: upload.source || "Manual Directory Import"`.

### 5. Reading one CV (`runCvExtractionLocked`)

1. Lock; `getCvUpload`; abort silently if row missing or `status==="cancelled"`.
2. `updateCvUpload {status:"processing", processingStage:"downloading", countAttempt:true}`; `ingestionLog` stage `parsing` when `logId`.
3. Download (above), sha256 (`fileHash`).
4. **Duplicate file shortcut**: `candidates:findCandidateByHash` (`by_fileHash`). If a holder exists and is NOT an unread profile (`isParsed===false && !mergedInto && !skipLLM`, a730c71 26 Oct) the run does not read: row -> `processed`, `candidateId`=holder, `cvReplace:reuseFile` (point this row at the already-held file and delete this copy), create application on `assignToJob` (`applications:createApplication`), schedule `processCvScoring`, `filePosts`, `hhUpload:fileHeadhunt` / `scoopUpload:fileScoop` when flagged, batch/log updates, stage `completed`. An unread holder is instead read into that same profile (keeps its application and stage).
5. **Text** (`extractText`): PDF -> `extractTextFromPdf`: pdf.js (30 s `PDFJS_LIMIT_MS`, accepted at >=30 chars; layout via `src/lib/pdfLayout.ts`), else pdf2json (15 s), else raw stream scrape; accepted when >=50 chars (`method pdf_text`). Else stage `ocr`: `extractTextWithTesseract` is a stub that returns "" (tesseract cannot run in Convex), then Vision OCR: up to 5 rendered page images (`extractImagesFromPdfBuffer`, 60 s) -> `lib/llm.ts:callNvidiaVisionOCR` (NVIDIA `meta/llama-3.2-11b-vision-instruct`, then OpenRouter `google/gemini-2.0-flash-lite-001`, 60 s; accepts >10 chars; `method vision_ocr`). DOCX/zip-magic -> mammoth. Images -> `extractTextFromImage`, which depends on the Tesseract stub and therefore throws. RTF crude strip; txt/other decoded as UTF-8. `within()` (`convex/lib/within.ts`) bounds every reader. `textExtractionMethod` is stored on the row.
6. `cleanRawText` (strips control/box chars, page numbers, lines repeated >=3 times). `<50` chars after cleaning -> `status:"needs_review"`, stage `needs_review`, "Low-confidence OCR text ..." and return. Cap 150,000 chars (`MAX_RAW_TEXT_LENGTH`) goes to R2.
7. Candidate target: `readInto = cvUpload.candidateId ?? unreadHolder._id`; if set -> `updateCandidateFields` (file hash, rawTextKey, `cvUploadId`, `extractionModel`; `fillBlanksOnly` when `replaceKeepDetails`); else `createCandidate` stub (`createdStub=true`, `isParsed:!skipLLM`). Row now holds `candidateId`.
8. **Structuring** (`callOpenRouterLLM`): stage `structuring`. Only the first **16,000 chars** (cut at last whitespace) go to the model through `lib/llm.ts:executeLLMWithNvidiaFallback("cv_structuring")`: OpenRouter `deepseek/deepseek-v4-flash` (`OPENROUTER_CV_EXTRACTION_MODEL`), 2 tries x 75 s, back-off 2 s, `temperature 0`, `max_tokens 8192`, `response_format json_object`, DeepSeek reasoning off (`reasoning:{enabled:false}`, OpenRouter only; its thinking used to eat `max_tokens` and cut the JSON, 28 Oct); a JSON-mode answer that does not parse (`lib/jsonAnswer.ts:isCompleteJson`) counts as a failed try, so the second try and the fallback run; then NVIDIA `meta/llama-3.3-70b-instruct` 1 try. Prompt rules (edit the system message in `callOpenRouterLLM`): not-a-CV -> `{}`; null for unknown, never guess; skills `{value,confidence}`; jobHistory with per-job confidence; current title/employer inferred from most recent job; referees listed; gender only if stated or titled/pronoun for the candidate (never from name/photo); email/phone are the candidate's own only (never agency, referee, office, family, 1 Oct 59d0d0a).
   - Not-a-CV: empty/near-empty object (`!fullName && !email && !phone && !skills && !jobHistory`) from the primary provider throws `NOT_A_CV`. From the NVIDIA fallback it is only a failure ("found no candidate details") because the fallback answers `{}` for real CVs (17 Sep f04349a deleted 141 real applicants).
   - Validation: `cvExtractionSchema` (zod, loose preprocessors `makeString/makeNumber/makeArray/makeObjectArray/makeSkillArray`). A bad field is dropped and the rest kept (26 Oct ef9df4f); only if nothing fits does it fail.
   - Failure text is now specific (26 Oct 8942ad5): `failure.reason` carries "DeepSeek failed (...), then <model> ..." / "gave an empty answer" / "not readable JSON (N characters - likely cut off)" / "wrong shape (field: issue)" / "no AI model answered: ...". The thrown message is `LLM failed to extract candidate data: <reason>` and ends up in `errorMessage`, shown on the HH/Scoop card (`note` when failed). If extraction already used >90 s the message is "... (API timeout) - no time left for OCR retry".
9. Stage `validating`, then `saving`: name fallback `guessNameFromCv` (first 8 lines, then file name) when fullName is blank (29 Sep); `lib/candidateAge.findBirth` -> `dateOfBirth*`; `candidates/derivations` -> `noticePeriodDays`, `seniorityLevel`, education fields, `totalExperienceYears` (years before 15 ignored), `deriveCurrentRole`; `resolveGender` (`cvs/genderFromCv.ts`: label "Gender/Sex: ..." -> `cv_stated`, Sri Lankan NIC day-of-year (+500 female) -> `nic`, model value -> `cv_llm`; stored only into a blank gender); `lib/locationResolver.resolveCandidateLocation`.
10. `updateCandidateFields` (mutation, big): the dedup/merge step (section 6), patch with `status:"new"`, `candidateResumes` sync, follow-up flags/status sync (`updateFollowUpFlags`, `checkAndAdvanceFollowUp`, `refreshEmployersText`, `syncCandidateSummaryToApplications`, `syncCandidateOverallStatus`). It sets `hasEmbedding:true` before any vector exists.
11. Referees: `candidates/referees:saveExtractedReferees` (see section 8). Skipped when `keptAsIs` (shortlist copy of a held person).
12. Embedding: `scheduler.runAfter(0, matching/agent2:generateAndStoreEmbedding, {candidateId, rawText})` unless `keptAsIs` -> `/database-search` (embeds first 15,000 chars with `embedText(...,"passage")`, upserts Qdrant, `markCandidateHasEmbedding`). It rethrows on failure: no retry, extraction already "completed".
13. Filing: `updateCvUpload {status:"processed", stage:"filing"}` returns `jobId`. With a job: `applications:createApplication` (stage `new_cvs`, or `matched_candidates` for manual/folder/database/directory sources; an existing application keeps its stage and gets `reappliedAt` + history note "Applied again"; a rejected one stays rejected), `processCvScoring` (unless `skipLLM`), `pipeline/postFiling:filePosts` (post tag + `alsoAssignTo` extra openings, each scored), `fileHeadhunt`, `fileScoop`. Without a job: if `C141_POST_ROUTING==="on"` and the channel is `linkedin/email/email_campaign` -> nothing (stays in database); `shortlistCopy` or `keepDetails` -> nothing; else `matchExtractedCandidateToActiveJobs` (LLM `email_routing`, "if in doubt null"; manual/directory/folder/database sources land in reverse-match results via `jobs:addCandidateToReverseMatchResults` instead of an application).
14. Stage `completed`, `completedAt`; log stage `completed`; `updateBatchProgress` + `checkAndTriggerNextBatch`. `[CV_TIMING_METRICS]` is logged.

**Failure handling** (catch block): `NOT_A_CV` -> status `processed`, stage `needs_review`, "Document rejected: Not recognized as a valid CV or Resume."; if this run made the stub it is deleted (`candidates:deleteCandidate preserveUpload`) and `clearCandidate`. Message containing "403"/"insufficient"/"balance"/"credits" -> status `processed` with "Processed raw text only (LLM extraction skipped due to insufficient credits)". Anything else: `attempts` = `extractionAttempts` read at the START of the run; `attempts>=1` -> `extraction_failed_permanent` ("Permanent extraction failure - limit reached ..."), else `failed`. `shouldRetry` is hard-coded false (no auto-retry loop). The candidate stub is never deleted: renamed to the file name (`fallbackName`), `isParsed:false`, and when `assignToJob` is set an application is still created in New CVs (+ `filePosts` score:false, HH/Scoop hooks). A replace-keep-details candidate is never renamed.

### 6. Dedup and merge

Two systems, do not confuse them:
- Backend merge on arrival: `convex/lib/sameCandidate.ts:findSameCandidate` (proof only, 1 Oct 59d0d0a): same file hash (`by_fileHash`), else same LinkedIn slug (`by_linkedinUrl`, variants), else an email (`by_email`) or phone (`by_phoneClean`, forms `pk`, `0pk`, `94pk`) held by exactly ONE person AND `samePerson.namesAgree`. A CV with no name never merges on contact alone. Used by `updateCandidateFields` and `createCandidate`.
- In `updateCandidateFields` a "ghost" is merged only if `!fillBlanksOnly` AND the candidate has no application. Merge relinks the upload, deletes the ghost's `candidateResumes`, moves its `referees` to the survivor, deletes the ghost, then `cvReplace.replaceHeldCv(survivor, survivor.cvUploadId, newUploadId)`: applications on the old file move to the new one; the old upload row stays, `status:"replaced"`, `replacedByUploadId` (file kept, owner 5 Oct e42ce08, because two people had once been taken for one and 2,977 CVs were already missing). Only an identical copy (same hash) is ever removed (`reuseHeldFile`, after `stillUsed` checks `by_fileHash` and `by_candidateId`, `take(50)`).
- `createCandidate` on a match returns the held id and skips detail/CV updates unless that person has no applications, or is in `follow_up`, or auto-rejected "Did not complete requirements within 7-day window".
- The merged row of a ghost keeps `mergedInto`; `createApplication`, `fileHeadhunt`, `fileScoop`, `status` queries follow `mergedInto`.
- `shortlistCopy` (our own boxed Prepared CV arriving at shortlists@, 2 Oct 53c03dc): if it matches someone held, `updateCandidateFields` returns `{keptAsIs:true}` right after the merge: no details, file, referees, embedding or matching.
- `src/lib/dedup.ts` (`compare`, `matchAgainst`, `planMerge`, `Verdict same|review|new`) is the TA app's own identity module (JSON store, `src/lib/ingest.ts`, intake queue); it is NOT called by the backend extraction. Keep rule changes in both places when the rule is meant to be global; `tests/dedup.test.ts` covers the app one, `tests/samecandidate.test.ts` the backend one.
- `candidates/dedupLock.ts` (`candidateLocks`) exists but nothing in `convex/cvs` calls it (no caller found); the real concurrency guard is `lockExtraction`.

### 7. Healer and recovery

| Job (cron name) | Interval | What it does |
|---|---|---|
| `recover-stuck-uploads` -> `cvUploads:recoverStuckUploads` | 29 min | `by_status=processing` (take 50), `processingStartedAt ?? _creationTime` older than 10 min and NOT in `cvExtractionQueue` -> `failed`, "Process interrupted or timed out (>10m)", re-triggers the batch check. |
| `process-unextracted-cv-queue` | 2 min | section 4; when idle runs `requeueAllStuckUploads`. |
| `requeueAllStuckUploads` (called by the above) | on idle | for each status in `failed, cancelled, failed_retry, processing` reads from a cursor (`lib/cronCursor`, names `requeueStuckUploads.<status>`, 2 Oct fdab754) so permanent failures do not hog the window; eligible = has a file, not `isHealAttempted`, not `needs_review`, not "File URL not found", processing >5 min, not in queue. `extractionAttempts>=2` -> `needs_review` ("Extraction attempted N times without resolution. Flagged for review."), else back to `uploaded`. |
| `bg-healer-cv-extractor` -> `cvs/healerActions:healNextUnparsedCandidate` | 31 min (`HEALER_INTERVAL_MINUTES` in `cvs/healer.ts` must match `crons.ts`) | `claimHealBatch`: up to 5 targets (`HEAL_BATCH_SIZE`): (1) `healing` rows not dispatched for 15 min, up to `MAX_HEAL_ATTEMPTS` 3 then `needs_review`; (2) `uploaded` rows not heal-attempted (sets `healing`, or `processed` if their candidate already has any of name/contact/skills/history/summary); (3) candidates with `isHealAttempted` false/undefined (scan 50) that are COMPLETELY empty on all five fields and have a file. Dispatches `processCvExtraction` at `3000 + i*5000` ms. Each tick written to `healerState` (`recordHealerRun`; `getHealerStatus` reports running/stalled/never_run). |
| `bg-sept5-reextractor` -> `sept5ReextractorActions:runSept5ReextractionTick` | 1 min (full registry only) | one-off resumable backlog re-read from 5 Sep 2026 (`sept5ReextractionState`), 4 rows per tick, 3 s apart. |
| `lazyParsing.ts:triggerLazyParse` | none | re-reads stored raw text for an unparsed candidate; no caller in the repo. |

Registries (bottom of `convex/crons.ts`): `C141_DISABLE_CRONS==="true"` exports the `quiet` registry (staging), which drops all of the above except those in `addMaintenance`, registered only when `C141_TA_MAINTENANCE==="on"`: `ta-cv-queue` (2 min), `ta-cv-stuck-uploads` (29 min), `ta-cv-healer` (31 min). `bg-sept5-reextractor` is never in `quiet`.

Operator-only mutations with no in-repo callers (run through the pipeline's `run_function`, never from a laptop): `recoverCreditDepletedCVs`, `restoreAllCandidatesFromUploads`, `reparseAllUnextractedCandidates` (two copies, `candidates/candidates.ts` and `communications/emailBackfillMutations.ts`), `cancelAllRunningExtractions`, `resumeFailedUploads/resumeBatch`, `recoverStuckUploadsPublic`, `claimUploadedBatchPublic`, `clearAll`. Several set status `pending` or reset `extractionAttempts` and are not data-safe; treat any new data repair as a migration (below).

### 8. Referees

Two independent readers:
1. In extraction: the model's `referees` array -> `saveExtractedReferees` (`candidates/referees.ts`): filtered by `convex/lib/refereeCheck.isPlausibleReferee` (a person-like name, not a duty bullet, plus a phone/email/company/title, 30 Sep a161d54), **deletes the candidate's existing referees and re-inserts** (`onlyIfNone` for a replaced CV, 29 Sep). An empty result leaves what is on file alone. Only the first 16,000 CV chars reach the model, so a long CV's end-of-CV references can be lost.
2. In Next: `src/lib/refereeExtractor.ts` (`extractRawText` pdfjs/mammoth, `parseReferees` AI via `src/lib/ai.ts` task `parse` max 1500 tokens with `parseRefereesRegex` fallback). Called by `/api/cv/upload` after attach (`extractAndSaveReferees(..., onlyIfNone=true)`) and lazily by the candidate card (`src/app/openings/[id]/candidate/[appId]/page.tsx:refereesFromCv`, once per candidate per process, 3 s page wait, 120 s drop; regex first then AI).
`convex/cvs/refereeWindow.ts` (whole-CV window, 1 Oct d1d56de) is only referenced by `tests/refereewindow.test.ts`; the extraction does not use it. `referees` table fields: candidateId, name, designation, company, contactNo, email, relationship, notes, createdAt, contactable, lastContactedAt, extractedAt; search indexes on company/designation/name (Referral Search). TA System mapping: `convex/ta/model/tables.ts` entry `referees`. Referee Calls rows and the call sheet are /excel-tables.

### 9. Replace CV (keep details)

`ta/cv:attach` (guards: `requireActor`, `assertJobAccess(WORKS_THE_DESK)`, `assertWorkdayScope`) inserts the upload with `candidateId` + `replaceKeepDetails`, sets `candidate.cvUploadId/cvFileName`, `application.cvFileId/cvFileName`; a support TA (not `ownerTaId`) also stamps `scoopByUserId/scoopAt`. Old upload stays untouched ("replacing does not delete what was there"). Extraction then: no ghost merge (`isGhost=false`), `fillBlanksOnly` (`convex/lib/fillBlanks.ts`: writes only empty fields, never clears; `always` = `CV_FILE_KEYS` rawTextKey/fileHash/cvUploadId/isParsed/hasEmbedding/extractionModel; `SAME_FACT` groups, e.g. a TA-typed `taExpectedSalaryText` blocks the CV's `expectedSalary`), work history on file kept, referees only if none, `status` not reset, no matching to other jobs, no rename on failure. API response: "CV replaced with <name>." or "CV added: <name>." Same-hash replacement of an unread profile now reads (a730c71).

### 10. Hand-off: scoring on arrival

`cvs/cvScoringActions.ts:processCvScoring` (scheduled from extraction/dup/filePosts/`createApplication`): waits when the JD is `pending_ta_approval` (`lib/jdGate.scoringWaitsForJd`; `ta/jdApproval` scores waiting CVs later); heuristic score from `cvs/cvScoring.ts` (job score weights default 30/35/15/15/5); tier 1 `scoreWithLLM` (Claude first, DeepSeek second; 3 tries 1/2/4 s), tier 2 DeepSeek short prompt (2 tries), tier 3 heuristic; final = 0.6 heuristic + 0.4 model. `saveMatchScore`: stores `aiMatchScore/aiMatchExplanation`, inserts `match_scores`, and when score >= `job.minMatchScoreToShow` (default 60) and stage is `new_cvs` moves the application to `ta_shortlist` (shown as AI Follow-up, `convex/ta/stages.ts`) and calls `pipeline/followUpHelper:initiateFollowUpOutreach` (resolves recipients through `lib/outreachSafety`; behaviour is /follow-up). Scoring itself sends nothing.

## UI surface

| Where | Component / route | Who | Action |
|---|---|---|---|
| Candidate card header strip ("A CV is on file." / "Upload CV" / "Replace CV", drop zone, XHR progress) | `src/components/ReviewDetailsForm.tsx` -> POST `/api/cv/upload` | `mayChangeCv` (= `opening.act` with `ownerTaId` collision test + seat visibility). Shown only while stage in new_cv/matched/ai_follow_up/ta_follow_up/follow_up and card not locked. | attach |
| CV tab / Prepared CV tab | `src/app/openings/[id]/candidate/[appId]/page.tsx` (`CvFrame`, `PreparedCvEditor`, tab list, Reference tab, `cvVersion` cache-buster) | `opening.read` + seat | GET `/api/cv/[candidateId]?app=<appId>` (`&view=pdf` converts Word), GET `/api/prepared-cv/[appId]` |
| Prepared CV drag/width + reset | `PreparedCvEditor` -> server action `savePreparedCvBox(Inline)` in `src/app/actions.ts` (validates x,y<=5000, width 80..5000 then clamps to `BOX.minWidth/maxWidth` 180/380) -> `applications.taPreparedCvBox` | `opening.act` | saves `{x,y,width}` or reset |
| TA Follow-up and Link vault "Upload headhunted CV" | `src/components/HhUpload.tsx` (mounted in `pipeline/[stage]/page.tsx` for `ta_follow_up`, and `LinkVaultTable.tsx`), needs a work location selected | `opening.act` | POST/GET `/api/hh/upload` |
| `/openings/[id]/scoops` | `src/components/ScoopUpload.tsx` | `opening.act`, `requireSourcingSeat` | POST/GET `/api/scoops/upload` |
| Candidate page / database drawer / list rows / EOD page | `src/app/candidates/[id]/page.tsx`, `db/DbCandidateDrawer.tsx`, `db/ResultRow.tsx`, `CandidateRow.tsx`, `LinkRow.tsx`, `ContactLinks.tsx`, `eod/page.tsx` | per their page | link to `/api/cv/<id>` |
| Bulk select "Download CVs" | `src/components/BulkSelect.tsx` -> POST `/api/cv/zip` | per-person `mayOpenCv` | `{appIds}` or `{candidateIds}`, max 100 (`MAX`), ZIP in memory (`src/lib/zip.ts`), refused/no-file people named in `X-Missing-Cvs` header |
| Reference CV matcher | `src/components/db/CvMatcher.tsx` -> `/api/cv/reference` | signed-in | builds a search blueprint from a file/text/candidate; stores nothing (/database-search) |
| `/intake` | `src/app/intake/page.tsx` | intake.handle | the `C141_TA_INTAKE` queue (/email-intake) |

`/api/cv/[candidateId]`: 401 "Sign in to open a CV."; 404 "Not found." when `mayOpenCv` fails (no existence leak); `?download=1`; Word + `view=pdf` -> `wordToPdf`; headers `Cache-Control: private, no-store` (never `public`, 23 Sep review). `cvBytes` fetches twice with a 20 s timeout each (1 Oct).

## Data

- `cvUploads` (schema ~776): file (`storageId`/`s3Key`/`storageProvider`, `fileName/Size/Type`, `fileHash`), origin (`source`, `campaignLabel`, `meta*`, `uploadedBy`, `assignToJob`, `assignToJobPost`, `alsoAssignTo`, `routeNote`, `workLocationId`), flags (`headhuntedBy`, `scoopedBy`, `scoopFromUserId`, `replaceKeepDetails`, `shortlistCopy`, `replacedByUploadId`), state (`status`, `processingStage`, `queuedAt`, `stageChangedAt`, `completedAt`, `processingStartedAt`, `extractionLockedAt`, `extractionAttempts`, `lastAttemptAt`, `healAttempts`, `lastHealAt`, `isHealAttempted`, `textExtractionMethod`, `errorMessage`), links (`candidateId`, `batchId`). Indexes: `by_uploadedBy, by_assignToJob, by_status, by_fileHash, by_batchId, by_candidateId, by_storageId, by_s3Key, by_source_fileName, by_fileName, by_isHealAttempted`.
- `cvExtractionQueue`: indexes `by_cvUploadId, by_startedAt, by_startedAt_urgent`. `partnerCvFiles` (`by_createdAt, by_s3Key`), `ingestionBatches` (`by_status, by_startedAt`), `ingestionLog` (channelType union incl. `manual_upload`, `headhunting`; stage strings queued/parsing/ai_extraction/completed/needs_review/failed/paused), `folderImportProgress`, `healerState` (singleton), `candidateLocks` (unused), `sept5ReextractionState`.
- `candidates`: identity (`fullName, email, phone, phoneClean, linkedinUrl, fileHash`), `cvUploadId` (the CV on file), `cvMissingUploadId`, `rawTextKey`, `isParsed`, `isHealAttempted`, `hasEmbedding`, `extractionModel`, `gender/genderSource`, `dateOfBirth*`, `mergedInto`, `isDuplicateOf`, `noticePeriodDays`, `totalExperienceYears`, `locationStructured`. `candidateResumes` (`by_candidateId`; `rawText/rawTextKey`, `jobHistory`, `embedding` legacy).
- `applications`: `cvFileId`, `cvFileName`, `candidateCvUploadId`, `taPreparedCvBox` (`{x,y,width?}`), `aiMatchScore/aiMatchExplanation`, `reappliedAt`, `scoopByUserId/scoopAt`, `taSourcingChannel` (HH). `referees` as in section 8. `match_scores`.
- Missing CV files: `src/lib/cvMissing.ts:cvFileMissing(c)` = `cvMissingUploadId` equals `cvUploadId`; set by `ta/cvFiles2809:run` (dryRun migration, 28 Sep e1039b4; 5,434 CVs from 7 Jul to 12 Aug never copied from Convex Cloud, 2,977 profiles affected). Marked people are excluded from Database search, top-bar/keyword search, reverse match, `matching/agent2`, `matching/search`, `ta/candidates`, `ta/eyeMarked`, `src/lib/dbMatch.ts` ("cv_missing"), `engineSearch`, `lookalikeMatch`. The mark lifts by itself when any other CV is linked (new `cvUploadId`); `storageMigration.ts` clears it when the old file is copied back.

## Backend wiring

- Public/internal functions (all `internal*`; Next calls them with the admin key via `src/lib/convexServer.ts`): `ta/cv:uploadUrl|attach`, `ta/hhUpload:queue|fileHeadhunt|status`, `ta/scoopUpload:queue|fileScoop|status`, `cvs/cvUploads:*`, `cvs/cvExtraction:processCvExtraction|matchExtractedCandidateToActiveJobs|processUnextractedQueueCron`, `cvs/healer*`, `cvs/cvReplace:reuseFile`, `candidates/candidates:updateCandidateFields|createCandidate|updateCvUpload|getCvUploadUrl|findCandidateByHash`, `candidates/referees:saveExtractedReferees`, `storage/r2:*`, `pipeline/ingestion:processCvIngestion`, `cvs/ingestion:processInboundCV|insertCvRecord`.
- HTTP (`convex/http.ts`): WhatsApp webhooks `/api/whatsapp`, `/whatsapp`, `/api/whatsapp-whatchimp`, `/whatsapp-whatchimp` (media -> `processInboundCV`); partner `/integrations/v1/cv/uploads`, `/integrations/v1/cv/uploads/complete`, `/integrations/v1/cv/` GET. Next routes: `/api/cv/upload`, `/api/cv/[candidateId]`, `/api/cv/zip`, `/api/cv/reference`, `/api/hh/upload`, `/api/scoops/upload`, `/api/prepared-cv/[appId]`, mobile `.../pipeline/cv-upload`.
- Crons: see section 7 and section 4.
- Env names: `R2_BUCKET_NAME, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY` (`ta/storage:r2Configured` reports them), `OPENROUTER_API_KEY, OPENROUTER_API_KEY_1..4, OPENROUTER_API_KEYS`, `NVIDIA_API_KEY`, `WHATSAPP_CLOUD_API_TOKEN`, `C141_OUTBOUND_LOCK` (bucket writes/deletes), `C141_DISABLE_CRONS`, `C141_TA_MAINTENANCE`, `C141_POST_ROUTING`, `C141_TA_INTAKE`, `C141_MAIL_INTAKE`, `SOFFICE_PATH`, `SOFFICE_SLOTS` (Next side), `NEXT_PUBLIC_CONVEX_URL/CONVEX_SELF_HOSTED_URL/CONVEX_URL` (storage URL rewrite in `getCvUploadUrl`). No dedicated kill switch for extraction itself: pause a channel with `appSettings.channel_toggles.whatsappIngestion|emailIngestion=false` (rows become `paused`).
- Providers: OpenRouter (DeepSeek v4 flash, Gemini flash-lite vision), NVIDIA NIM (llama 3.3 70b fallback, llama 3.2 vision, embeddings in `generateNvidiaEmbedding`, which extraction no longer calls), Cloudflare R2, Qdrant (via /database-search), Meta Graph (media download), LibreOffice (`soffice`, in the app image) for Word to PDF.

## Access and roles

- Upload gates: Next route `mayChangeCv` (`src/lib/cvAccess.ts`, capability `opening.act` with `ownerTaId`: a TA who did not shortlist the person is refused with "You cannot change this candidate's CV through this opening."); HH uses `mayUploadHeadHuntCv` (`opening.act`); Scoop route uses `opening.act`. Viewer accounts are read-only (`isReadOnly` in `can`, so no uploads). Backend re-checks: `requireActor` + `assertJobAccess(WORKS_THE_DESK = primary_recruiter, supporting_recruiter, director)` + `assertWorkdayScope` (TA/ta_support must have started a workday and added the position: "Start your workday before continuing recruitment work." / "Add this assigned position to your workday first."). Scoop "sent by" must satisfy `isScoopSender` ("Scoops come from the Director, a TA Lead or Ops.").
- View gates: `mayOpenCv(user, candidateId, appId)`: with `appId` -> application must belong to the candidate and pass `opening.read` + seat stage visibility (so client contacts see CVs on their shortlist); without `appId` -> `database.read` (clients denied). The same test guards `/api/cv/zip` and `/api/prepared-cv/[appId]`. Hard-coded rule: 404 not 403.
- Collision lock (`fileHeadhunt`): if the application's `ownerTaId` is another TA, nothing is relabelled and the upload gets `routeNote` "Already claimed on this opening by <name>." (2 Oct 38943a8). `fileScoop` never sets the owner (so Shortlist still moves it); it only notes "Already shortlisted ... by <name>." Different work location than the existing application -> `routeNote` "...belongs to another work location...".
- Partner API: shared-secret authenticated, `partnerCvFiles` writes refused when `outboundLocked()`.

## Invariants and safety

1. Never delete a candidate or CV file on a guess: failed reads keep the stub; replaced CVs keep the old file; only identical hashes are removed (5 Oct e42ce08; 2,977 files already lost).
2. Merge only on proof (`sameCandidate.ts`), never delete a candidate that has an application (1 Oct 59d0d0a); a TA-chosen replace never merges.
3. Only the primary model's "not a CV" is trusted (17 Sep f04349a). Do not weaken.
4. Gender only when certain; only fills blanks (29 Sep 8c5b7be). "Not disclosed" is an answer in the box and the Director-review gate (`tests/notdisclosed.test.ts`).
5. One reading per upload (`lockExtraction`, 2 Oct ba3902f) and at most 3 readings, 2 background (26 Oct 138de24/56768fa). Never reschedule a throttled reading in a loop; wait in `cvExtractionQueue`. Every new way to read a CV must schedule `processCvExtraction` (never call `runCvExtraction` directly) or use `enqueueExtraction`.
6. Every external reader has a bound (`within`, 6 Oct ba21a64; `pdfLayout` must finish on any PDF, `tests/pdflayout.test.ts`).
7. The recovery jobs must not take rows that sit in `cvExtractionQueue` (`inExtractionQueue` in `claimUploadedBatch`, `recoverStuckUploads`, `requeueAllStuckUploads`).
8. Outbound: extraction/scoring send nothing; the only outbound consequence is `initiateFollowUpOutreach` through `lib/outreachSafety.resolveRecipient` (`doNotContact` refused, 2 Oct). Never add a send here, never set `OUTREACH_LIVE`.
9. Non-prod never writes to the production bucket (`outboundLocked`).
10. CV bytes are private: `no-store`, access tests on every route, no CV bytes or candidate details in logs (HH route comment).
11. A shortlist copy (`shortlistCopy`) writes nothing onto a held person (2 Oct 53c03dc).
12. Prepared CV prints only what the desk holds, no invented "NOT DISCLOSED"/"OPEN TO DISCUSS" (29 Sep 014680c; `tests/preparedcv.test.ts`). A TA-typed "Not disclosed" does print.
13. Re-apply never demotes an application (2 Oct ba3902f).

## Known quirks, gaps and unverified items

- Tesseract is stubbed (`extractTextWithTesseract` returns ""): an image CV throws "Insufficient text extracted from image (Tesseract OCR returned less than 20 characters)". WhatsApp images are filed with `fileType:"application/pdf"` so they take the PDF path and most likely end in `needs_review` (unverified; nothing in the repo tests it). Web/mail intake only accept PDF/DOC/DOCX/RTF.
- Legacy binary `.doc` is sent to mammoth (docx only) when the type says doc: likely fails (unverified).
- Referees come from the first 16,000 characters only; `refereeWindow.ts` is dead code outside its test. Referees are read twice for a replaced CV (backend `onlyIfNone` and Next `extractAndSaveReferees`).
- `updateCandidateFields` sets `hasEmbedding:true` before the Qdrant upsert; an embedding failure leaves a flag that lies.
- `ta/cv:attach` does not enqueue; its reading waits for the 2-minute cron and is background priority (a TA waiting on Replace CV can wait behind a backlog). `source:"Manual"` also triggers the "manual" branch in `createApplication`.
- ZIP uses `skipLLM:true` but, without `preExtractedData`, extraction still calls the model (only scoring is skipped). Workable's `preExtractedData` is ignored (`skipLLM:false`).
- Failed-read stubs carry a file-name `fullName`, so healer step 3 treats them as non-empty; their recovery path is `requeueAllStuckUploads` (<2 attempts) or a re-upload. `isHealAttempted` blocks requeue permanently once set.
- "403" anywhere in an error message is treated as out-of-credits and the row becomes `processed` (no retry).
- Duplicate-hash shortcut can attach a replacement file to a different candidate than the one being replaced when the same bytes belong to another profile (not guarded; unverified in practice).
- `processUnextractedQueueCron` passes only `upload.source` as `sourceChannel`, so `shortlistCopy`/`headhuntedBy` rows rely on row flags, not args; `skipLLM` is lost on a cron-claimed row.
- `candidateLocks`/`dedupLock.ts`, `lazyParsing.ts`, `folderIngestion.ts`, `batches.ts` have no in-repo callers.
- Prepared CV for Word CVs needs `soffice`; without it, `preparedCvFile` falls back to the generated one-page CV (`generated:true`, no draggable box).
- Local JSON-store builds cannot upload, read or stamp CVs (all routes answer 404/501).

## How to change it safely

Where to edit:
- Prompt/fields read from a CV: `callOpenRouterLLM` system message + `cvExtractionSchema` (`cvs/cvExtraction.ts`) + `updateCandidateFields` args (`candidates/candidates.ts`) + `convex/schema.ts` candidate fields + the TA mapping in `convex/ta/model/tables.ts` / `src/data/convex/map.ts` / `src/data/types.ts` + any `SAME_FACT` group in `convex/lib/fillBlanks.ts` + the UI that shows it. Add a test row in `tests/cvschema.test.ts`.
- Text readers/OCR: `extractText` and its helpers (keep `within` bounds; keep the `<50` chars -> `needs_review` rule).
- Queue numbers: constants in `convex/lib/extractionQueue.ts` (+ `tests/extractionqueue.test.ts`); intervals in `convex/crons.ts` AND `HEALER_INTERVAL_MINUTES`; mirror in `addMaintenance`.
- New arrival path: create the row (set `status`, `source`, a file pointer, optional `assignToJob`), then `enqueueExtraction` (inside a mutation) or schedule `processCvExtraction`; decide urgency in `isUrgentUpload`; add the source to `ingestionLog.channelType` union if you log it; if it needs a post-filing hook, call it from all three filing sites in `runCvExtractionLocked` (duplicate branch, success, failure branch) as HH/Scoop do (tested by `tests/hhupload.test.ts`).
- Stage labels: `convex/lib/cvUploadProgress.ts` (+ `tests/cvuploadprogress.test.ts`) and the `processingStage` union in BOTH `schema.ts` and `updateCvUpload` args.
- Dedup rule: `convex/lib/sameCandidate.ts`/`samePerson.ts` (+ `tests/samecandidate.test.ts`, `tests/sameperson.test.ts`) and, when the TA app must agree, `src/lib/dedup.ts` (+ `tests/dedup.test.ts`).
- Prepared CV box: content `src/lib/preparedCv.ts`, size `src/lib/career141Box.ts`, stamp `src/lib/pdf.ts:stampCareer141Box`, file `src/lib/preparedCvFile.ts`, editor `PreparedCvEditor.tsx`, EOD callers in `src/app/actions.ts` (tests `tests/preparedcv.test.ts`, `tests/eodcvbox.test.ts`).
- Access: `src/lib/cvAccess.ts` + `tests/cv-access.test.ts`; backend `ta/guard.ts`.
- Missing CV: `src/lib/cvMissing.ts` + `tests/cvmissing.test.ts`.

Tests: `npm test` (runs every `tests/*.test.ts`; one file: `node tests/run.mjs cvschema`), `npx tsc --noEmit -p .`, `npx tsc --noEmit -p convex`. `convex/cvs/__tests__/cvScoring.test.ts` is not run by `npm test` (node:test; run it by hand). Relevant suites: cvschema, extractionqueue, cvuploadprogress, hhupload, genderfromcv, samecandidate, sameperson, dedup, preparedcv, shortlistcopy, refereewindow, referees, refereecheck, refereecalls, cvmissing, cvrequired, cv-access, notdisclosed, pdflayout, pdfworker, within, zip, scoring, mailintake. There is no end-to-end test of `runCvExtractionLocked` (needs a backend); add pure helpers into `convex/lib/` so they can be tested, as the queue was.

Pre-merge checklist: schema field added optional; `processingStage` union kept in sync; no new direct call to `runCvExtraction`; recovery jobs still skip queued rows; no send added; no secret printed; new constants have a "why/when" comment; `npm test` + both `tsc` clean; read `convex/_generated/api.d.ts` only if you add a file (generated, do not hand-edit).

Repo hard rules that apply: never run `convex deploy/run/import/env set` or any call against api.career141.com / the VPS from a laptop; live changes go through `.github/workflows/deploy-production.yml`; any data repair of existing CVs (re-read, re-link, backfill gender, clear `cvMissingUploadId`) is an internal mutation with a `dryRun` argument run by the pipeline (`run_function`), as `ta/cvFiles2809:run` is; outbound only via `convex/lib/outreachSafety.ts` and `convex/lib/outboundGuard.ts`, never set `OUTREACH_LIVE`; work on `<person>/<topic>`, merge by PR. Flag to the owner anything that changes what a TA/Director sees (stage labels, which candidates appear, box contents) or what reaches candidates (a changed score threshold moves people into AI Follow-up and starts outreach).

## History

- 2026-09-15 6b36b9e, f9f5d46: CV pipeline backend brought in; mail-in CV verified inbox to screen.
- 2026-09-16 dc3574f: healer ported (recover stuck `healing`, 5 per tick, `healerState`) after 76 records stuck live.
- 2026-09-17 f04349a: model timeout 75 s x2, 8,192 tokens, only the primary's "not a CV" trusted (141 real CVs had been rejected).
- 2026-09-21 554f41b: upload a CV from the candidate sheet (`/api/cv/upload`); dd5f5fb never insert sample referees.
- 2026-09-22 4c88bc3: shared-mailbox CVs routed by job post, never by guess.
- 2026-09-25 22faaa8: Word CVs shown as PDF (LibreOffice); 86b9b11 CV ZIP download.
- 2026-09-28 b8ee975 HH upload; e1039b4 lost Convex-Cloud CVs relinked/marked `cvMissingUploadId`; cd3aa53 age/experience from the CV.
- 2026-09-29 8c5b7be gender from CV; 4e42d2b Scoops upload (TA mailboxes no longer read); 014680c Replace CV keeps details + Prepared CV box rework.
- 2026-09-30 a161d54 referees must be people.
- 2026-10-01 59d0d0a merge only on proof; d1d56de referee window (not wired in); 547847e CV page sizing/multi-column referees.
- 2026-10-02 53c03dc shortlist copies write nothing; ba3902f one CV per person, extraction lock, re-apply never demotes; fdab754 requeue cursors; e5d6225 closed the open backend (the `/api/r2-file` route is gone per the comment in `getCvUploadUrl`; whether this commit removed it is unverified).
- 2026-10-05 e42ce08 replaced CV file kept (owner); c19b99f profile no longer waits on referee reading.
- 2026-10-06 ba21a64 reading capped at 3 slots, per-reader time limits.
- 2026-10-13 db0f12f partner API (storage-only CV uploads).
- 2026-10-20 be61274 resizable Prepared CV box.
- 2026-10-21 3528eba real `processingStage` and progress for HH/Scoop cards.
- 2026-10-23 8c8cc77 secure candidate CV access (`mayOpenCv`/`mayChangeCv` on direct routes).
- 2026-10-26 138de24 fair queue `cvExtractionQueue` after 800 CVs took 20-25 min; 56768fa urgent slot for HH/Scoop; 8942ad5 failures say why; ef9df4f one malformed list no longer rejects a CV; a730c71 re-upload of a failed CV is read.
- 2026-10-28 DeepSeek reasoning off for CV tasks + cut-off JSON retried ("not readable JSON (323 characters)"); Try again / Remove on failed HH and Scoop cards.

<!-- skill-meta
verified-commit: 66aa2ca
verified-hash: af784f9789687a777266bef9b6a1cc16e8a1b023
verified-date: 2026-10-29
sources:
  convex/cvs/cvExtraction.ts
  convex/cvs/cvUploads.ts
  convex/cvs/cvReplace.ts
  convex/cvs/cvScoringActions.ts
  convex/cvs/healer.ts
  convex/cvs/healerActions.ts
  convex/cvs/ingestion.ts
  convex/cvs/folderIngestion.ts
  convex/cvs/batches.ts
  convex/cvs/genderFromCv.ts
  convex/cvs/refereeWindow.ts
  convex/cvs/sept5Reextractor*.ts
  convex/lib/extractionQueue.ts
  convex/lib/cvUploadProgress.ts
  convex/lib/cvUploadLookup.ts
  convex/lib/fillBlanks.ts
  convex/lib/sameCandidate.ts
  convex/lib/llm.ts
  convex/lib/refereeCheck.ts
  convex/storage/r2.ts
  convex/ta/cv.ts
  convex/ta/hhUpload.ts
  convex/ta/scoopUpload.ts
  convex/ta/cvFiles2809.ts
  convex/pipeline/ingestion.ts
  convex/candidates/candidates.ts
  convex/candidates/referees.ts
  convex/crons.ts
  src/lib/cvAccess.ts
  src/lib/cvMissing.ts
  src/lib/dedup.ts
  src/lib/preparedCv*.ts
  src/lib/refereeExtractor.ts
  src/lib/openings/hhUpload.ts
  src/app/api/cv/**
  src/app/api/hh/upload/route.ts
  src/app/api/scoops/upload/route.ts
  src/app/api/prepared-cv/**
  src/components/PreparedCvEditor.tsx
  tests/cvschema.test.ts
  tests/extractionqueue.test.ts
-->
