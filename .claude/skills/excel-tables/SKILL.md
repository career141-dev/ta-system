---
name: excel-tables
description: The Headhunting rail of an opening - Overview, Research (8 fields + Benchmark), Suggestions (3 rounds, Select/Not selected), Excel Tables (link vault, L-sheets, interest tabs, iMark, paste, export), Referee Calls - plus the Chrome capture extension. Aliases - link vault, linkVault, L1/L2, headhunting, hh, iMark, eye-mark, Excel Table, capture extension. Use when changing, debugging or extending any of these.
---

# Excel Tables and the Headhunting rail

## Scope and boundaries

In this skill: everything under `src/app/openings/[id]/hh/` (layout, Overview, `research`, `suggestions`, `links`, `referees`), the `linkVault` table and every action on a row, L-sheets, interest tabs, iMark, paste/export, the CV matcher for LinkedIn rows, the Chrome extension (`extension/`, `/api/extension/*`), the Research / Benchmark / Suggestions engines and their search providers, Referee Calls, Company Reference, and the workday checks these pages feed.

Neighbouring skills (do not duplicate, link instead):
- /follow-up - what happens after a row becomes an application (TA Follow-up, Director review). `pipelineFromLink` hands over to it.
- /sets-shortlist - set numbers and the shortlist claim (`backend.shortlist`). /scoop - Scoop uploads. /strategy-planner - strategy table (a strategy seat counts as `onStrategy` for sourcing access).
- /workday - the check engine (`convex/lib/workdayChecks.ts`, `src/lib/workdayRequirements.ts`); this skill only says which checks Excel Tables / Suggestions / Research feed.
- /eod-email - the EOD workbook, referee-calls section and iMark block in the composer. /email-intake and /cv-extraction - CVs arriving and being read (HH upload goes through the cv-extraction pipeline). /voice-agent - unrelated. /database-search - Candidate Search and Referral Search (`/database/referral`). /openings - opening creation, JD approval, work locations.

Code is the source of truth. Anything marked "(unverified)" was not confirmed in code.

## How it works now

### Architecture in one paragraph
Pages are Server Components; each calls `primeStore({ openingId })` (src/data/prime) to load tables into the in-memory `repo` (src/data/store.ts), reads from `repo.*`, and writes with `repo.*` mutators that go through `mutate()`. In Convex mode (`isConvex()`) each user action is flushed as one transaction through `convex/ta/commit.ts:apply` (row ops with before/after, conflict-checked; tables map via `convex/ta/model/tables.ts`). Server actions in `src/app/actions.ts` authorize with `authorize(formData, capability, {link|suggestion|benchmark|opening: field})`, which resolves the row's opening and owner via `repo.openingOf` (for `link`: the owner is the adder unless the adder is desk-wide) and then calls `can()` (src/lib/auth.ts). Client buttons use `*Inline` wrappers (`inline()` + `useInline`) so the answer shows under the row.

### Flow 1 - Headhunting gate and Overview
- `hh/layout.tsx` calls `requireSourcingSeat(id)` (`src/app/openings/[id]/sourcingGate.ts`): `seatFor(user, assignment.role, onStrategy).canSeeSourcing` else `redirect("/unavailable")`. Client seats never pass. Reference, database, snippets, eod use the same gate.
- `hh/page.tsx` (Overview): counts from `repo.linkVault(id)` - Links, Approached (`outcome !== "no_contact"`), Reached a CV (`cv_received|shortlisted`), eye-mark yield (3 eye-marks is the target text), "Next" tiles (not-yet-approached links, `<3` eye-marked, Benchmark not chosen - this tile is always shown, it does not check state). It does NOT use `scopeLinks`, so a TA sees opening-wide counts here (verify before relying). It runs `after(() => matchUnchecked(id, user.id))`.

