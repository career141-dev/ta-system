# Master plan: stability as data grows, and reading every CV (29 Oct 2026)

For whoever implements this (Astra / Codex, or a developer). Read `AGENTS.md`
first; its hard rules apply to every step. Line numbers are from `main` at
`8bb1c684` — re-check each one before changing it.

## Why

Production went down twice on 29 Oct (API and app did not answer for 10–20 s,
then recovered; the Convex dashboard showed "Connection Issue"). Errors seen:
`Function execution timed out (maximum duration: 1s)` and `Your request timed
out performing too many system operations.`

Cause: several parts of the code re-read whole tables or whole histories on a
timer. One month in, there is enough data that these reads no longer fit
Convex's limits, and they jam the one server that runs Convex, Postgres, the
app and the dashboard. It gets worse every day as CVs and history grow.
Convex itself is not the problem; the read patterns are.

Separately, real CVs are refused: designed (Canva) and scanned CVs come back
"Document rejected: Not recognized as a valid CV" or "Low-confidence OCR text".

## Non-negotiable

1. **Search finds exactly the same people as today.** Same indexes (title,
   skills, summary, full CV text), same vector search, same scoring, same
   number of results. Speed work changes how results are loaded, never what
   is searched. Proof required before release (see Phase 4).
2. **A workday checklist is never green unless it is truly done.** No `.take(n)`
   that could hide unfinished work. The EOD send re-checks real data and never
   trusts a cached summary alone.
3. **No CV is refused or deleted by the machine.** Unclear = "Needs review".
4. Every send still goes through `lib/outreachSafety.ts` and `lib/outboundGuard.ts`.
5. Data changes are migrations with `dryRun`, run by the pipeline. No laptop
   access to live. Each release needs the owner's go-ahead.

## Phase 0 — see problems fast (do first, tiny)

- **0.1 Server health script** (read-only): load, memory, disk, container
  restarts/OOM, DB size, biggest tables, backend errors of the last N minutes
  grouped by function. Works when the dashboard is down. Put it in
  `deploy/production/server-health.sh`. Windows: run with
  `"C:\Program Files\Git\bin\bash.exe"`, not `bash` (that opens WSL).
- **0.2 Uptime alert**: ping `/version` and the sign-in page every minute;
  alert the owner after 2 failures.
- **0.3 Better error logs**: failed Convex calls log function name, attempt
  number and a request id — no candidate data.

## Phase 1 — stop the repeating load (biggest relief, one PR)

| # | Problem (file) | Fix | Users see |
|---|---|---|---|
| 1.1 | Next server reloads 30 whole tables every 30 s (`src/data/prime.ts:392-399`, `TABLES_TTL_MS` `src/data/primeState.ts:46`), kept alive by the bell polling `/api/notifications` every 10 s (`src/components/NotificationBell.tsx:226`, route calls `primeStore({})`). `allApplications` pages every application (`src/data/convex/backend.ts:198`), used by ~92 actions. Reports use `alwaysFresh`. | Notifications route must not prime the store. Take growing tables (`pipelineEvents`, `aiCalls`, `matchRuns`, `chat`, `outreach`, `interviews`, `eodEmailCopies`) off the whole-table list; load per page/per opening where used. Longer TTL for the rest. | Same, faster |
| 1.2 | Notifications read every row a user ever had, then slice 30 (`convex/ta/notifications.ts:62-64`) | Index `by_user_createdAt`, `.order("desc").take(30)`; stored unread count | Same |
| 1.3 | Workday lead drawer and TA rail stay mounted and poll every 20–25 s when closed (`src/components/Workday.tsx:70-78, 801-811, 843-863`) | Unmount or pause polling when closed/hidden | Same; refreshes when opened |
| 1.4 | "too many system operations" is classed transient and retried (4 tries) (`src/lib/convexResilience.ts:152-153`, loop `src/lib/convexServer.ts:184-194`) | Add it to BUDGET; keep real network retries; test with both exact messages | Fewer freezes |
| 1.5 | Failed keyword search returns `[]` (`convex/matching/search.ts:31-32, 41-57`; `src/data/convex/backend.ts:351` `.catch(() => [])`) and is cached 5 min (`engineSearch.ts:139-146,168`; 30 s share `:243-257`) | Errors propagate; result carries `complete/partial/unavailable`; never cache partial; UI says "Search failed — try again" | **Better**: no fake "nobody found" |
| 1.6 | Graph webhook schedules a full 30-day mailbox poll per message (`convex/http.ts:526`, `emailAgent.ts:202-233`) | One poll per mailbox at a time, short debounce | Same mail, fewer duplicates |
| 1.7 | `bg-sept5-reextractor` runs every minute (`convex/crons.ts:865`, `cvs/sept5Reextractor.ts:194-230`), looks like a finished backfill, re-sends CVs to extraction | **Owner decides** after confirming what it does: pause | — |

