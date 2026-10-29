---
name: strategy-planner
description: The Strategy Planner - a TA Lead ticks sourcing strategies per job and puts TAs on them, each TA accepts, fills in used/date/note/proof pictures and submits; the lead reads it. Also "strategies tab", "Done by", "N/A", "strategy list", "proof picture", "strategy_assigned bell". Use when changing, debugging or extending strategies, their visibility, acceptance, proofs, bells or the catalogue.
---

# Strategy Planner

## Scope and boundaries

In this skill: everything named "strategy" - the lead's planner (`/strategy`, `/strategy/[openingId]`, `/strategy/manage`), the TA's tab (`/openings/[id]/strategies`), the catalogue (`strategies` table), per-job rows (`strategyAssignments`), proof pictures (`/api/strategy-proof`), the two bells it raises, and the strategy-only access seat (`onStrategy`) that lets a TA open a job they were only put on through a strategy.

Not in this skill (neighbours):
- /workday - the daily checks and Midday/EOD gate. Strategy has NO coupling to workday (verified: no "strateg" in `src/lib/workday*` or `src/app/workday`; `TopNav` hides `/workday` by its own role list). Strategy-only seats just cannot use Midday/EOD (`seat.canAct` false).
- /eod-email - Midday/EOD emails; a strategy-only assignee is refused there by design (see `src/app/openings/[id]/layout.tsx`).
- /excel-tables - the TA's job tables (`isTa`, TA Support seeing every TA's rows). The Excel Tables "Interested/L's" are unrelated to strategies.
- /openings - opening pages, sidebar, access requests (`ta/openingAccess`); only the strategy hooks are here.
- /follow-up, /scoop, /sets-shortlist, /voice-agent, /email-intake, /cv-extraction, /database-search - no strategy logic. NOTE: "SCOOP" is just one string in the strategy list (`DESK_STRATEGIES`), not a link to /scoop.

## Adding a candidate to another job

The shared actions module includes `addCandidateToJob`; it does not change strategy assignments.

## How it works now

Vocabulary: a **strategy** is a catalogue entry (name, description, heading). A **row** (`strategyAssignments`) exists for one strategy on one job only once the lead has acted on it ("A strategy nobody has acted on has no row"). **Ticked** = the lead chose it for the job; TAs only see ticked rows and struck-through rows. **Done by** = TAs put on the row. **Accepted** = the TA acknowledged a new assignment.

All server actions live in `src/app/actions.ts` (section "Strategy Planner (8 Oct)", starts ~line 5800). Every one resolves the opening from the record, not the form (`authorizeOn`, `strategyRowOf`). Each ends with `done/note/fail` (all `Promise<never>`: they redirect back with a banner, so code after a `note()` does not run) and `revalidateStrategies` (calls `markTablesStale()` then revalidates `/strategy`, `/strategy/[id]`, `/openings/[id]/strategies`, `/openings/[id]`). The `*Inline` wrappers (`inline()`) are what client components call via `useInline` (`src/components/Submit`).

### Flow 1 - The lead plans a job
Entry: `/strategy` (`src/app/strategy/page.tsx`, guard `pageUser("strategy.assign")`). `plannerJobs()` lists every opening with `status === "open"` (`isPlannable`; on hold/closed/filled are NOT listed), sorted client then title, with its active TAs and `countsOf`. A job expands in place (`<details>`; `?job=<openingId>` opens one) to `StrategyLeadTable` fed by `strategyTable(repo.strategies(true), jobRows).map(leadLine)`. `/strategy/[openingId]` shows the same table alone and 404s (`notFound`) unless the opening is plannable; it also has an inline "Add a strategy to the list" form (`saveStrategy`).

Lead actions (all need `strategy.assign`; table saves as each change is made, no Save button):

| Control | Server action (actions.ts) | Store call (`src/data/store.ts`) | Effect |
|---|---|---|---|
| Tick box | `updateStrategyLine` field `selected` value `1`/`0` | `repo.updateStrategyLine` | sets `row.selected`; row created if absent; retired strategy with no row refused: "That strategy is retired. Bring it back on the Strategy list first." |
| Date assigned / Date done | `updateStrategyLine` field `assignedAt` / `doneAt` | same | `colomboDayFromValue` (YYYY-MM-DD, real calendar date, else "That is not a date."); empty clears. Setting `assignedAt` also stamps `assignedBy`/`byRole` |
| Note (blur / Enter) | `updateStrategyLine` field `note` | same | trimmed, empty -> null, > 500 chars refused "Keep the note under 500 characters." |
| "+ Add" dropdown | `addStrategyDoneBy` | `repo.addStrategyDoneBy` | see below |
| chip "x" | `removeStrategyDoneBy` | `repo.removeStrategyDoneBy` | removes TA from `doneBy` and from `acknowledgements`; refuses "They are not on that strategy."; submitted data stays; row deleted only if `strategyRowIsEmpty` |
| N/A / Use again | `setStrategyNotApplicable` (`na=1`/`0`) | `repo.setStrategyNotApplicable` | sets `notApplicable`; creates the row on first mark; clearing on an otherwise empty row deletes it |
| (unused standalone) | `setStrategyAssignedDate` | `repo.setStrategyAssignedDate` | still exported, takes `rowId` + `date`; the lead table uses `updateStrategyLine` instead |