### Flow 2 - Add one link (`addLink`, actions.ts)
Trigger: `AddLinkForm` (src/components/AddLinkForm.tsx) via `addLinkInline`. Actor: anyone with `opening.sourcing` on the opening.
1. `opening.sourcing` authorize; empty url -> "Paste a LinkedIn profile link first."
2. `profileLink(typed)` (src/lib/url.ts) -> `{url, key, guessedName}`; not a profile -> "That is not a LinkedIn profile link. It should look like linkedin.com/in/their-name." Accepts without https, locale hosts, tracking params (21 Sep).
3. Optional lead note (`note` field): `checkLeadNote` needs capability `link.note` (desk-wide only) and <= `LEAD_NOTE_MAX` 2000 chars; checked before anything saves.
4. Duplicate rule (22 Oct): `repo.findLinkByUrl(openingId, key, rowCountsFor(user, deskWide))`. Only YOUR row (or a desk-wide user's row you can see) counts. Another TA holding the same person does NOT block. If found: note "<name> is already in this table, added by <who>." (+ " Your note was added to that row." when a lead note was typed; the note goes on the existing row via `repo.addLeadNote`). Returns via `note()`, nothing new is added.
5. `requireWorkLocation(opening, workLocationId)` (src/lib/workLocations.ts): throws on a job with locations when none chosen.
6. `repo.addLink(openingId, url, userId, name, "shortlisted", locationId, level)`: id `lv_*`, `sourcingChannel: "L"`, `outcome: "shortlisted"` (21 Sep: "Not contacted" made saved profiles look untouched), `isAddOn: true` when `repo.workingStage(opening,user) === "Add-on"`. Level: chosen L if it is one of the TA's live levels, else `latestLinkLevel`, else it starts a new L automatically (15 Oct - TAs pasted into All before noticing the +). A single non-archived work location is applied automatically.
7. `matchLink(id, user.id)` (src/lib/cvMatch.ts) then `heldLine` message. Final message ends with `alsoHeldLine(otherHolders(...))` ("X also has them in their table - whoever shortlists them first works them.").

### Flow 3 - Paste many rows (`addLinksBulk`, 26 Oct, PR #291)
`PasteLinksForm` inside AddLinkForm ("Paste many rows from an Excel sheet"), `addLinksBulkInline`. `parseLinkPaste` (src/lib/linkPaste.ts): lines split on tab; the cell containing `linkedin.com/in/` is the url; first cell that is 9-15 digits (after stripping spaces `-()+.`) is the phone (`phoneSource: "other"`); bare 1-4 digit cells (row numbers) dropped; remaining cells joined with " · " become a TA note (`repo.addLinkTaNote`, sliced to 1000). `PASTE_MAX = 100` rows -> "That is N rows. Paste up to 100 at a time."; no links -> "No LinkedIn profile links in what was pasted...". Each row: `profileLink`, skipped if the TA already holds it (`there`), else `addLink` as Shortlisted into the chosen `level`. Summary message counts added / already there / not profiles / lines with no link; names are guessed from slugs ("check them"). No `matchLink` is run per row (matchUnchecked picks them up on the next page load, 10 at a time).

### Flow 4 - Row actions (LinkRow.tsx -> actions.ts)
All need `opening.sourcing` with `{link:"entryId"}` unless noted; an `ownerTaId` (row adder, a TA) other than the caller is refused: "That row is another recruiter's. Their table is theirs to work."

| Button | Action | Effect / guard |
|---|---|---|
| Change outcome / Save | `updateLink` | outcome (`no_contact, contacted, responded, cv_received, shortlisted, declined, unreachable`), phone, phoneSource, name, company; `repo.updateLink` stamps `outcomeAt` when outcome changes (the EOD L EFFORT counts it); re-runs `matchLink` |
| Log approach | `logOutreach` | pushes `{at, channel, note, by}` to `conversationLog`; `no_contact` becomes `contacted`; empty note refused |
| iMark | `toggleEyeMark` | flips `isEyeMarked`, sets/clears `eyeMarkedAt` |
| Add-on | `toggleLinkAddOn` | `isAddOn` by hand |
| Interested / Not interested | `setLinkInterest` | see Flow 5 |
| Add to pipeline | `addLinkToPipeline` | `pipelineFromLink`; from the edit panel it first saves the typed fields and forces `outcome: "shortlisted"` |
| Same person / Different person | `decideCvMatch` | `decideMatch`; "different" refused if the linked candidate is already on this opening's pipeline |
| Find CV | `findCv` / `chooseCv` (FindCvButton) | `findCvCandidates` (<=5 hits), `linkRowTo`; chosen person must be in a fresh search |
| TA note | `addLinkTaNote` / `removeLinkTaNote` | `opening.sourcing`; <= 2000 chars; remove by author or desk-wide |
| Lead note | `addLeadNote` / `removeLeadNote` | capability `link.note` (desk-wide), author-only remove; `leadNotes[].byRole` stored at write time; does not touch outcome or log |
| Remove from table | `deleteLink` | hard delete of the linkVault row (not a soft delete). Message "Link removed from table." |
| Location chip | `assignWorkLocation` / `assignSelectedWorkLocations` | row adder or desk-wide only; bulk cap 25; backend `ta/workLocations:assign` (atomic with the linked application; refuses when an email is mid-send/uncertain, or the candidate was already sent for review) |
| Company Reference | `getCompanyReferences` (CompanyReferenceSection) | `opening.sourcing`; lists database colleagues at the row's company (6 at a time); needs an `openingId` ("Open this from a job.") |

Bulk (checkbox bar, `BULK_FORM = "bulk-links"`): `addLinksToPipeline` (loops `addLinkToPipeline` through `eachInline`, each with its own checks), `moveSelectedCandidates` (rows must already be on the pipeline: "Add this candidate to the pipeline first."), `assignSelectedWorkLocations`. iMark is never changed by bulk selection (14 Oct).

### Flow 5 - Interest (Interested / Not interested / Pending), PR #83 (29 Sep)
Interest is derived, never stored: `interestOf(row, app)` in src/lib/linkViews.ts. Application closed (`rejected|dropped_out`) -> not_interested; application present and stage not in `{matched,new_cv,ai_follow_up}` -> interested; else row.outcome `declined` -> not_interested; else pending. `rowApplication` (src/lib/sharedLinks.ts) hides an application owned by another TA from a TA's row (`takenBy` shown instead); a desk-wide adder's row keeps showing the owner's progress.

`setLinkInterest` (needs BOTH `opening.sourcing` and `opening.act`):
- interested: `repo.updateLink({outcome:"shortlisted"})`, then `pipelineFromLink`; on error the old outcome is restored and "Failed to update candidate status. <msg>".
- not_interested: reason required ("Say why they are not interested - for example, happy where they are."), leading "not interested" words stripped, max 300 chars. Row `outcome: "declined"`. If the row has an open application: collision lock (`can opening.act` with `ownerTaId`) then `backend.moveStage(..., "rejected", "Not interested - <why>")`; failure restores the outcome. If no application: `repo.linkToApplication(entryId, user, {rejected})` creates it directly as Rejected (no follow-up started, nothing sent) and logs a `rejected` event. Already rejected/dropped: only the reason is logged (`logOutreach(entryId, user, "Not interested", why)`).

### Flow 6 - Row to pipeline (`pipelineFromLink` -> `repo.linkToApplication`)
1. iMark rows need a CV first: `eyeMarkedHasCv` else "Receive and link their CV before adding this eye-marked profile to the pipeline."
2. `repo.linkToApplication` refusals: row not `shortlisted` ("Set the outcome to Shortlisted first."), no name ("Add their name first..."), unanswered possible CV match ("This may be X, already in the database. Say on the row whether it is the same person first."), person already on the opening under another work location.
3. Candidate resolution: row.candidateId, else a candidate with the same LinkedIn address, else new `ca_*`. An existing candidate is only filled where blank (linkedinUrl, phone, title, employer, location) - never overwritten (1 Oct). New application `app_*` at `ta_follow_up` (or `rejected`), note "Headhunted - shortlisted in Excel Tables by <name>", `isAddOn` carried from the row.
4. Back in `pipelineFromLink`: if the application's `ownerTaId` is another TA (and caller not desk-wide): "<who> shortlisted them first - they are working them (in <stage>)." (22 Oct). Rejected/dropped -> `reinstate`. `matched|new_cv` -> treated as follow-up. Other stages -> note "Already on this opening's pipeline, in <stage>."
5. Convex: `backend.shortlist` (claim + set number) then `backend.moveStage(..., "director_review")`. Claim failure -> note "Added to TA Follow-up, but they were not claimed..."; claimed by someone else -> error; move failure -> note "Shortlisted - in TA Follow-up. Director review needs their CV, current and expected salary and notice period...". Success: "Added to the pipeline and moved to Director review."
6. Way back: `moveBackToTables` (opening.act with collision lock) moves to `dropped_out` with `BACK_TO_TABLES_REASON`; refused if offers/placements exist; upcoming interviews are cancelled; re-adding reuses the same application (29 Sep).

### Flow 7 - L-sheets
Storage: not a table; a JSON array in `taSettings` key `link_levels:<openingId>:<userId>[:<workLocationId>]` (`repo.allLinkLevels/saveLinkLevels`, entries `{at, name?, deleted?, deletedAt?, movedRows?, importedFrom?}`; `n` is the array index + 1). Each TA numbers their own.
- `addLinkLevel` (sidebar "+" in ProjectSidebar, or "+ Add L-sheet" in the table when the job has work locations; the sidebar + is hidden when `locationSheets`): `nextLinkLevel` = lowest deleted number no row of this TA still holds, else length+1 (22 Oct). Redirects to `?level=n[&location=][&by=]`.
- `renameLinkLevel`: name sliced to 40; blank restores the date. Returns "L<n> is not one of yours here." for a stranger's.
- `deleteLinkLevel`: rows keep existing, `level=null` (tab "Not in a sheet"); ids kept in `movedRows`. `restoreLinkLevel` within `LINK_LEVEL_UNDO_MS = 10 * 60 * 1000` (store.ts) puts them back unless the number was re-taken; redirect carries `?deleted=<n>` for the Undo bar.
- Sheets belong to one person (22 Oct, c842bec): `sheetOwner(viewerId, seesEveryone, by)`; desk-wide and TA Support on "Everyone" have no L tabs, they pick a name under "Added by" first (`by` must match `/^[\w-]{1,64}$/`). `inSheet` and `NO_SHEET = -1` (`?level=none`) in src/lib/linkViews.ts.
- Date filter: `?day=today|yesterday|week|YYYY-MM-DD` by Colombo calendar (`colomboDay`, `inDay`).

### Flow 8 - Table view (`LinkVaultTable`, links/page.tsx)
Page is `force-dynamic`; calls `primeEyeMarked`, `after(matchUnchecked)`, renders `CaptureSetup` (extension token panel, `extensionToken()`), `LiveTableRefresh`. Query params: `location, q, status, level, addons, imark, by, day, deleted, page, view(legacy), msg, tone`. Filters are all over the same rows (`pass()`); counts on each tab = what pressing it shows. `PAGE_SIZE = 25`; rows come from `repo.linkVault` newest first (5 Oct, #124). Search `matchesQuery` over name, title, company, linkedinUrl, phoneNumber. Per-TA "Work by person" cards for desk-wide / TA Support on Everyone (links, today, hourly spread in Asia/Colombo, sheet counts). iMark filter shows `HhUpload` ("Upload headhunted CV" -> `convex/ta/hhUpload.ts:queue`, channel `HEADHUNT_CHANNEL = "headhunting"`) and per-row progress text from `visibleEyeMarked`. Work location tabs (`WorkLocationTabs`, `workLocationView`): unassigned rows show under "Location not assigned"; adding is blocked there.

### Flow 9 - Export (`LinkExportMenu` -> `/api/openings/[id]/links/export`)
Menu offers Copy (fetches `?format=json`, writes TSV + HTML via `src/lib/spreadsheetClipboard.ts`) and downloads. Route GET: 401 unauthenticated, 404 no opening, 403 client role or no access (allowed = desk-wide, `opening.sourcing`, `opening.read`, in `assignedTaIds`, or has own rows); `workLocationView` invalid -> 400. Rows = `getScopedLinkVaultEntries` (scopeLinks + work location) then the same `pass` cut as the screen, or everything with `all=1`. `buildLinkExportLayout` (src/lib/linkExport.ts): one sheet per (adder, level); sheet name = owner name truncated to fit 31 chars + " L<n>" or " Not in a sheet", uniquified (`uniqueSheetNames`); sorted by owner name then level; inside a sheet sections "Interested", "Pending", "Not Interested" with a blank row between; headers `EXCEL_TABLES_EXPORT_HEADERS = ["Candidate Name","Links","Status","Notes"]`; Notes = latest lead note (hidden from `client` role) else latest TA note else latest approach. Formats `xlsx` (default, `buildXlsx` with hyperlinks), `tsv`, `json`. Filename `excelFilename(client, position, location?)` = "Client - Position - City - YYYY-MM-DD.xlsx" (parts cleaned, 60 chars each; 21 Oct, 23fc0f3). `buildOpeningExcelAttachment` reuses the layout for the EOD email attachment (see /eod-email).

### Flow 10 - CV matching of LinkedIn rows (28 Sep c53414b, 1 Oct)
`matchLink(entryId, actorId)` in src/lib/cvMatch.ts skips rows with a `candidateId` or an answered match. Profile = url, name, phone, company, title, location, employers, jobs with years (`captureHistory`/`jobYears`), schools. Convex: `ta/candidates:findSamePerson`; local store: `samePerson` loop (convex/lib/samePerson.ts, shared pure rules; tested by tests/sameperson.test.ts). Verdicts: `same` (same LinkedIn / email / phone, or same full name + common employer) links `candidateId` immediately and calls `ta/candidates:rememberLinkedin`; `possible` waits for a TA; a candidate whose own LinkedIn is a different profile is never matched. No result writes `cvMatch: null` so it is not re-asked (known gap: a CV arriving later is not linked back). `decideMatch`: "different" on an auto-link unlinks and calls `ta/candidates:forgetLinkedin`. `matchUnchecked(openingId, actorId, max = 10)` runs after page render (Overview and links page). `findCvCandidates` -> `ta/candidates:searchSamePerson` (limit 5) with strengths `same|possible|name`.

### Flow 11 - Chrome extension capture (`extension/`, v0.3.0)
- MV3 (`manifest.json`): permissions `storage, activeTab`; hosts `*.linkedin.com`, `http://localhost/*`, `https://ta-system.career141.com/*`; content script on `linkedin.com/in/*`, `/talent/profile/*`, `/talent/hire/*`. `content.js` only reads the page already open and only when the TA presses its floating (draggable, position persisted 30 Sep) button; no crawl, no timers, no navigation - this is a stated legal/product line, do not add any. It sends `{type:"capture", profile}` to `background.js`, the only code that talks to the platform (header `X-C141-Token`). `popup.js` stores `platformUrl, token, userId, openingId, workLocationId` in `chrome.storage.sync`, history (25 entries) in `storage.local`. Installed by hand (Load unpacked); updates are sent to TAs by hand (5 Oct, 9cf6388).
- `GET /api/extension/openings?userId=` (`src/app/api/extension/openings/route.ts`): token check; missing `userId` -> 426 `extension_out_of_date` (0.2.0 copies); lists only that recruiter's open openings where `can opening.sourcing` and non-archived `workLocations`, and the active TAs (`extensionUser`).
- `POST /api/extension/capture`: errors `bad_token` 401, `bad_json` 400, `unknown_opening` 404, `unknown_user` 403, `not_on_opening` 403, `not_a_linkedin_profile` 400, `not_one_profile` 422 (a Recruiter list page with no profile id, 5 Oct), `invalid_location` 400, `different_location` 409. Flow: `normaliseCapture` (src/lib/extension.ts: trims, caps - experience 25, education 15, skills 60, about 4000) -> canonical url -> existing row = own `findLinkByUrl` or `findLinkByPerson` (same full name + same company, catches LinkedIn vs Recruiter) -> update in place or `addLink(..., "shortlisted")` -> `repo.updateLink` fills name/title/company (never clears typed values), phone from profile only if none (`phoneSource "profile"`), stores `capture` -> `matchLink` -> revalidate. Reply `{status: "added"|"updated", id, addedByName, alsoWith, match, name, openingTitle, openingUrl}`.
- Auth model: one shared token in taSettings key `extension.token` (created on first read, shown by `CaptureSetup`; constant-time compare in `authorised`). Only active TA / TA Support ids can be named (`extensionUser`, 2 Oct e5d6225); the named user must also pass `can opening.sourcing`. CORS is `*` with `OPTIONS` handlers.

### Flow 12 - Research (`/hh/research`)
- Page: `Generate` bar (`runResearchInline`, needs web search + model; `aiStatus`), "Wrong company? Correct it" form (`correctClientAndRerun`), eight `ResearchField`s (`RESEARCH_FIELDS` in src/lib/workdayRequirements.ts: similarDesignation, websiteLink, servicesProvider, country, location, competitors, socialMedia, companyOverview), competitor profiles list, sources, Benchmark section. `ResearchConfirmation` ("I reviewed the research", with per-field unavailable reasons) shows only when `repo.workingStage(id,user.id) === "100%"`.
- `runResearch` -> `researchOpening` -> `alone("research:<opening>")` (in-process `runningNow` set; a second press returns reason "running") -> `researchOpeningNow`: one run per opening for the whole desk (23 Sep, 83ce18e/2666afa); a second run is refused with reason `run_spent` unless the caller is desk-wide (`canRerun`); the report row is the record. Engine `researchViaSearch` (src/lib/researchSearch.ts): search client + competitors, read pages (`readPage`, default 1200 chars), model only sorts text handed to it ("plan" task, deepseek-v4-flash by default via src/lib/ai.ts), every address comes from a search result. Benchmark also runs inside it when `benchmarkByDefault(title)` (C-level and senior titles only, src/lib/incumbents.ts regex). Hand-edited fields (`editedFields`) survive a re-run. Result stored with `repo.saveResearch` (`researchReports`: fields, editedFields, markdown, sources, searches, model, generatedBy, generatedAt).
- `editResearchField`: `opening.sourcing`; marks the field edited; list fields split on `;` or newline.
- Benchmark: `runBenchmark`/`runBenchmarkInline` (BenchmarkButton) - needs search configured; once per opening unless desk-wide (`benchmark_spent`); `findIncumbents` reads leadership pages then web; rows without a source are dropped (src/lib/headhunt.ts `parseBenchmark`, incumbents); `saveBenchmarks` keeps ticks by `name|company`. `pickBenchmark` toggles `isSelected`; ticked companies become `targetEmployers` of the next Suggestions round. Kinds: incumbent, predecessor, competitor; confidence high/medium/low.
- Correct client: `correctClientAndRerun` (28 Sep, ae6d9b9): requires notes, refuses unchanged notes, saves `researchNotes` on the CLIENT (`ta/clients:update` in Convex), then in `after()` clears benchmarks, reruns Research with `canRerun=true`, dismisses `new` suggestions (`dismissNewSuggestions`, not marked not-relevant), reruns Suggestions with `extraRound=true` (past MAX_ROUNDS).
- Auto-start: `approveJd` (JD approval, not opening creation) runs Research if none exists and the first Suggestions round if none, in `after()`, owned by `assignedTaIds[0]` (so a lead approving does not own the list). Check /openings before changing this.

### Flow 13 - Suggestions (`/hh/suggestions`)
- Engine entry `sourceFor(openingId, forUserId, extraRound, learnedFrom?)` -> `alone("suggest:<opening>")` -> `sourceForNow`: `round = max(existing.round)+1` (a learning run is `round 0`); `round > MAX_ROUNDS (3, src/lib/sourcing.ts)` and not `extraRound` -> error `rounds_spent`. Rounds are the opening's, counted over all TAs' runs (21 Sep "works once" bug: the page must count every run, not only visible ones). `alreadyKnown` = canonical profiles of all linkVault rows + existing suggestions. Spec passed: title, client, `researchNotes`, JD text (`withJobDetails`), locations, nationalities, gender, salary note, `targetEmployers` = ticked benchmarks, and the desk's choices (`deskSignalsFor`, 28 Oct): `picked` = candidates in TA Follow-up or later (`PICKED_STAGES`, AI Follow-up excluded) as title/employer/years/industries/skills, `selected` = kept suggestions, `notSelected` = dismissed with feedback `not_relevant` (rows set aside by `dismissNewSuggestions` carry no feedback and teach nothing). No reasons are asked of TAs.
- `runSourcing` (src/lib/sourcing.ts): needs `serperConfigured()` (true when `claudeSearchEnabled()` or any provider) else `no_serper`. If `claudeSourcingOn()` (C141_CLAUDE_SEARCH=on + token) -> `claudeHeadhunt` (src/lib/claudeSourcing.ts, `CLAUDE_MAX_PEOPLE = 8`, timeout 12 min, only people whose link a WebSearch result returned; never anyone at the client). Accuracy bar (28 Oct): the prompt makes Claude set five must-haves (FUNCTION, LEVEL, YEARS, INDUSTRY, LOCATION), run one more search per promising person, keep only those shown to pass all five (unknown is not a pass), add `deskSignals` lists, and answer `years`, `level` (far_below..far_above), `sameFunction`, and `why` as one tick per must-have. `readHeadhunt` drops `level` far_*, `sameFunction` not true, or no headline and no company (counted in `rejected`), and returns the WebSearch queries it ran (the page used to say "0 searches"). If Claude finds nobody it falls through to the old six-stage pipeline (plan -> queries -> search with page 2 for the top 4 -> filter -> enrich -> judge; 6 parallel searches), which does not use the desk signals. Result rows `{tier: priority|screen, why, concern, round}`.
- Rows are saved with `generatedFor: forUserId`, `keptBy: null`; `recordSourcingRun` (`convex/ta/workdays.ts`, table `taSourcingRuns`) records the run for the workday check. A learning run saves `learnedFrom: N`, `generatedFor: null` (visible to every TA) and records no sourcing run.
- Learning runs (`learnFromPicks`, actions.ts, 28 Oct): called by `src/app/openings/[id]/layout.tsx` on every opening page view by a user with `opening.sourcing`. Due when round 1 exists and picked count reaches 2, 5, 8, 11… (`2 + 3*floor((n-2)/3)`) above the highest `learnedFrom` on file; runs in `after()`. An attempt is remembered in memory for an hour per opening (`learnTriedAt`, per server, lost on restart) so a run that finds nobody is not repeated on every view. The backend moves people into TA Follow-up but cannot run Claude, which is why the trigger is a page view. Rows show "like the N picked CVs" instead of the round.
- Visibility `scopeSuggestions` (src/lib/visibility.ts): a TA sees their own runs (or runs with no owner); profiles kept by another TA appear as "Kept by X / Leave this one alone"; desk-wide sees all.
- Buttons: `keepSuggestion` ("Select": `setSuggestionStatus(kept, by)`, refuses if the same person is already in YOUR Excel Tables, then `addLink` + name/title/company + `matchLink`; message ends `heldLine`), `dismissSuggestion` ("Not selected": no claim), `FindCvButton`, "+ Add a candidate" link to `/hh/links`, `Assistant` chat (`sendChatMessage`, `opening.act`: REFINE (retier/drop, free), SEARCH (note only - does not spend a round by itself), ANSWER; a refine that would drop >= max(3, 70%) of the open list is refused). The Refine button label requires judged suggestions ("steered" count) - a round with no decisions repeats the same search.
- Tabs Pending review / Selected / Not selected, sort strength (priority first, then newest `generatedAt`, so a round-0 learning run sits on top) or recent, `PAGE_SIZE = 20`.
- Workday: `EmptySuggestionsReason` shows when `ta/workdays:suggestionsCheck` says `needsEmptySuggestionsReason` (TA / TA Support only).

### Flow 14 - Referee Calls (`/hh/referees`, table `refereeCalls`, 23 Oct)
Page lists calls for a Colombo work day (`workdayDate`); TAs see only their own, desk-wide and TA Support see everyone's with a TA column; only `isTa` can edit and only for today (`canEdit = editable && locationOk && day === today`). `RefereeCallsGrid` works like Excel (type anywhere, paste a block, Save once; `src/lib/refereeGrid.ts`: `GRID_FIELDS = company, referral, contactNumber, feedback`, `FIELD_MAX` 200/200/100/2000, `MAX_GRID_ROWS = 300`). `saveRefereeCalls` writes add/update/remove as one `repo.saveRefereeCalls` write; refuses non-TAs, a non-today `day`, payload > 400,000 chars, rows not owned by the caller ("Only the TA who logged a call can change it."). `updateRefereeCall` edits one field or sets `result` to positive/negative. Result sorting: `classifyFeedback`/`resultOf` (src/lib/refereeCalls.ts) - pessimistic default negative; "Not interested" is negative (803cf4e); "cannot give ... will pass/call back" is positive; an explicit `result` overrides. The EOD director email includes a Referee Calls section (`RefereeCallsEmailSection`, form field `includeRefereeCalls`, per-call override JSON `refereeCallResults`, `refereeCallsFromForm`); a resend/correction uses the saved copy snapshot. /eod-email owns that email.

### Flow 15 - Reference tab and Referral Search
`/openings/[id]/reference` (outside `hh/`; same `requireSourcingSeat`) lists referees named on CVs of people in Follow-up or later on this opening (`repo.refereesForPipeline`), the backchannel (`?company=` -> `repo.peopleAtCompany`), and `VerifyReferee` -> `verifyReferee` (one `site:linkedin.com/in` search; compares LinkedIn title/company with the CV, never invents). Needs search configured; refuses names with no usable word. Referral Search is `/database/referral` (src/lib/referralSearch.ts, `DbTabs`), owned by /database-search.

## UI surface

| Place | Who | Component / action |
|---|---|---|
| Rail "Headhunting" (Overview, Research, Suggestions, Excel Tables [+ L's], Referee Calls) | seats with `canSeeSourcing` | `src/components/ProjectSidebar.tsx`, `levels` from `src/app/openings/[id]/layout.tsx` |
| Excel Tables top | sourcing seats | `CaptureSetup`, `AddLinkForm` (+ paste), "+ Add L-sheet" (`addLinkLevel`), Undo bar (`restoreLinkLevel`) |
| Tabs/filters | all | sheet tabs, `LinkFilters` (interest tabs, iMark, Add-ons), `LinkSearch`, "Added by", Added (today/yesterday/week/date), "You're viewing" |
| Row | row owner / desk-wide; TA Support read-only on others (`readOnly` hides buttons) | `LinkRow.tsx` (edit panel, iMark, Add-on, Interested / Not interested with reason, Add to pipeline, Find CV, notes, Company Reference, Remove) |
| Bulk bar | rows with checkboxes | `BulkBar` (add to pipeline, bulk stage, work location) |
| Export | scoped rows | `LinkExportMenu` |
| Research / Suggestions | sourcing seats | `Generate`/`GenerateForm`, `ResearchField`, `BenchmarkButton`, `ProfilePanel`, `Assistant` in `src/components/hh/` |
| Referee Calls | TA edits; others read | `RefereeCallsGrid`, `WorkLocationTabs`, Work day selector |
| Extension | TA / TA Support | `extension/popup.*`, floating button in `content.js` |

## Data

| Table (Convex name; app name) | Fields that matter | Indexes |
|---|---|---|
| `linkVault` (app `linkVault`, identity map in tables.ts) | `openingId, addedBy, workLocationId?, linkedinUrl, name, title, company, isEyeMarked, eyeMarkedAt, phoneNumber, phoneSource (mutual_connection, reception_call, internal_db, profile, other), sourcingChannel ("L" for new rows), outcome, candidateId, cvMatch{candidateId, fullName, strength, reasons, hasCv, decided, checkedAt}, conversationLog[{at, channel, note, by}], createdAt, outcomeAt, isAddOn, level, capture (ProfileCapture), leadNotes[], taNotes[]` | `by_opening, by_addedBy, by_workday_added (openingId, addedBy, createdAt), by_workday_outcome, by_url` |
| `taSettings` (app settings) | `link_levels:<opening>:<user>[:<location>]` JSON, `extension.token` | `by_key` |
| `researchReports` | `openingId, clientId, fields, editedFields, markdown, sources, searches, model, generatedBy, generatedAt` | `by_opening` |
| `benchmarks` | name, title, company, linkedinUrl, kind, confidence, note, sourceUrl/Title, `isSelected`, generatedAt | `by_opening` |
| `profileSuggestions` (app `suggestions`) | name, headline, company, location, linkedinUrl, tier, why, concern, status `new|kept|dismissed`, feedback, round, generatedFor, keptBy | `by_opening, by_opening_status` |
| `sourcingChat` | role, body, action refine/search/answer, affected, byUserId | `by_opening` |
| `taSourcingRuns` | jobId, userId, round, count, at | `by_job` |
| `refereeCalls` | openingId, workLocationId, addedBy, `date` (Colombo), company, referral, contactNumber, feedback, lookingFor, `result` (override), refereeId, candidateId | `by_opening, by_opening_user_date` |
| `clients.researchNotes` | set by `correctClientAndRerun` | |
| `taWorkdayCheckNotes` | `unavailableReasons`, `researchVersion/ReviewedAt`, `emptySuggestionsReason/Version/At` | `by_user_job` |

Outcome values: no_contact, contacted, responded, cv_received, shortlisted, declined, unreachable (`LinkOutcome`, src/data/types.ts). Channels: DA, IM, FB, E, L, HH, SCOOP. All tables are in `WHOLE` in `convex/ta/tables.ts` (loaded whole, paged 500/1000). Deleting an opening cascades through `convex/ta/openingDelete.ts` (includes refereeCalls). `convex/integrations/partnerRead.ts` exposes linkVault/refereeCalls/researchReports read-only (see docs/PARTNER-READ-ONLY-API.md). `convex/admin/excelTablesReport.ts:run` is a read-only per-job report (ec0f1f3, tests/excelTablesReport.test.ts).

## Backend wiring

- Writes: `convex/ta/commit.ts:apply` (conflict-checked; `workTables` linkVault/refereeCalls/researchReports/benchmarks run `assertWorkdayScope`; rows with `workLocationId` are validated against the job's locations). Reads: `convex/ta/tables.ts:page`.
- Internal functions used: `ta/candidates:findSamePerson | searchSamePerson | rememberLinkedin | forgetLinkedin`, `ta/workLocations:assign | inventory`, `ta/hhUpload:queue | fileHeadhunt | status`, `ta/workdays:suggestionsCheck | recordSourcingRun | saveCheck`, `ta/eyeMarked:checkEmail` (no caller found in src or convex - unverified whether it is wired; the live gate is the `EyeMarkedChecks` block on the EOD page), `ta/clients:update`.
- One-off migrations (run only by the pipeline with `dryRun`): `convex/ta/levelsToday2909.ts:run` (rows of 29 Sep into L1), `convex/ta/unlevelledLinks1510.ts:run` (unlevelled rows to L1, 15 Oct; takes `openingId`).
- Next API routes: `/api/extension/capture`, `/api/extension/openings`, `/api/openings/[id]/links/export`.
- Crons: none for this feature (verified: no linkVault/research/suggestion jobs in `convex/crons.ts`). Research/Suggestions run inside the server action or `after()` in the Next server (in-process `runningNow` lock, so it is per server instance).
- Search providers (src/lib/serper.ts `search`): Claude WebSearch first when `C141_CLAUDE_SEARCH=on` and `CLAUDE_CODE_OAUTH_TOKEN` set (page 1 only, 60 s timeout, 2-minute process-wide pause after a failure, `C141_CLAUDE_SEARCH_MODEL`, `C141_CLAUDE_SEARCH_CONCURRENCY`), then SearXNG (`SEARXNG_URL` one or several, `SEARXNG_ENGINES` default google,bing,yahoo,duckduckgo,brave, each engine its own request and merged; `SEARXNG_CONCURRENCY` 2, `SEARXNG_MIN_GAP_MS` 700, 12 s timeout, `SEARXNG_TIMEOUT_MS`), or Serper (`SERPER_API_KEY`). `searchProvider()` returns serper | openai | searxng | null. Models: `OPENROUTER_API_KEY`, per-task overrides `C141_MODEL_RESEARCH|RANK|JD|PARSE`; `C141_CLAUDE_SUB_TASKS` can route plan/research/jd through the subscription (`viaSubscription`), `C141_CLAUDE_BIN`. Claude DB-match is a different switch (`C141_CLAUDE_MATCH`, /database-search).
- Kill switches: unset `C141_CLAUDE_SEARCH` (falls back to SearXNG/Serper); no provider configured -> `Generate` shows "Not set up on this system yet" and runs fail with `no_serper`. `SUGGESTIONS_WORKDAY_REQUIRED` (src/lib/workdayRequirements.ts) is a code constant (true since 15 Oct), not an env flag. `MIN_OWN_EXCEL_PROFILES = 1` (14 Oct, "temporarily").

## Access and roles

- Capabilities (src/lib/auth.ts): `opening.sourcing` (all link, research, suggestion, benchmark, iMark, notes by TA, matching, export view), `opening.act` (add to pipeline, interest, move back, Assistant chat, referee calls; includes the collision lock: another TA's `ownerTaId` -> "Another recruiter has claimed this candidate."), `link.note` (lead notes: desk-wide only, "Only a TA Lead, Director, Admin or Ops can leave notes."), `opening.read`.
- `DESK_WIDE` = admin, director, ta_lead, ops (never narrowed). `isTa` = `ta` or `ta_support`. `ta_support` (9 Oct, 39618c9): same as TA but `seesEveryTaRow` lets it READ every TA's rows on a job (`scopeLinks`, export, table) - acting on another's row is still refused by `opening.sourcing` with `ownerTaId`; the UI sets `readOnly` on those rows.
- `scopeLinks(rows, user, addedByDeskWide)`: a scoped TA sees own rows plus rows added by desk-wide users; others see all. `rowIsAnotherTas` is the same test for one row. `scopeSuggestions` as in Flow 13.
- `opening.sourcing` for non-desk-wide requires an assignment or being on a strategy; client seats are denied ("Sourcing is the desk's working-out").
- Workday: the gate lives in /workday. `setWorkingStage` ("100%", "Follow-up", "Add-on") changes which checks apply and sets `isAddOn` on new rows.
- Extension: only active `ta`/`ta_support` ids may be named, plus `can opening.sourcing`.
- Referee Calls: only `isTa` edits, only own rows, only today (Colombo).

## Workday checks fed by this feature (for /workday)
Built in `convex/lib/workdayChecks.ts:requiredChecks` -> `setupChecks` (src/lib/workdayRequirements.ts), only for work type "100%": `suggestions:<job>` (done when a run exists AND no `new` rows in the latest round AND (count>0 or an empty-reason saved for that round version)); `excel_profiles:<job>` (distinct own rows by `linkKey`, `>= MIN_OWN_EXCEL_PROFILES` = 1; index `by_workday_added`); `jd_review`, `linkedin_post` (Research is optional since 15 Oct: `research:` events are skipped, fields only matter for `ResearchConfirmation`/EOD link). All four plus `chatgpt`, `director_cv`, `mail`, `midday_email` are `isEodSendCheck` (block the EOD send) and `canExcuseCheck` for jd/post/suggestions/excel/chatgpt only. Evidence is versioned (`suggestionVersion` etc.) so editing invalidates reviews.

## Invariants and safety

- Nothing in this feature sends to candidates: Excel Tables, Suggestions and the extension never message anyone. If you add outreach from a row it MUST go through `convex/lib/outreachSafety.ts` and `convex/lib/outboundGuard.ts`; never set `OUTREACH_LIVE` in code (AGENTS.md rule 4). "Not interested" writes the application straight to Rejected without starting follow-up for exactly this reason (29 Sep).
- Extension reads one page, when a person presses a button; no crawling, queues, timers or navigation (stated in content.js, extension.ts, README; Proxycurl precedent). Do not weaken.
- No invented people: Suggestions keep only links a search returned; Benchmark rows without a source are dropped; Research addresses come from searches; unverifiable fields stay empty.
- One row per person per TA; whoever shortlists first works the person (22 Oct, 2644328): the backend shortlist claim is the lock, not the table. Never refuse a second TA's paste again, and never show TA B's row the TA A application (`rowApplication`).
- Interest is derived from the pipeline, never stored; changing it changes the pipeline in the same action and rolls the row back when the pipeline refuses (29 Sep).
- Hard delete only for a row (`deleteLink`); an L delete is soft with a 10-minute Undo (22 Oct).
- Existing candidate records are only filled where blank (1 Oct 59d0d0a: one person's details must never land on another's record).
- Research once per opening, Suggestions 3 rounds, desk-wide may re-run; concurrent runs refused by `alone()`; counting rounds must use every run (21 Sep).
- Colombo-day rules: `colomboDay`, `workdayDate`; Referee Calls and the Added filter are Asia/Colombo days; Pakistan TAs have a second clock label (`workTimeZone`).
- Never put a secret in the extension or docs; the token is per deployment.

## Known quirks, gaps and unverified items
- Overview (`hh/page.tsx`) counts `repo.linkVault(id)` unscoped (no `scopeLinks`), so a TA sees opening-wide totals while the table is scoped (unverified whether intended).
- `matchLink` is skipped on bulk paste and on `chooseCv` from suggestions without a row; relies on `matchUnchecked` (10 rows per page view). A row checked once with no match is not re-checked.
- `runSuggestions` Assistant "SEARCH" answers do not themselves spend a round; the user must press Refine.
- `ta/eyeMarked:checkEmail` has no caller (unverified wiring); the EOD page shows `EyeMarkedChecks` for 100% jobs only.
- The sidebar "+" is hidden on jobs with work locations; use "+ Add L-sheet" in the table.
- The mobile API shows Excel Tables for an opening (16ba78c) but its code was not read here (unverified).
- Referee Calls `lookingFor`, `refereeId`, `candidateId` are stored but unused in the UI.
- Capture of an existing row on a different work location returns 409 `different_location` - TAs must assign the existing row first.
- `docs/REFEREE-CALLS-PLAN.md`, `docs/REFEREE-CALLS-GRID-PLAN.md`, `docs/WORKDAY-CHECKS.md`, `docs/work-locations.md` are planning docs; the code wins where they differ.

## How to change it safely

Where to edit:
- A new row field: `convex/schema.ts` (`linkVault`, keep optional), `src/data/types.ts` (`LinkVaultEntry`), `identity("linkVault", [optional fields...])` in `convex/ta/model/tables.ts` (list it as optional so old docs map), the `repo` mutator in `src/data/store.ts`, seed (`src/data/seed.ts`), export (`src/lib/linkExport.ts`, `src/lib/xlsx.ts` headers) and `docs` if user-visible. Data backfills are `internalMutation` migrations with `dryRun` run by the pipeline (`run_function`), never ad hoc.
- A new row button: server action in `src/app/actions.ts` (+ `*Inline`), `authorize(formData, "opening.sourcing", {link:"entryId", opening:"openingId"})`, `revalidateLinks`, then `LinkRow.tsx`. Use `can()` capability changes only in `src/lib/auth.ts` and keep `READS`/ `Capability` in sync.
- Filter/tab: `src/lib/linkViews.ts` (`INTEREST_TABS`, `readLinkFilters`, `inSheet`), `LinkVaultTable.tsx` `pass()`, `LinkExportMenu` `buildQs`, and the export route `pass` - all three must agree or export differs from the screen.
- Scoping: `scopeLinks`/`rowCountsFor`/`rowApplication` only; the table, export, EOD attachment (`getScopedLinkVaultEntries`) and iMark list (`eyeMarkedRows`) all use them.
- Research/Suggestions prompts and parsing: `src/lib/headhunt.ts`, `researchSearch.ts`, `incumbents.ts`, `sourcing.ts`, `claudeSourcing.ts`; providers `serper.ts`, `claudeSub.ts`. Keep the "source or drop" rule.
- Extension: `extension/*` + `src/lib/extension.ts` + both routes; bump `manifest.json` version when the contract changes (the openings route answers 426 to copies that omit `userId`), tell TAs to replace the folder by hand.
- Workday evidence: /workday; `MIN_OWN_EXCEL_PROFILES`, `SUGGESTIONS_WORKDAY_REQUIRED`.

Tests (`npm test` runs `node tests/run.mjs`; run one file with `node tests/run.mjs <name-substring>`): `linkpaste`, `linkinterest`, `linkSheets`, `linkExport`, `excelFilename`, `xlsx`, `sharedLinks`, `tasupport`, `sameperson`, `linkdbmatch`, `eyemarked`, `excelTablesReport`, `refereecalls`, `refereegrid`, `refereecheck`, `refereewindow`, `referees`, `research`, `researchlink`, `incumbents`, `sourcing`, `claudesourcing`, `claudesub`, `workdayRequirements`, `workday`. Extend the closest one; most use a disposable seed store, so mirror the actions' store calls.

Commands before pushing: `npm test`, `npx tsc --noEmit -p .`, `npx tsc --noEmit -p convex`.

Pre-merge checklist:
1. Table, export and EOD attachment agree on the same scoped rows and filters.
2. Second-TA, TA Support and desk-wide paths checked (read-only row, lock message, `rowApplication`).
3. Every refusal message is plain and specific; the action rolls back partial writes (interest, pipeline).
4. Colombo day boundaries and per-location L-sheets (`link_levels` key with location) still behave.
5. No new outbound send; if any, via outreachSafety/outboundGuard.
6. Anything changing what users see or what reaches candidates is flagged for the owner; any live change goes only through the release pipeline (never `convex deploy/run/import/env set` from a laptop, never point a local run at a live address). Use /merge-teammate for teammate branches.

## History
- 2026-09-16 (c68053e, 81a74cb): faster, curated Suggestions; step-by-step progress while research/suggestions run.
- 2026-09-21 (dfee7fb, 5091345, b94642e, 1b6c3ba, 6be4a76): Shortlisted-on-add, links accepted without https, every row button answers under the row, Research/Benchmark/Suggestions run and say what happened, Reference limited to Follow-up people with LinkedIn verify; fix "works once" round counting.
- 2026-09-22 (83854e7, b55ac5e, 398be7e): incumbent search/Benchmark; direct remove link with instant cache invalidation.
- 2026-09-23 (ea42063, 83ce18e, 2666afa, f5fc182, 17cf8b9): searches through our own SearXNG, queued because Google refuses bursts; Research limited to one run per opening for the desk; extension added to Excel Tables (48e0ff3).
- 2026-09-24 (5a91843, f463544, 42a1a72, ad80eec, 42779a9): research/suggestions on the owner's Claude subscription, Claude WebSearch first with SearXNG behind it, Claude headhunts from the JD, per-engine SearXNG requests merged.
- 2026-09-25 (07f45ec): leads leave notes for the TA on a row.
- 2026-09-28 (c53414b, ae6d9b9, 8ce23da, b8ee975, cb58fcf): LinkedIn profile matched to the CV already held (convex/lib/samePerson); "Wrong company? Correct it" on Research; add-on tag; Upload headhunted CV; move back to Excel Tables.
- 2026-09-29 (4508364, f82d07d, 0a3ea7a, 3e0d95f, 6b0dd4c; PR #83): Pending/Interested/Not interested tabs, L1, L2... via sidebar +, rename/delete, sheet tabs, Not interested asks why; status moves the pipeline.
- 2026-10-01 (b70fd65, ebadde5, 4e9bf8e, e7130fc, 59d0d0a, fc5f763): Find CV, Added-by filter and no duplicate Recruiter captures, matched row is one person, job years and university in matching, two TAs work apart.
- 2026-10-02 (e5d6225): extension may only name active recruiters; backend closed.
- 2026-10-05 (b229fe9, 4c1b9e6, 825caa1, bf41be3): old extension told to update (426); Recruiter list page refused; a TA's table shows only own rows; newest first.
- 2026-10-08 (6f4272f): company reading in the extension and Company Reference in Excel Tables (Gajani, #149).
- 2026-10-09 (39618c9): TA Support seat reads every TA's rows.
- 2026-10-12/14 (d9ce8c2, 32b0e33, bcd4a7e): export to xlsx; iMark filter in Excel Tables; iMark separated from bulk selection.
- 2026-10-13 (38fd1b5): eye-marked profiles tracked and gate the end-of-day email.
- 2026-10-14/15 (e905001, 26a0374, da3529d): own Excel profile count temporarily 1; empty-Suggestions reason gated on workday evidence; Suggestions review required again, research fields optional; auto-start L1 when a row is added (15 Oct unlevelledLinks1510).
- 2026-10-28: Claude subscription found disabled on live (org setting) and replaced with a new token; Suggestions accuracy bar (5 must-haves, per-person check search, drop far-off level/other function/unknown, max 8), learning from TA Follow-up CVs + Select/Not selected, automatic learning runs at 2/5/8 picked CVs (round 0, `profileSuggestions.learnedFrom`), real search count.
- 2026-10-20/21 (bdd78a1, 4dd30a8, 904e51f, 23fc0f3): hyperlinked Excel attached to EOD; separate location L-sheets; per-TA level sheets and status sections in export; files named client - position - location.
- 2026-10-22 (2644328, c842bec, ec0f1f3): two TAs may hold the same person, first to shortlist works them; sheets per person, lowest free L, date filter, work cards; read-only Excel Tables report.
- 2026-10-23 (c28e1b1, 803cf4e, 607dd00): referee calls table and EOD section; "Not interested" is Not successful; sheet works like Excel (type, paste, save once).
- 2026-10-26 (ef61c9c, PR #291): paste many rows from a TA's sheet into an L (cap 100).

<!-- skill-meta
verified-commit: 1def08d4
verified-hash: fbceac47c7b5291273673932bbdd469f8657117b
verified-date: 2026-10-28
sources:
  src/app/openings/[id]/hh/**
  src/app/openings/[id]/sourcingGate.ts
  src/app/openings/[id]/reference/page.tsx
  src/app/actions.ts
  src/components/LinkVaultTable.tsx
  src/components/LinkRow.tsx
  src/components/AddLinkForm.tsx
  src/components/LinkExportMenu.tsx
  src/components/LinkLevelItem.tsx
  src/components/ProjectSidebar.tsx
  src/components/RefereeCallsGrid.tsx
  src/components/hh/**
  src/lib/linkViews.ts
  src/lib/linkPaste.ts
  src/lib/linkExport.ts
  src/lib/sharedLinks.ts
  src/lib/cvMatch.ts
  src/lib/extension.ts
  src/lib/refereeCalls.ts
  src/lib/headhunt.ts
  src/lib/sourcing.ts
  src/lib/researchSearch.ts
  src/lib/serper.ts
  src/lib/claudeSourcing.ts
  src/lib/claudeSub.ts
  src/lib/visibility.ts
  src/lib/workdayRequirements.ts
  src/app/api/extension/**
  src/app/api/openings/[id]/links/export/route.ts
  extension/**
  convex/ta/tables.ts
  convex/ta/model/tables.ts
  convex/ta/workLocations.ts
  convex/ta/eyeMarked.ts
  convex/lib/samePerson.ts
  convex/lib/workdayChecks.ts
  tests/link*.test.ts
  tests/refere*.test.ts
-->