## Phase 2 — workday reads only what is needed

Findings (`convex/ta/workdays.ts`, `convex/lib/workdayChecks.ts`):
reviewer dashboard re-runs every unfinished day (up to 100, incl. stale ones)
× every job × ~45 queries on every poll (`:1216-1221, :1311`); full history
read to find "worked before" (`:1180`, `pendingJobs :157`); 8 upload queries
across all jobs per position (`:350-369`); uploads read all-time then filtered
to today (`:403, :705`, false capacity blocker past 1200); task history twice
(`:759-760`); `requiredChecks` collects 9 tables uncapped; every stage move
runs the full calculation (`pipelineStateMachine.ts:264`), up to 60 per
follow-up sweep run.

- 2.1 Split reads: small summary query (titles, status, counts) / one position's
  checklist when expanded / outstanding candidates paginated / task history when
  opened / assignment choices and older days separately.
- 2.2 Reviewers read only today's unfinished days (index `taWorkdays (finishedAt, date)`).
- 2.3 Uploads: `by_assignToJob` with `.gte("_creationTime", dayStart)`; a routing
  table for `alsoAssignTo`.
- 2.4 Maintained fact "TA worked this job before" (per user × job row).
- 2.5 Missing indexes: `applications (jobId, ownerTaId, currentStage)`,
  `linkVault (openingId, addedBy, outcomeAt)`, `taWorkdayEvidence (jobId, table, recordId)`,
  `taWorkdayTaskEvents (workdayId, jobId, key)`; latest-first reads for
  `taSourcingRuns`, `profileSuggestions`.
- 2.6 Read each table once per calculation; group task events by key once.
- 2.7 Stage moves mark the workday job "stale" (cheap write); recalculation
  happens on next view or in a scheduled job — not inline in the mutation.
- 2.8 Small stored checklist state per workday × job with an evidence revision;
  time-based changes (expired carry-forward) handled. Display uses it; the EOD
  send validates live evidence and reserves the send atomically (non-negotiable 2).

## Phase 3 — background jobs and growing tables

- 3.1 Follow-up sweep: inbound `communications`/`aiCalls` per app read bounded
  (latest only) (`crons.ts:471-484`).
- 3.2 Spread cron minutes so 1-minute jobs do not stack.
- 3.3 Purges in smaller batches (`ta/tracking.ts:74-75` deletes 1000 per mutation).
- 3.4 Retention (migration, dry run first; **owner picks days**, e.g. 90):
  `notifications`, `nvidiaTokenLogs`, `mailboxLog`, `ingestionLog`,
  `activityLog`, `searchHistory`. Candidates, CVs, applications,
  `pipelineEvents`, `communications` are **never** purged.
- 3.5 Unindexed scans to fix (most are admin/manual): `candidates/candidates.ts:851,874,1001,1024,1603,1773,1795`,
  `cvs/cvUploads.ts:484`, `mailIntake/aiReader.ts:48-70` (all users/jobs/apps per director reply),
  `emailAgent.ts:1067-1070` (8000 `mailboxLog` rows), `emailAgent.ts:1242`.
- 3.6 Timers that `router.refresh()` every 3–4 s (`MatchingStatus.tsx:54,68`,
  `JobDetailsPanel.tsx:61`, `HhUpload.tsx:198`, `ScoopUpload.tsx:194`): poll a
  tiny status endpoint instead of re-rendering the whole page.

## Phase 4 — search: same results, less load

Today one user search = 6–16 `searchCandidates` calls = 24–64 index reads,
each returning up to 100 full documents (`convex/matching/search.ts:42-54`,
`FETCH_LIMIT` `engineSearch.ts:230`), then `getBatch` loads full candidate +
resume (raw text + 1024-float embedding) per id (`convex/ta/candidates.ts:43-48,119-120`).
Reverse match loads up to ~1150 full candidates at once (`agent2.ts:508`, `queries.ts:13-23,119-124`).

- 4.1 Share normalised single terms across quick and full passes.
- 4.2 Limit keyword retrieval concurrency per search (start at 2, tune by measurement).
- 4.3 Search/result reads return only fields the ranking needs; full candidate
  loaded only for the final shown pool. The **full CV text index stays searched**.