`addStrategyDoneBy` (the heart of assignment):
1. `authorizeOn(openingId,"strategy.assign")`.
2. Assignee must exist, be `isActive` and not `role === "client"` ("That person does not have access."). The dropdown lists ALL active non-client users (`allUsers` in both pages), not only the job's TAs, so a lead, admin or viewer can be put on a row.
3. Strategy must exist ("That strategy is no longer on the list."); if retired and no row yet -> `repo.addStrategyDoneBy` returns null -> "`<name>` is retired. Bring it back on the Strategy list first."
4. Store: creates the row if missing (`newStrategyRow`, `assignedAt = colomboDayStart(now)`); if the TA is not already in `doneBy` appends them and pushes `{taId, assignedAt: now, acceptedAt: null}` to `acknowledgements` (replacing any old entry for that TA); always sets `selected = true` (putting a TA on it ticks it); if `assignedAt` was null it takes today and records assigner/role.
5. Already on it -> `note("<TA> is already on <strategy>.")` and stop (no bell).
6. Bell: only `isConvex()`, `taId !== user.id`, and `bellDue(taId:openingId)` (30 s debounce, below) -> `convexMutation("ta/notifications:create", {type:"strategy_assigned", title:"You were given strategies", body:"<lead> put you on strategies for <job title>.", jobId})`, then `revalidatePath("/api/notifications")`. Failure is only logged (`[notifications] strategy_assigned failed`). The body names the job, never the strategy.

### Flow 2 - The TA accepts (batch acceptance, 19 Oct)
Trigger: a TA opens `/openings/[id]/strategies`. Rows where the TA is in `doneBy` with `acknowledgements[].acceptedAt === null` are "pending" (`strategyAcceptanceStatus`). `StrategyTaTable` shows an amber banner "N new strategies are waiting for your acceptance" with one button "Accept all N" -> `acceptStrategyAssignmentsInline` -> `acceptStrategyAssignments` (`strategy.work`) -> `repo.acceptStrategyAssignments({openingId, taId})` sets `acceptedAt = now` on every row of that opening where the row is not N/A, is ticked, includes the TA and has a null `acceptedAt`. Returns count; 0 -> `note("There are no new strategy assignments to accept.")`; else `done("Accepted N strateg(y|ies). You can start working on it/them now.")`. There is no per-row accept and no decline.

Rules around acceptance: a pending row shows "Accept first" in Used, no inputs, and its hidden `rowId` input is left out of the form (only `editable` rows are posted); `submitStrategyRows` skips a pending row for that TA; `mayAttachProof` refuses uploads while pending. **Grandfathering:** a row/TA with no acknowledgement entry counts as accepted (`acknowledgement?.acceptedAt === null` is the only pending test), so pre-19-Oct rows and TAs who joined by submitting need no backfill. The lead's chip shows "Awaiting acceptance" (warn) or "check Accepted <day>" (`dayLabel(acceptedAt)`); the planner job summary shows "N awaiting acceptance" (`pendingStrategyAcceptances`: active = not N/A and ticked).

### Flow 3 - The TA works and submits
Page: `src/app/openings/[id]/strategies/page.tsx` (guard `requireSourcingSeat`). Rows come from `scopeStrategies(repo.strategyAssignments(id), user)` then filtered again to `isTicked || notApplicable`. A row is "mine" (`isRowMine` in `StrategyTaTable`) when the TA is in `doneBy` OR nobody is on it (`doneByIds` empty) - colleagues' rows are read-only ("Currently working" / "Used"). Struck rows render as one crossed-out line: "Not for this job. Your TA Lead has said it cannot be used here."

Form fields per row: `used_<rowId>` checkbox, `date_<rowId>` (disabled until Used), `note_<rowId>` textarea (maxLength 500). Submit -> `submitStrategyUpdateInline` -> `submitStrategyUpdate`:
1. `authorizeOn(openingId,"strategy.work")`; no `rowId` -> "There is nothing to submit."
2. Per posted `rowId`: skip if row missing, on another opening, or `notApplicable`; skip if the TA is not on it and it is not ticked; `used` + typed bad date -> `fail("That is not a date (<name>).")`; note > 500 -> `fail("Keep the note under 500 characters (<name>).")`; a ticked row nobody put them on is taken only if `used` or a note was entered (so it does not become theirs by being on the page).
3. Value written: `doneAt = used ? (typed day ?? today Colombo) : null`; `note = text || null`. "Used" with no date = today; Used unticked clears `doneAt`.
4. `repo.submitStrategyRows`: skips pending-acceptance rows; if the TA was not on a ticked row they are appended to `doneBy` (no acknowledgement entry -> counts accepted); sets `doneAt`, `note`; stamps every proof `{submittedAt:null, addedBy: this TA}` with `submittedAt = now`; sets row `submittedAt`/`submittedBy`. Returns the count. 0 -> `fail("Accept your new strategy assignments before submitting an update.")`; no rows survive step 2 -> `fail("None of those strategies are yours to update.")`.
5. Bell to the opening's `taLeadId` (`repo.opening(...).taLeadId`) if `isConvex()`, lead is not the submitter, and `bellDue("submit:<taId>:<openingId>", 5*60_000)`: type `strategy_assigned`, title "A TA submitted strategies", body "<TA> submitted their strategies on <job>.". Success text: "Submitted N strateg(y|ies). Your TA Lead can now see it/them."
Re-submitting is allowed any time (button copy says so); each submit overwrites `doneAt`/`note`/`submittedAt`.

What the lead sees: the TA's `doneAt`, `note`, `submittedLabel` ("Submitted by <name>, <day>") and only proofs with `submittedAt !== null` (`proofsForLead`). Dates/note are only ever written at submit by a TA, but the lead can also edit `doneAt` and `note` directly (Flow 1) and overwrite them; nothing records who last wrote them.

### Flow 4 - Proof pictures
Client: `StrategyTaTable.upload()` POSTs multipart `{rowId, file}` to `/api/strategy-proof` (`src/app/api/strategy-proof/route.ts`), then `router.refresh()`. Max shown 5 per row ("Add picture" hidden at 5). Server order in `POST`: reject `content-length` > `PROOF_MAX_BYTES + 64 KiB` (413, unread); `!isConvex()` -> 501 (the local JSON store keeps no files); `primeStore`; `currentUser` (401); read form; row from `repo.strategyAssignment(rowId)` (404 "Reload the page."); `allows(user,"strategy.work",{openingId,assignment})` AND `mayAttachProof` (active, `isTa`, not N/A, ticked, acceptance not pending; else 403 "That strategy is not yours to add a picture to."). Then `checkProofUpload({size, head 16 bytes, existing})` from `src/lib/strategyProof.ts`:

| Rule | Value | Message / status |
|---|---|---|
| empty | size 0 | "Choose a picture first." 400 |
| size | `PROOF_MAX_BYTES` = 5 MiB | "That picture is over 5 MB..." 413 |
| count | `PROOF_MAX_PER_ROW` = 5 (counts all proofs on the row, any adder) | 409 |
| type | magic bytes only (PNG/JPEG/WebP via `sniffImage`; client type and SVG/HTML ignored) | "Only PNG, JPEG or WebP pictures can be attached." 415 |

Then `convexMutation("ta/strategies:proofUploadUrl")` -> `fetch(internalUploadUrl(url))` POST with the sniffed content-type -> `{storageId}` -> `repo.addStrategyProof(rowId, {id: storageId, contentType, size, addedAt, addedBy, submittedAt: null})`. If the row vanished meanwhile, the stored file is deleted (`proofDelete`) and 404 returned. Then `markTablesStale()` + revalidates. The picture is the TA's own (amber border, not visible to the lead) until a submit stamps `submittedAt`.

`GET /api/strategy-proof?row=&proof=`: `mayOpenProof` -> `proofsVisibleTo` (TA: proofs they added; admin/director/ta_lead/ops: submitted ones; anyone else none). Not allowed or not Convex -> plain 404 (never 403, so existence is not confirmed). Fetches `ta/strategies:proofUrl` (20 s timeout), streams it with the recorded content-type, `content-disposition: inline`, `x-content-type-options: nosniff`, `cache-control: private, no-store`, `content-security-policy: default-src 'none'; img-src 'self'; sandbox`.

Removal: `removeStrategyProof` (`strategy.work`): only the person who attached (`proof.addedBy === user.id`, "Only the person who attached a picture can remove it.") - works even after submit; `repo.removeStrategyProof` returns the storage id, then `ta/strategies:proofDelete` (errors swallowed).