- 4.4 Reverse match loads in pages.
- 4.5 **Proof gate**: run 50 real searches (pasted JDs + keyword) on old and new
  code against the same local data. Candidate sets must be identical. Any
  missing person blocks the release.

## Phase 5 — read every CV

Findings (`convex/cvs/cvExtraction.ts`, `convex/lib/llm.ts`):
- Pictures are tried only when PDF text < 50 chars (`:717`, `:1246`); scrambled
  text from designed PDFs passes, the AI finds nothing → `NOT_A_CV` (`:973-978`).
- Vision reader is NVIDIA `llama-3.2-11b-vision-instruct` with all page images
  in one request (`llm.ts:184-252`); backup `google/gemini-2.0-flash-lite-001`
  is refused by the OpenRouter guardrails (only `deepseek-v4-flash` allowed).
- JPG/PNG go to a Tesseract stub that always fails; WhatsApp images are filed as PDF.
- Legacy `.doc` goes to mammoth (docx only).
- `NOT_A_CV` on a stub deletes the candidate with applications, events,
  communications, calls, scores (`:1634-1643` → `candidates.ts:1392-1430`); the
  "stub" can be an existing person found by dedup (`candidates.ts:696-722`).
- Message says "Tesseract failed" when Tesseract never ran (`:1268`).

Work:
- 5.1 **Never refuse, never delete**: remove the delete; `NOT_A_CV` →
  `needs_review` with the upload, applicant and job link kept; unverified text
  excluded from matching until resolved.
- 5.2 **Try harder before giving up**: empty structuring → read pages as images →
  structure again → second model → only then `needs_review`.
- 5.3 **Text quality check**: real-word ratio, presence of name/email/phone
  patterns; poor text → image reading even when ≥ 50 chars.
- 5.4 **Vision**: one page per request, all pages (cap ~6), joined in order.
  Model chosen by test (5.9).
- 5.5 JPG/PNG/WhatsApp photos → image reading directly; store real file type.
- 5.6 `.doc` → LibreOffice to PDF (already in the app image) → normal path.
- 5.7 Card messages say the real reason ("This CV is a picture and the text
  could not be read", "No name or contact details found"). Buttons: Open file,
  Read again as picture, Type details by hand (name, phone, email, current job).
- 5.8 "Needs review" list per opening.
- 5.9 **Model test (owner chooses after)**: ~30 hard real CVs (Canva/designed,
  scanned, phone photo, two-column, `.doc`, the two from 29 Oct). Compare a
  stronger NVIDIA vision model vs Gemini Flash (needs the owner to allow it in
  OpenRouter, ZDR). Score: name, email, phone, current title, job history
  found correctly. Target ≥ 98 % read. Local only; no live data access.
- 5.10 **Recover the lost ones**: migration (`dryRun` first, report counts) that
  finds uploads with "Document rejected", "Low-confidence OCR" or `needs_review`
  since 21 Sep and re-runs them with the new reader. Owner OKs the real run.
- 5.11 Weekly number: CVs received / read / needs review.

## Phase 6 — later, as usage grows

- Measure again after Phases 1–2 with the health script.
- Then decide: bigger VPS, Postgres on its own machine, or Convex Cloud. Not
  before the code is fixed — a bigger server only delays the same jam.

## Release order

1. Phase 0 + Phase 1 + 5.1/5.2/5.7 (stop the freezes, stop losing CVs) — one release.
2. 5.9 model test → owner picks → 5.3–5.6, 5.8.
3. Phase 2 (workday).
4. Phase 3, then 5.10 recovery (dry run, then owner OK).
5. Phase 4 with the proof gate.

Each PR: `npm test`, `npx tsc --noEmit -p .`, `npx tsc --noEmit -p convex`;
update and stamp the feature skills it touches (`workday`, `database-search`,
`cv-extraction`, `email-intake`, `follow-up`); test against a local Convex
backend with synthetic production-sized data (≈80k candidates, a month of
workdays) and measure rows read per query before and after.

## Owner decisions needed

1. Pause `bg-sept5-reextractor`? (after confirming what it does)
2. Retention days for logs and notifications.
3. Allow Gemini Flash in OpenRouter for the vision test?
4. Vision model, after the test.
5. Real run of the CV recovery migration, after the dry-run count.

## Also pending (separate)

Branch `claude/followup-complete-rule` (uncommitted, in the
`followup-reply-bot-handover-d58b33` worktree): one "complete" rule for
Follow-up, current salary not required (owner, 29 Oct). Tests pass. Not yet a PR.