### Flow 5 - The catalogue
- List page `/strategy/manage` (`pageUser("strategy.manage")`): add form, one edit form per active strategy (name <=120, description <=600, heading <=60 enforced in `saveStrategy` by trim/slice, name by error), "Retire from the list", and a Retired section with "Bring back". Shows "Given N times" = number of rows for that strategy across all jobs.
- `saveStrategy` (`strategy.manage`): empty name -> "Give the strategy a name."; > 120 -> "Keep the name under 120 characters."; `repo.saveStrategy` refuses (null -> "That name is already on the list, or the strategy no longer exists.") a name equal case-insensitively to another ACTIVE strategy, or an unknown `id`. New entries get `sortOrder = max+1` (end of list). Renaming does not touch existing rows (`strategyName` is a snapshot).
- `setStrategyActive`: retiring never touches rows. Bringing back refuses if another strategy now has the same name ("A strategy with that name is already on the list.").
- A retired strategy: cannot be newly ticked/assigned, but a retired strategy that already has a row stays in the table (`strategyTable`: active OR has row) with a "retired" tag; a row whose strategy doc is gone is shown by `strategyName`.
- Seed: `convex/ta/strategies.ts:seedCatalogue` (internal mutation, args `items[{name,description?,group?}]`, `createdByEmail`, `dryRun?`). Looks the author up by email in `users` (throws `No account for <email>.`), skips names already present case-insensitively (retired or not), appends with `sortOrder` continuing from the max, returns `{dryRun, added, results[]}`. Run only by the release pipeline (`run_function`) with `dryRun` first. `DESK_STRATEGIES` in `src/lib/strategyPlanner.ts` has 19 names (the original 15 from 8 Oct plus Aura, ChatGPT, Gemini, Linked Post on 9 Oct) and feeds the local sample data (`makeStrategies` in `src/data/seed.ts`) and tests; what is actually on the live list is edited in the app and is not verified here.

### Derived numbers (`src/lib/strategyPlanner.ts`)
- `isTicked(r) = r.selected ?? r.doneBy.length > 0` (old rows with no answer count as ticked once a TA is on them; `selected === false` is NOT ticked even with TAs).
- `countsOf(rows)`: N/A rows -> `notApplicable`; a row not ticked and with nobody on it is ignored; else `assigned++`, and `done++` when `doneAt !== null`.
- `plannerJobs` counts all rows of the job; `plannerByTa` (per-TA grouping, still exported and tested, no page uses it now) counts only rows that TA is on.
- Days are Colombo days: `colomboDayStart`, `colomboDateValue`, `colomboDayFromValue` (`src/lib/calendar.ts`), `dayLabel` ("8 Oct 2026" or a dash). The lead table also computes "today" with `Intl` `Asia/Colombo` to show an optimistic date.

## UI surface

| Where | Who sees it | Component / file | Calls |
|---|---|---|---|
| Header link "Strategy Planner" (`NAV` in `src/components/TopNav.tsx`) | `allows(user,"strategy.assign")` = ta_lead, director, admin | TopNav | links `/strategy` |
| `/strategy` jobs table + stat row (Jobs being worked / Strategies in use / Done), "Manage list" button (`strategy.manage`), progress bar + "N awaiting acceptance" | strategy.assign | `src/app/strategy/page.tsx`, `StrategyLeadTable` | `updateStrategyLineInline`, `addStrategyDoneByInline`, `removeStrategyDoneByInline`, `setStrategyNotApplicableInline` |
| `/strategy/[openingId]` | strategy.assign | `src/app/strategy/[openingId]/page.tsx` | same + `saveStrategy` |
| `/strategy/manage` | strategy.manage | `src/app/strategy/manage/page.tsx` | `saveStrategy`, `setStrategyActive` |
| `/openings/[id]/strategies` + sidebar item "Strategies" (`ProjectSidebar` `atsItems`, only when `canSeeSourcing`) | TAs and strategy-only assignees; leads/directors/admin also see the page (link "Manage in Strategy Planner") | `src/app/openings/[id]/strategies/page.tsx`, `StrategyTaTable` | `acceptStrategyAssignmentsInline`, `submitStrategyUpdateInline`, `removeStrategyProofInline`, `fetch /api/strategy-proof` |
| Bell (header) | everyone with an inbox | `src/components/NotificationBell.tsx` | polls `GET /api/notifications` |

Notes that bite: the lead table is a client component with optimistic state (`pendingAdds/Removes/Ticks/Struck`) that is cleared when the refreshed `lines` prop confirms it, and reset on a failed action - change the data shape of `leadLine` and `LeadStrategyLine` together. Date and note inputs use `key={...value}` so they remount after a save. The TA table keeps `state` from `useState(initial)` so server refreshes do not overwrite what the TA is typing (a submit by someone else will not show until reload). The TA form's pending/accept state is separate from the submit state. Mobile: `src/lib/mobile/navigation.ts` has a `strategy` destination flag (`role !== client && !== viewer`) and `src/lib/mobile/openings.ts` lists a `"strategies"` section, but there are no mobile strategy endpoints (unverified from the app side).

## Data

Convex tables (`convex/schema.ts`, ~lines 2985-3037); app types `Strategy`, `StrategyProof`, `StrategyAcknowledgement`, `StrategyAssignment` in `src/data/types.ts` (~878-960).

`strategies`: `name`, `description?`(string|null), `group?`(string|null), `sortOrder`, `active`, `createdAt`, `createdBy` (users id). Index `by_active [active, sortOrder]`. Ordering everywhere is done in memory (`sortOrder`, then name).

`strategyAssignments`: `openingId` (jobs), `strategyId`, `strategyName` (snapshot), `doneBy[]` (users), `acknowledgements?[{taId, assignedAt, acceptedAt:number|null}]`, `assignedAt?`, `assignedBy?`, `byRole?`, `selected?` (tick; null on old rows), `notApplicable`, `doneAt?`, `note?`, `proofs[{id (storage id), contentType, size, addedAt, addedBy, submittedAt|null}]`, `submittedAt?`, `submittedBy?`. Indexes `by_opening [openingId]`, `by_opening_strategy [openingId, strategyId]`. No unique constraint: "one row per strategy per job" is enforced only by the store lookups (`find(openingId && strategyId)`). New row ids in the app are `sa_<random>` / `st_<random>` until the commit assigns Convex ids.

Status vocabulary (derived, not stored): not ticked / ticked; struck (`notApplicable`); acceptance `not_assigned | pending | accepted`; done = `doneAt !== null`; submitted = `submittedAt !== null`. `strategyRowIsEmpty` (store.ts ~573): no TA, not selected, `assignedAt === null`, not N/A, no submit, no proofs, no note, `doneAt === null` -> the row is deleted by the mutators `removeStrategyDoneBy`, `setStrategyNotApplicable`, `updateStrategyLine`.

Notifications: type `strategy_assigned` (union in `convex/schema.ts` ~2206 and `convex/ta/notifications.ts`); `notifications.jobId` set; `listForUser` resolves `href = /openings/<jobId>/strategies`; the bell uses the same rule client-side. Both bells (assigned, submitted) share the one type; only the title differs.

Load/sync: both tables are in `WHOLE` (`convex/ta/tables.ts`) and `WHOLE_TABLES` (`src/data/prime.ts`), blank in `src/data/primeState.ts` `blank()`, and in the store's `empty` db (`store.ts` ~220). Convex mapping: `convex/ta/model/tables.ts` lines `strategies: identity("strategies", ["description","group"])` and `strategyAssignments: identity("strategyAssignments", ["assignedAt","assignedBy","byRole","selected","doneAt","note","submittedAt","submittedBy"])` - the list names fields that read back as `null` when absent; `acknowledgements` is deliberately not in it, so it reads back `undefined` on old rows (hence the optional chaining everywhere). Add a new optional-with-null field to that list or the app sees `undefined`.

Opening delete: `convex/ta/openingDelete.ts` `OPENING_CHILDREN` includes `["strategyAssignments","by_opening","openingId"]` and deletes each row's proof files from storage first. The in-app Bin/lift path (`store.ts` ~631 `["strategyAssignments", r => r.openingId === id]`) carries rows with the opening. `convex/ta/testSweep.ts` and `convex/integrations/partnerRead.ts` list the tables too (partner read allow-list, unverified what it exposes).

## Backend wiring

- Convex (all `internal*`, called with the server's admin key; none public): `ta/strategies:seedCatalogue` (migration, `dryRun`), `ta/strategies:proofUploadUrl` (mutation, `ctx.storage.generateUploadUrl`), `ta/strategies:proofUrl` (query `{storageId}` -> `storage.getUrl` or null), `ta/strategies:proofDelete` (mutation, swallow errors), `ta/notifications:create` / `listForUser` / `markRead` / `markAllRead`, `ta/tables:page` (reads), `ta/commit` (all writes).
- Persistence: every `repo.*` mutator runs through `mutate()` in `src/data/store.ts`; under Convex it is `commitToConvex` (diff sent as one transaction `convex/ta/commit.ts`, refused if another writer changed the same rows since load; error text via `describeCommitError`). Without Convex (tests/local) it writes the JSON file under a lock. So strategy rules run on the in-memory copy, not in Convex functions: there are no Convex-side strategy guards other than `proof*` being internal.
- Read freshness: `TABLES_TTL_MS = 30_000` (`src/data/primeState.ts`); `markTablesStale()` zeroes it after every strategy write so the writer and other pages re-read on the next load.
- Next route: `/api/strategy-proof` (POST/GET) above; `/api/notifications` (GET/POST) `src/app/api/notifications/route.ts`.
- Crons / http routes: none for strategies (verified: no "strateg" in `convex/crons.ts` or `convex/http.ts`).
- Env flags / kill switches: none specific to strategies. The bell only fires when `isConvex()` (`src/data/mode`). Proof upload needs Convex mode. No outreach is involved: nothing here sends anything to candidates, so `outreachSafety`/`outboundGuard`/`OUTREACH_LIVE` do not apply.
- External providers: Convex file storage only (proofs); Clerk for sessions.
- Bell mechanics: `bellDue(key, ms = 30_000)` in actions.ts is an in-process `Map` (module-level `lastBell`), so it resets on restart and is per server instance; keys `"<taId>:<openingId>"` (30 s) and `"submit:<taId>:<openingId>"` (5 min). The client: `NotificationBell` polls every 10 s visible / 20 s hidden, on focus and on visibilitychange; it chimes (`playNotificationBell`, a Web Audio two-tone G5/C6 synth) and flashes the tab title (`flashNotificationTitle`) only for unread ids not seen in the previous poll, and not on the first poll (`seenIds` null) so an already-unread inbox does not chime on load. An AudioContext is created lazily and resumed on `pointerdown`/`keydown`/`click` (browser autoplay rules), so a chime is silent until the user has interacted with the page.

## Access and roles

Capabilities in `src/lib/auth.ts`:

| Capability | Allowed | Refusal |
|---|---|---|
| `strategy.assign`, `strategy.manage` | admin, director, ta_lead (same as `client.manage`) | "Only a TA Lead, Director or Admin can assign strategies." |
| `strategy.work` | `isTa(user)` (ta or ta_support) OR `ctx.onStrategy`; refused for `assignment.role === "client_contact"`; needs an assignment OR `onStrategy` | "Strategies are worked by the TA they were given to." / "You are not on this opening." |

`onStrategy` = the user is in `doneBy` of any row on that opening: computed ad hoc as `repo.strategyAssignments(id).some(r => r.doneBy.includes(user.id))` in about 14 places (opening layout, `sourcingGate.ts`, openings list, opening page, candidate page, pipeline page, `CandidateList`, `cvAccess.ts` x2, `profileWrites.ts`, mobile `openings/pipeline/candidate`, mobile opening route, links export route, `authorizeOn`). Effects of the strategy-only seat: `opening.read` and `opening.sourcing` allowed; `seatFor` returns `{role:null, canSeeSourcing:true, canAct:false, stages:[]}` (read sourcing, cannot act on the pipeline, sees no stage rows); `openingsForUser` lists the opening for TAs and ta_leads; no Midday/EOD (`canUseDailyEmail = seat.canAct`). `opening.act` is NOT granted by `onStrategy` (16 Oct fix 622159b "limit assigned access to sourcing"). Because the seat comes from `doneBy`, removing a TA from their last row on a job removes their access to it (unless they have an assignment).

Visibility (`scopeStrategies` in `src/lib/visibility.ts`, applied on every read, not just in the page): desk-wide roles (admin, director, ta_lead, ops, i.e. `!isScoped`) get all rows; `client` gets none; a scoped non-TA (e.g. viewer) gets rows only if they are on one; a TA/TA Support gets rows where `isTicked || notApplicable`. A TA does NOT see unticked rows even if named on one. TA Support has no extra strategy rights; the "see every TA's rows" difference applies to Excel Tables only. TAs see colleagues' rows on the same job (read-only; `isRowMine`).

The "workday gate" and collision lock (`ownerTaId`) do not touch strategies.

## Invariants and safety

- Authorization is decided on the row's own opening, never the form's `openingId` (`authorizeOn`, `strategyRowOf`; comment at the top of the section). Keep new actions on this pattern, and call `primeStore({openingId})` first or `repo` throws "not primed".
- Nothing a TA writes reaches the lead before Submit: `doneAt`, `note` and proof visibility (`submittedAt`) are only set by `submitStrategyRows`. Do not add a path that writes `doneAt` from the TA side without submit (8 Oct design, 823ee20).
- Visibility is enforced in data reads (`scopeStrategies`), because every assignee can open every page of an opening; do not rely on hiding a link or a page-level check.
- Proof safety (8 Oct): type is read from file bytes; SVG/HTML refused because the image is served from this origin; served with `nosniff`, `no-store`, CSP sandbox and the type the code recorded; unauthorised readers get 404 not 403; size is checked from `content-length` before the body is read; an orphaned upload is deleted if the row disappears. Opening delete must delete storage files first (done in `openingDelete.ts`).
- Retire, don't delete: retired strategies keep their rows and appear tagged; `strategyName` is a snapshot so renames/retirements never change history. There is no delete action for catalogue entries.
- Idempotent assignment: a TA twice on a row is a no-op (`added=false`, no second ack, no second bell). A row has at most one entry per strategy per job by lookup only (no DB uniqueness); concurrent first-clicks by two sessions could create two rows (commit conflict detection mitigates; unverified).
- Bell throttles: 30 s per (TA, job) for assignments, 5 min per (TA, job) for submissions, so a lead clicking through the list gives one chime (20 Oct, f4c1218, plus the debounce comment in actions.ts). The bell text never names strategies.
- Acceptance is grandfathered by absence of data (19 Oct, 6c8b497): do not "fix" a missing `acknowledgements` into pending, and do not write a production backfill; adding a TA always writes an entry.
- Colombo-day rules: store and compare dates as the start of the Colombo day; never `toISOString().slice(0,10)` or server-local Date (13 Sep audit finding 16, referenced in `calendar.ts`). "Used" without a date = `colomboDayStart(Date.now())`.
- Pending-acceptance rows cannot be submitted or have proofs attached; a TA not on a ticked row can still join by filling it in.
- Repo hard rules apply: no laptop deploys or `convex run` against live; the catalogue seed is a `dryRun`-able internal function run only by the pipeline.

## Known quirks, gaps and unverified items

- `DESK_STRATEGIES` (19) is only the sample/test list; live contents may differ (names are editable). Whether `seedCatalogue` has been run on live is unverified.
- Both bells use type `strategy_assigned`, so the lead's "A TA submitted strategies" is routed to `/openings/<job>/strategies` (the TA tab, which for a lead just shows a link to the planner), not to `/strategy/<job>`.
- `bellDue` is in process memory: restarts and multiple instances reset/duplicate the throttle. If a bell mutation fails it is only logged and the throttle slot is already spent.
- The bell is skipped when the lead assigns themselves (`taId !== user.id`) and when the job has no `taLeadId`.
- The assignee dropdown lists every active non-client user (including leads, admins, viewers). A viewer put on a row gets a strategy-only sourcing seat (read-only) and could hit `strategy.work` checks but cannot attach proofs (`mayAttachProof` needs `isTa`); the TA table `isRowMine` treats rows with nobody on them as everyone's.
- Removing a TA keeps `selected = true` and the row; `selected = false` with TAs still on it keeps the TA's `onStrategy` access though they no longer see the row.
- Unticking after a TA submitted hides the row from the TA but keeps data; the lead still sees `doneAt`/note and submitted proofs.
- Lead edits to `doneAt`/`note` overwrite the TA's submission with no audit; `submittedBy/At` are not updated by lead edits.
- `PROOF_MAX_PER_ROW` counts every adder's proofs (several TAs share a row); `removeStrategyProof` has no 'submitted' lock.
- `/strategy/[openingId]` 404s for non-open jobs, but the TA tab still works for any status, so a job put on hold keeps its TA rows while disappearing from the planner.
- `plannerByTa` and `setStrategyAssignedDate`/`removeStrategyRow` (store) have no current UI caller (`removeStrategyRow` has no action at all); candidates for cleanup, keep tests in mind (`plannerByTa` is tested).
- Unverified: mobile apps beyond the nav flag, partner-read exposure of the tables, behaviour under concurrent first-row creation.
- `ProjectSidebar` shows "Strategies" to every `canSeeSourcing` seat, including leads; `mobile/openings.ts` mirrors that.

## How to change it safely

Where to edit:
- Rule/visibility change: `src/lib/auth.ts` (capabilities), `src/lib/visibility.ts` (`scopeStrategies`, `seatFor`), `src/lib/strategyPlanner.ts` (`isTicked`, counts, acceptance, proof visibility). These are pure and tested; start with the test.
- New behaviour on a row: store mutator in `src/data/store.ts` (~3377-3680), server action in `src/app/actions.ts` (+ `*Inline` wrapper), UI in `StrategyLeadTable` / `StrategyTaTable`, view-model in `leadLine` or the `rows` map in `openings/[id]/strategies/page.tsx`.
- New stored field: update ALL of: `convex/schema.ts` (make it `v.optional(...)`; widening only, no migration), `src/data/types.ts`, the nullable list in `convex/ta/model/tables.ts`, `newStrategyRow` and `strategyRowIsEmpty` in `store.ts`, `leadLine`/TA row mapping, and tests. A required field needs a migration (internal function with `dryRun`, run by the pipeline) - never an ad-hoc script.
- New table/column set: add to `WHOLE` (`convex/ta/tables.ts`), `WHOLE_TABLES` (`src/data/prime.ts`), `blank()` (`primeState.ts`), `store.ts` empty db, openings delete (`openingDelete.ts` `OPENING_CHILDREN` and `store.ts` lift list), `testSweep.ts`; `tests/strategy.test.ts` "The tables are in every list the Convex store needs" greps these.
- New notification type: must be in `convex/schema.ts`, `convex/ta/notifications.ts` (union + `href`), and the bell's link logic; `tests/strategy.test.ts` and `tests/notificationSound.test.ts` assert the strings.
- Change who is "on a job" through strategy: `onStrategy` is copy-pasted (see Access); grep `strategyAssignments(` with `doneBy.includes` and change all, or factor one helper first. Changing it silently changes opening visibility, CV access (`cvAccess.ts`), profile writes and mobile.
- Anything shown to or sent to people (copy, bell text, who is notified, who sees which row) is a product decision: flag it for the owner rather than choosing.

Tests (plain Node scripts run by `tests/run.mjs`; filter with an argument):
- `tests/strategy.test.ts` - capabilities, who sees which row, list rules, Colombo dates, assign/accept/tick/N/A/submit flows against the JSON store, `strategyTable`, `countsOf`, and the "tables are in every list" source greps.
- `tests/strategyproof.test.ts` - `sniffImage`, `checkProofUpload`, `mayAttachProof`, `mayOpenProof`.
- `tests/notificationSound.test.ts` - bell link, `bellDue` 30 s (it asserts the literal `ms = 30_000` in actions.ts source), `type: "strategy_assigned"` present.
- Related: `tests/tasupport.test.ts` (isTa), `tests/mobile-openings.test.ts` (uses strategy seat).
Commands (repo root): `npm test` (all), `node tests/run.mjs strategy` (just these), `npx tsc --noEmit -p .`, `npx tsc --noEmit -p convex`.

Pre-merge checklist: tests above pass; both tsc runs clean; any new action calls `primeStore` and `authorizeOn`; any new read goes through `scopeStrategies`; `revalidateStrategies` called on writes; `markTablesStale` for route handlers; dates via Colombo helpers; new Convex field is optional and in the mapping list; no live-backend command used; user-visible copy/bell/visibility changes called out for the owner; update this skill and stamp it (`node .claude/skills/skill-sync/staleness.mjs stamp strategy-planner`, coordinator does this).

Repo hard rules in play: never touch the live backend from a laptop (`convex run`, `deploy`, `import`, `env set` against api.career141.com); work on `<person>/<topic>` branches via pull request; data changes are `dryRun` internal functions run by the pipeline; outbound to candidates must use `convex/lib/outreachSafety.ts` and `convex/lib/outboundGuard.ts` (strategies send nothing to candidates, only in-app bells to staff); never set `OUTREACH_LIVE`.

## History

- 2026-10-08 `823ee20` (HDBinath) Strategy Planner v1: per-job table of strategies, lead assigns "Done by", dates and N/A; TA sees only own + struck rows, submits with proof pictures; capabilities `strategy.assign/manage/work`; `scopeStrategies`; tables `strategies` and `strategyAssignments`; `seedCatalogue` (15 names); proof route with sniffing/5 MB/5 per row; bells on assign and submit with `bellDue`.
- 2026-10-09 `f37874d` (HDBinath) Lead's layout: one jobs table opening in place, tick box (`selected`, optional field, no data change), `updateStrategyLine` saves each edit, TAs see every ticked row and may fill one nobody put them on; four strategies added (Aura, ChatGPT, Gemini, Linked Post).
- 2026-10-09 `39618c9` (HDBinath) TA Support role: all "is this a TA" checks go through `isTa`, so strategies treat ta and ta_support identically.
- 2026-10-16 `2f2b402`, `18375a8` (Gajani-uruthi) "strategy changes/updated": TA table rework showing colleagues' rows (`isRowMine`), `onStrategy` introduced so a TA put only on a strategy can open the job (layout, sourcing gate, candidate/pipeline pages, CV access).
- 2026-10-16 `622159b` (sanjeev200009) Fix: strategy assignment grants sourcing read access only, not `opening.act`.
- 2026-10-16 `734c1ca` (sanjeev200009) Fix: strategy-only opening load - the layout no longer queries Midday/EOD for a seat that cannot act (the backend refused it and left the page loading).
- 2026-10-19 `6c8b497` (HDBinath, PR #217) Batch assignment acceptance: `acknowledgements` on rows, "Accept all N" button, pending badge on the planner, grandfathering of rows without an entry.
- 2026-10-20 `f4c1218` (HDBinath, PR #225) Notification chime: Web Audio bell and tab-title flash in `NotificationBell`, AudioContext unlock on interaction, bell polling every 10/20 s, `/api/notifications` and `listForUser` href for `strategy_assigned`, 30 s debounce wording in `bellDue`; `tests/notificationSound.test.ts`.

<!-- skill-meta
verified-commit: d078fcb
verified-hash: 7e780d846370e2f87cceee2b4459ec18ccbc1048
verified-date: 2026-10-27
sources:
  convex/ta/strategies.ts
  convex/ta/notifications.ts
  convex/ta/tables.ts
  convex/ta/model/tables.ts
  convex/ta/openingDelete.ts
  convex/schema.ts
  src/app/strategy/**
  src/app/openings/[id]/strategies/page.tsx
  src/app/openings/[id]/sourcingGate.ts
  src/app/openings/[id]/layout.tsx
  src/app/api/strategy-proof/route.ts
  src/app/api/notifications/route.ts
  src/app/actions.ts
  src/components/StrategyLeadTable.tsx
  src/components/StrategyTaTable.tsx
  src/components/NotificationBell.tsx
  src/components/TopNav.tsx
  src/components/ProjectSidebar.tsx
  src/lib/strategyPlanner.ts
  src/lib/strategyProof.ts
  src/lib/visibility.ts
  src/lib/auth.ts
  src/lib/cvAccess.ts
  src/data/store.ts
  src/data/types.ts
  src/data/prime.ts
  src/data/primeState.ts
  src/data/seed.ts
  tests/strategy.test.ts
  tests/strategyproof.test.ts
  tests/notificationSound.test.ts
-->
