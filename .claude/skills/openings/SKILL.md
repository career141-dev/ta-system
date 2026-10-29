---
name: openings
description: Openings (positions, jobs, roles, requisitions, "jobs", "positions") as a managed object in the Career141 TA System - list buckets, creation, opening shell/rail, Overview and health, status (open/on hold/placed/closed), P1-P5 priority and day-N-of-target, team seats, TA access requests, LinkedIn job posts, JD + JD chat, job details, snippets, work locations, briefs, clients, Bin, role dashboards, Master Sheet, alerts. Use when changing, debugging or extending any of these.
---

# Openings

## Scope and boundaries

In this skill: the opening as an object (one `jobs` row = one Opening) and everything hung directly off it: `/openings`, `/openings/new`, the shell (`src/app/openings/[id]/layout.tsx`, `ContextBar`, `ProjectSidebar`), Overview, status/priority/team/seats, access requests, job posts (LinkedIn Job tab), JD tab + JD chat + Job details, Snippets, work locations, briefs, clients (`/clients`), the Bin, role dashboards and the Master Sheet/alerts only as they read openings.

Neighbours (do not duplicate; follow the link):
- Pipeline stage semantics, sets, shortlist, Director/client review: /sets-shortlist
- Follow-up sequences, auto follow-up switch (`ta/followUp:setAuto`), outreach: /follow-up
- Scoops (CVs mailed/uploaded to a TA): /scoop
- Strategy Planner (`/openings/[id]/strategies`): /strategy-planner
- Voice agent / screening calls: /voice-agent
- Mailbox intake, `routeShared` post routing internals: /email-intake
- CV reading, Prepared CV: /cv-extraction
- TA workday, mandatory job checks, `ta/workdays:checkScope`: /workday
- Midday/EOD emails: /eod-email
- Whole-database search, Database CVs tab: /database-search
- Excel Tables / L-sheets / `hh/*`: /excel-tables
- This skill: /openings

Naming trap: web vocabulary is "opening" (`Opening` in `src/data/types.ts`), Convex table is `jobs`, the old pipeline calls it "job"; `src/data/convex/map.ts` + `convex/ta/model/tables.ts` + `convex/ta/model/projections.ts` translate. "Position" in the UI = opening; "post" = an advert row in `jobPosts`.

## Adding a candidate to another job

Candidate rows can add a candidate to another active or draft job assigned to the actor. The original application stays in place; the destination is checked again by `ta/applications:addToAssignedJob`.

## How it works now

### 0. Data path (read this before touching any write)
- Reads: `primeStore` (`src/data/prime.ts`) loads users, clients and openings via `backend.openings` -> `ta/openings:list` with `limit: 500`, maps with `mapOpening` (`src/data/convex/map.ts`), then pages in applications. The in-memory `repo` (`src/data/store.ts`) is synchronous. Opening pages call `primeStore({openingId})`; list/dashboards call `primeStore({allApplications:true})`.
- Writes of two kinds: (a) dedicated Convex mutations (`ta/openings:create`, `approveJd`, `saveJd`, `updateMasterSheet`, `setWorkingStage`, `ta/requirements:*`, `ta/bin:*`, `ta/openingAccess:*`, `ta/clients:*`); (b) `repo.*` store methods (`setOpeningStatus`, `updateOpening`, `setAssignments`, `addJobPost`, `updatePost`, `deleteJobPost`, `transferApplications`). Kind (b) mutate in-memory tables, `src/data/unitOfWork.ts` diffs before/after into row ops, `src/data/convex/syncCall.ts` calls `convex/ta/commit.ts:apply` synchronously, and `convex/ta/model/tables.ts` (`TABLES`) maps each row to its stored shape. The commit conflict-checks changed fields ("Someone else changed this record") but applies no role check: the role check is `authorize()` in `src/app/actions.ts`.
- Therefore any new opening field needs: `convex/schema.ts` (jobs), `projectOpening` (`convex/ta/model/projections.ts`), `mapOpening` + `BackendOpening` (`map.ts`), `Opening` type (`types.ts`), and the `TABLES.openings.toDoc` entry if it is saved through `repo`. A field missing from `toDoc` is silently never saved by `repo.updateOpening`.

### 1. List `/openings` (`src/app/openings/page.tsx`)
- Actor: any signed-in desk role. Data: `repo.openingsForUser(user)` (`store.ts`) = "mine"; `all = isDeskWide(user) ? repo.openings() : mine`.
- `openingsForUser`: TA/TA Support: `assignedTaIds` contains me, or an assignment row, or a strategy assignment I am on; `ta_lead`: `taLeadId === me` or in `assignedTaIds` or on a strategy; client/viewer: only openings they have an assignment on; admin/director/ops: everything.
- Buckets (`src/lib/openingStatus.ts`: `OPENING_BUCKETS`, `statusMatchesBucket`), default `mine`: My openings (open, in mine), All active (open, in all), Unassigned (open and `assignedTaIds.length===0`), On hold, Placed (`filled`), Closed / Lost (`closed`). Counts shown on each tab are computed in the page.
- Filters via querystring: `bucket`, `q` (title/client/locations, `matchesQuery`), `location|country` (`toCountry` in `src/lib/openingCountry.ts`, shared with mobile), `industry`, `clientId`, `taId` (the TA filter is shown only when `isDeskWide(user)`), `page` (PAGE_SIZE 20, `src/lib/paging.ts`).
- Row: client, title, priority tier chip, `StatusMenu`, `WorkingStageMenu` (only when `allows(user,"opening.act",{assignment})`), nationalities, locations, post count, TA names or an "Unassigned" chip; right side Follow-up (ai+ta follow-up count), Director, CVs today (sum of live posts' `cvCountToday`), `days/target` (red when over); footer sets closed/open sets, "Assigned N days ago", "JD waiting for approval" (`jdStatus==="pending_ta_approval"`), "N urgent" (computed alerts). TAs with a strategy-only seat or a seat narrowed by `seatFor(...).ownDeskOf` see their own counts only.
- Bulk delete: `BulkBar` posts to `deleteOpenings` for rows where `allows(user,"opening.manage",...)`.
- Header buttons: `RequestOpeningAccess` (TAs only), `OpeningAccessApprovalQueue` (lead/admin; `?accessRequests=open` from the bell), "New opening" -> `/openings/new`.

### 2. Creation
- Page `src/app/openings/new/page.tsx` (`pageUser("opening.create")`; everyone except `client`). `CaptureForm` posts `createOpeningStep1Inline` (or `createOpeningInline` from the create-client pop-up `NewClientDialog`, which first calls `createClientInline`). Both end in `saveNewOpening` (`src/lib/openings/create.ts`, shared with `POST /api/mobile/v1/openings`).
- Fields: client (`clientId` required), title (required, else "Choose a client and a position."), country (default Sri Lanka in backend), `hiringFor` nationality (default `local`), optional `targetGender`, work locations JSON (`validateWorkLocations`, 1-50 rows), notes/recording, `assignedTaIds` (leads/admin only), `autoFollowUp` checkbox. There is NO priority field: `ta/openings:create` defaults `priorityTier` to P3 (`priorityTier` arg exists, web never sends it). Priority is changed later in Overview > Edit the details.
- Recording: `BriefRecorder` -> `POST /api/recording` (needs `can(opening.create)`, 40 MB max, `maxDuration` 300 s, stores to Convex storage as `convex:<storageId>`, transcribes via `transcribeAudio`, transcript returned to the form, never auto-saved). Saving a recording without the exact `CONSENT_TEXT` (`src/lib/intake.ts`) throws "Confirm everyone agreed before saving the recording."
- Assignment rules in `saveNewOpening`: `isLead = role in {ta_lead, admin}`. Lead: `assigned = form ids` filtered to `assignableTas(users)` (active TAs, `src/lib/assignable.ts`); non-lead: `[user.id]`. Zero TAs is allowed (Unassigned bucket; backend makes `primaryRecruiterId = user`). `taLeadId = isLead ? user.id : first user with role ta_lead (fallback creator)`; `directorId` = first director user. `taLeadId` is written once at creation; there is no UI/writer to change it later (`ta/openingAccess` depends on it, see 4).
- Backend `ta/openings:create`: unique `keyword` (`makeKeyword`, up to 10 retries on `by_keyword`); inserts `jobs` with `status:"active"`, `positionStatus:"active"`, `jdStatus:"pending_ta_approval"`, `jobDescription:""`, `directorReviewEnabled/clientReviewEnabled:true`, `esaCheckEnabled:false`, `headhuntingEnabled:false`, `headcount` = sum of active location vacancies else 1, `assignedTaIds`, `primaryRecruiterId = assignedTaIds[0] ?? creator`; one `jobAssignments` row per TA (first primary_recruiter, rest supporting_recruiter, `workingStage` absent = 100%); a first `jobPosts` row (`firstPostFor`, `convex/lib/firstPost.ts`: alias = keyword, `status:"live"` because the job is active, no link); if notes or recording: a `briefs` row (`kind` = management_to_lead for leads, lead_to_ta for TAs; `method` notes|recording|both; `transcriptStatus` none|unavailable) and `jobs.briefId`. `assignedAt` and `requirementReceivedAt` are NOT written (mapOpening falls back to `createdAt`). `autoFollowUp` applies `autoFollowUpPatch(true)` (`convex/lib/followUpScope.ts`).
- After insert: `resetStore()`, revalidate `/openings`, `/alerts`, `/api/notifications`; for every assigned TA other than the creator: `ta/notifications:create` type `opening_assigned` ("You were assigned to an opening", body "<name> assigned you to <title>."), failure only logged; `deps.after` -> `draftJd(openingId)` (`src/lib/openings/jdDraft.ts`). Research and first Suggestions do NOT run at creation any more (since 25 Sep they start from `approveJd`).
- Redirect by button `next`: `save` -> `/openings/<id>`, `jd` -> `/openings/<id>/jd` (TA), `again` -> `/openings/new?created=<id>` (lead).
- Clients inline: `saveNewClient` -> `ta/clients:add` (dedupes on `nameKey`; adding a name that is in the Bin un-bins it instead of creating a second row); industry blank -> "Other"; one primary contact if a contact name is given.

### 3. Opening shell (`src/app/openings/[id]/layout.tsx`)
- Every page under an opening passes here. `repo.opening(id)` missing -> 404. `allows(user,"opening.read",{openingId,assignment,onStrategy})` false -> if TA and `ta/openingAccess:listAvailable` contains the opening: `OpeningAccessNeeded` (request form) else `ProblemState` "Opening unavailable" (protected openings are never disclosed).
- `seat = seatFor(user, assignment?.role, onStrategy)` (`src/lib/visibility.ts`) decides the rail: `canSeeSourcing` (hides Headhunting, Database CVs, Snippets, Strategies, Scoops, Midday/EOD for client seats), `canAct` -> `canUseDailyEmail` (Midday/End of day only for recruiters, not strategy-only people; also gates the `ta/dailyEmails:list` query). Pages guard themselves with `requireSourcingSeat(id)` (`sourcingGate.ts`, redirect `/unavailable`); hiding a link is not the check.
- `ContextBar`: title + client, `StatusMenu` (everyone sees it, action refuses), `WorkingStageMenu` (only if `opening.act`), TA initials, `OpeningMenu` (Delete -> Bin; only if `opening.manage`). Sticky at `CONTEXT_H` (`src/lib/chrome.ts`).
- `ProjectSidebar` (client component, 238 px rail from `lg`, folded menu on phone): ATS | Headhunting switch; ATS: Overview, Pipeline (stage list `PIPELINE_STAGES` + `CLOSED_STAGES`), Scoops, LinkedIn Job (+ add post inline form posting `addJobPost`, per-post dot live/paused/other and delete icon -> `deleteJobPost` with confirm), Job description, Database CVs, Snippets, Strategies, Midday email (+ add via `addMiddayEmail`, hidden when `locationSheets`), End of day; Headhunting: Overview, Research, Suggestions, Excel Tables (+ L list), Referee Calls. Posts shown are `visiblePosts` (a TA sees only posts assigned to them; leads/directors/ops/admin all). `locationSheets` (= `opening.workLocations?.length`) turns off the "+ L" and midday "+" and scopes links with `?location=` / `?workLocation=`. Client contact: only "Job description" plus the pipeline from shortlist on.

### 4. Overview (`src/app/openings/[id]/page.tsx`)
- Counts: if `deskSeat.ownDeskOf` (a TA) counts come from `visibleToSeat(applications)`, else `stageCounts(id)`. "In pipeline" = sum over `PIPELINE_STAGES`. "CVs today" = sum of live posts' `cvCountToday` (derived, not stored: applicants filed to the post since Colombo midnight, `repo.jobPosts`). "Days in" = `colomboDaysBetween(assignedAt)` over `PRIORITY_TARGET[tier].days`.
- `HealthBar` (`src/lib/health.ts` `healthFor`, computed per render by `repo.health`): four parts: flow = livePosts==0 ? 40 : clamp(cvsToday/10*100); screening = waiting==0?100:clamp(100-waiting*4) where waiting = new_cv+matched; progress = no apps ? 50 : clamp(downstream/(up+down)*140) (upstream new_cv,matched,ai_follow_up,ta_follow_up; downstream director_review...placed); time = clamp(100 - days/target*100). Score = flow*0.20 + screening*0.25 + progress*0.35 + time*0.20; bands good >=65, slipping >=40, else stuck. Headline names the worst part. Health uses ALL applications (`repo.applications(id)`), not the seat-narrowed ones.
- Suggested actions (cards, only those that apply): review unscreened (new_cv+matched) -> `/database`; open set (your own set) -> `/eod`; ready for Director -> `/eod`; follow-up count (links to ta_follow_up if any else ai_follow_up).
- `JdApproval` card when `jdStatus==="pending_ta_approval"`; `canApprove = assigned TA or admin`. `OpeningBrief` (all briefs with notes), `JobDetailsSummary`, `MatchingStatus`, pipeline list, last 5 owned-application moves, "About this opening" (team, lead, sets, `positionCode`, needs-attention count from `computeAlerts()` filtered to this opening), `OpeningAdmin`.
- `OpeningAdmin` (`[id]/OpeningAdmin.tsx`): rendered when `canEdit = assignedTaIds.includes(me) || !isTa(user)` (so a client/viewer sees buttons that the action refuses). Panes: Edit the details -> `updateOpening` -> `writeOpeningDetails` (`src/lib/openings/admin.ts`): title required, salary from<=to (commas/currency stripped, a minus sign is kept so negatives become null), tier in P1..P5 ("Pick a priority from the list."), currency `^[A-Z]{3}$`; with work locations headcount = sum of active vacancies else `max(1, headcount)`; goes through `repo.updateOpening` (commit). Change the team -> `setOpeningTeam` -> `writeOpeningTeam` (see 5).

### 5. Status model
| UI label | `Opening.status` | `positionStatus` | `jobs.status` | closedAt |
|---|---|---|---|---|
| Active | `open` | `active` | `active` (or `draft`, preserved) | null |
| On hold | `on_hold` | `hold` | `on_hold` | null |
| Placed | `filled` | `filled` | `filled` | now |
| Closed / Lost | `closed` | `lost` | `cancelled` | now |
- Mapping: `OPENING_STATUS` in `map.ts` (`active`,`draft`->open; `cancelled`->closed) and `TABLES.openings.toDoc` (`backendStatus`; an open job that was `draft` stays `draft`). There is no cold/disabled/dormant status; `draft` is a backend leftover that reads as open.
- Writers (all end in the same fields): (1) `StatusMenu` -> `setOpeningStatus` -> `authorize("opening.manage")` -> `writeOpeningStatus` (`src/lib/openings/writes.ts`) -> `repo.setOpeningStatus` (`store.ts`; derives positionStatus, `closedAt = now` for closed/filled else null). No reason is asked; not subject to the workday gate. Mobile: `POST /api/mobile/v1/openings/[id]/status`. (2) Master Sheet cell `updateMasterSheetOpening` -> `ta/openings:updateMasterSheet` (desk-wide only, mandatory reason 3-500 chars, `masterSheetStatusFields` in `src/lib/masterSheet.ts`: active/hold clear `closedAt`; lost/filled take typed date, else existing, else today; writes `activityLog` action `master_sheet_updated` with before/after). (3) Bin/restore (`ta/bin`). (4) Job details form `ta/requirements:save` has a "Job Status" select (active/draft/on_hold) that writes `jobs.status` directly without touching `positionStatus`/`closedAt` (see quirks).
- Placing a candidate (`recordPlacement`, `writeCandidateClosing`) never changes the opening to Placed; headcount reached has no automation. A person sets it.
- Automation effects (verified): only `jobs.status === "active"` gets the follow-up sweep and SLA-breach crons (`convex/crons.ts` lines near 64, 175, 739, 763), WhatsApp reply matching (`convex/communications/whatchimp.ts:199`), shortlist mail filing (`convex/mailIntake/shortlist.ts`), access requests (`openingAccess.requestable`), and web alerts (`computeAlertsAt` filters `status==="open"`). `on_hold` additionally: `convex/pipeline/ingestion.ts:40` accepts a CV only when it arrived via a post (link-only routing, `RoutablePost.linkOnly` in `convex/lib/postRouting.ts`), the mail-intake AI reader (`aiReader.ts`, `interviews.ts`) still includes it, and workday "add position" still offers it (`convex/ta/workdays.ts` excludes only closed/filled/cancelled). Binned or deleting rows are removed from everything (`isGone`).

### 6. Priority and "day N of target"
- `PRIORITY_TARGET` (`src/data/types.ts`): P1 14, P2 21, P3 30, P4 45, P5 60 days. Unknown tier -> P3 in `mapOpening`.
- `days = colomboDaysBetween(assignedAt)` (`src/lib/calendar.ts`, calendar days in Asia/Colombo, 2 Oct fix `5f507c6`). `assignedAt` falls back to `createdAt` in `mapOpening`. Master Sheet can overwrite `assignedAt`.
- Consumers: list row, Overview, HealthBar time part, alert `stale_role` (to TA Lead), dashboards "stale", reports `daysOpen/targetDays/daysOverTarget` and preset `over-target`.

### 7. Team and seats
- Seats (`AssignmentRole`): `primary_recruiter`, `supporting_recruiter`, `director`, `client_contact` (labels `ASSIGNMENT_LABEL`). Stored in `jobAssignments` (soft-revoked: `isActive:false`, `revokedAt`) mirrored in `jobs.assignedTaIds` (recruiters only) and `jobs.directorId`. Older openings with no rows derive roles on read (`repo.assignments` in `store.ts`: first TA primary, rest supporting, director).
- `writeOpeningTeam` (`src/lib/openings/admin.ts`): last row per person wins; refuses a team with no recruiter ("A team needs at least one recruiter on it. Nothing was changed."); calls `repo.setAssignments` (replaces ALL rows, recomputes `assignedTaIds`, `directorId = director?.userId ?? previous`, so a director can be changed but not cleared); newly seated recruiters (not the actor, not previously on the team) get `opening_assigned` notifications ("<actor> added you to <title> as <seat label>."). Quirk: rows are re-created without `workingStage`, so saving the team resets everyone to 100%; `primaryRecruiterId` is not updated either (only set at create).
- Working stage (`100%` | `Follow-up` | `Add-on`; `WorkingStageMenu` -> `setWorkingStage` -> `writeWorkingStage` -> `ta/openings:setWorkingStage`): own stage only. On the team: `jobAssignments.workingStage` (refuses `client_contact`); not on the team (lead/director/admin working it): `taSettings` key from `workingStageKey(jobId,userId)` (`src/lib/workingStage.ts`); client/viewer refused. Then `recordActiveMode` + `refreshWorkdayChecks` (`ta/workdays.ts`): see /workday (can throw once an EOD is sent).
- TA access requests (`convex/ta/openingAccess.ts`, UI `src/components/OpeningAccessRequests.tsx`, actions `requestOpeningAccess`/`decideOpeningAccess` -> `requestAccess`/`decideAccess` in `src/lib/openings/admin.ts`): requester must be role `ta` or `ta_support` ("Only a TA can request access to an opening."). `requestable(job)` = not binned/deleting, `status==="active"`, not `isConfidential`; the job's `taLeadId` must be an active user whose role resolves to `ta_lead` (roleOf: explicit `taRole`, else ta_manager/senior_ta -> ta_lead) else "This opening does not have an active TA Lead. Ask an administrator to assign one." Reason max 1000 chars. Duplicate pending returns `alreadyPending`. Creates `openingAccessRequests` (`pending`), a `notifications` row `opening_access_requested` to the lead (bell link `/openings?accessRequests=open`) and an `activityLog` row. Decide: only that job's lead or admin; reject needs a reason; approve in ONE transaction creates/reactivates a `supporting_recruiter` assignment with `workingStage:"100%"`, appends to `assignedTaIds`, sets `assignedAt: job.assignedAt ?? now` (this makes the day counter start at approval for openings that never had `assignedAt`), writes `opening_access_approved|rejected` notification and activityLog. Pending list for lead: `by_lead_status` index; admin sees all pending.

### 8. Job posts and LinkedIn Job tab (`src/app/openings/[id]/linkedin-job/page.tsx`, `PostManager.tsx`)
- A post (`jobPosts`): `title`, `previousTitles` (renaming keeps the old title routable), `aliasKeywords`, `country`, `city`, `channel` (linkedin|facebook|email_campaign in the UI), `campaignCode`, `routingEmailAlias`, `assignedTaId`, `externalUrl`, `postedAt`, `status` draft|live|paused|closed, `cvCountToday` (derived on read, never written).
- `addJobPost` (`authorize("opening.manage")`): needs a title; link, if given, must satisfy `linkedinPostUrl` ("Paste a valid LinkedIn job, Recruiter project, or job post link."); `repo.addJobPost`: owner = creator if on the team, else the sole recruiter, else creator/first TA; refuses an identical post (same title/channel/owner/country) "There is already a post called ..."; status `live` only when `liveOnLinkedIn=1` and the JD is approved, else `draft`; `campaignCode` from `makeCampaignCode` (`src/lib/routing.ts`); `routingEmailAlias` `jobs+<clientslug>-<n>@career141.com`. A saved link queues `communications/emailAgent:queueRescanForLink` (re-reads linkedin@ for the last 30 days; failure to queue does not undo the save).
- `updatePost`: aliases (comma list), country, city, assigned TA, title (<=160), link (same validation; a changed link requeues the rescan). `setPostStatus`: `repo.updatePost`; going `live` requires `jdStatus==="approved"` else "This job cannot go live until its JD is approved. Approve the JD first, then set the advert live." (`JD_NOT_APPROVED` in `store.ts`); the action passes `postedAt: now` when live and `undefined` otherwise. `transferCvs` moves a paused post's applications to a live one (`repo.transferApplications`). `deleteJobPost` nulls `jobPostId` on its applications (nobody is deleted). `testPostRoute` runs `routeShared` over live/draft posts of open openings and says where a subject would be filed (changes nothing).
- "On LinkedIn" pill (`src/lib/linkedinStatus.ts`, `LinkedInPill`; PR #99, 30 Sep): `connected` when a live/draft `linkedin` post has a job or Recruiter project number in `externalUrl` (`linkedinJobId`/`linkedinProjectId` from `convex/lib/postRouting.ts`); `no_link` when only link-less active posts exist (every opening starts like this); `no_post` otherwise. Shown on the TA dashboard row and Lead dashboard (counts "N of M on", per-job pill, `?li=off` filter).

### 9. Job description, JD chat, Job details
- Page `jd/page.tsx`: not approved -> `JdScreen` (write permission `assignedTaIds.includes(me) || opening.manage`; others see `OpeningBrief` and "Only an assigned TA can write this JD."); approved -> `JdRead` + chat + `OpeningBrief`. Client seats get only this page.
- Draft: `draftJd` (`src/lib/openings/jdDraft.ts`): joins all briefs (`jdBriefsFor`: lead brief + each TA's notes + ready transcript), builds the house template (`buildJd`, `src/lib/intake.ts`) and asks `generateJdText` (`src/lib/headhunt.ts`; `write()` in `src/lib/ai.ts`, task `jd`, max 2500 tokens, OpenRouter when configured). The model never invents facts; if it fails the template is saved and the screen says so (`generateJdWithModel` message "The AI could not write it - ..."). Saved with `ta/openings:saveJd` (the backend is the only writer; a second `repo.updateJd` caused "Someone else changed this record", 22 Sep). Triggers: creation (`deps.after`), "Generate" button (`generateJdWithModel`/`generateJdInline`, which first saves typed notes via `saveOwnNotes` as the TA's own `lead_to_ta` brief).
- JD chat (25 Sep, `82b7876`): `reviseJd` (`opening.manage`): request 1..`JD_REQUEST_MAX` (2000) chars; adds user turn to `jdChat`; `reviseJdText` rewrites the whole JD and returns "CHANGES:" line (`splitChanges`); assistant turn stores `jdMarkdown` (version); failure stores a `failed` turn and the JD stays as it was; `saveChatJd` -> `saveJd` (with `detailsFromJd:true` if already approved). `restoreJdVersion` re-saves an earlier turn's JD. `chatHistory` passes last 6 turns. `detailsFollowNotes(chat)` is true until the first user turn: until then Job details are re-read from the notes at each draft; after, they wait for approval.
- Approval: `approveJd` action (`opening.manage`) -> `ta/openings:approveJd` (backend `assertJobAccess` primary/supporting/director; admin and ta_manager bypass; a listed `assignedTaIds` member or the job's `taLeadId` also passes): refuses empty text ("Add the job description before approving it."); text changed -> `invalidateJdReviews`; sets `jdStatus:"approved"`, `jdApprovedBy/At`; `recordJdReview` (workday JD-review check, /workday); `scheduleExtraction` mode `fill` (or `replace` with `keepLocks` if the chat was used); schedules `ta/jdApproval:scoreWaitingCvs` after `SCORE_AFTER_APPROVAL_MS` (60 s; max 400 CVs, staggered `SCORE_STAGGER_MS` 3 s, `convex/lib/jdGate.ts`). Web then runs `rematchWhenRequirementsSettle`, `researchOpening` (if none) and `sourceFor` (first Suggestions if none) in `after()`. While `jdStatus==="pending_ta_approval"` CV scoring waits (`scoringWaitsForJd`).
- `amendJd` edits an approved JD; it stays approved; `saveJd` re-extracts in `fill` mode when changed.
- Job details (`JobDetailsPanel`, `saveJobDetails` -> `ta/requirements:save`; `reextractJobDetails` -> `ta/requirements:reextract`): `save` writes and LOCKS each touched requirement field in `jobs.requirementsLockedFields`, sets `requirementsEditedBy/At`, clears `embedding`; validation: title required, location required, at least one required skill, years 0-50 integers, max>=min, salary 0..1e9 and max>=min, currency 3 letters, seniority in `SENIORITY_LEVELS`, status in active/draft/on_hold. Re-extract (button) = `replace` mode and clears locks. Extraction: `ta/requirementsActions:extract` ("use node") uses `extractSearchRequirements` (`convex/lib/jdParser.ts`); JD shorter than 40 chars or a `regex-fallback` result marks `requirementsStatus:"failed"` with a message; success writes `requirementsStatus:"extracting"->"extracted"`. Merge rules live in `convex/lib/jobRequirements.ts` (`mergeRequirements`, `REQUIREMENT_FIELDS`, `INDUSTRIES`, `mapIndustry`). After save/re-extract the web calls `markMatching` + `rematchWhenRequirementsSettle`.

### 10. Snippets (`snippets/page.tsx`, `SnippetStudio`, `SnippetStage`, `src/lib/snippet.ts`, `snippetDraw.ts`)
- Gate: `requireSourcingSeat`; if JD not approved, page shows "The JD has not been approved yet." with a link. Else `snippetFromOpening({title, client industry, locations, salary, packageNotes, jdMarkdown, TA email/phone})` builds the 1080x1080 card fields (level from `levelFromTitle`). `POST /api/snippet/refine` (signed-in active user only) polishes labels/bullets using `gemini` from `src/lib/ai.ts` with local typo fixes and `cleanSnippetBullet` fallback (<=4 bullets). Fonts loaded from Google Fonts on this page only.

### 11. Work locations (multi-city; `docs/work-locations.md`)
- `jobs.workLocations[] = {id, name, vacancies, archived?}`; validation `validateWorkLocations` (`src/lib/workLocations.ts`): 1-50 rows, unique ids `^[a-zA-Z0-9_-]{1,80}$`, name <=100, vacancies 1..10000, one active row per name, at least one active, an existing location cannot be removed (archive instead). `headcount` and `taLocations`/`location` are derived from active rows (create, `updateTaFields`, `toDoc`).
- Legacy jobs keep the whole-job workflow until someone uses "Set up location L-sheets and EOD emails" in Edit the details (`WorkLocationsEditor`); headcount is never split automatically. Candidate assignment: `assignWorkLocation`/`assignSelectedWorkLocations` (<=25 per call) -> `ta/workLocations:assign` (atomic; refuses if a daily email is sending/uncertain/unfinalized, if the candidate was already sent for review, or if another TA's row is involved for non-desk users; writes imported L-sheets via `taSettings` key `link_levels:<job>:<addedBy>:<location>`; `activityLog` `work_location_assigned`). `WorkLocationTabs` renders the picker (`?location=`/`?workLocation=`, "Location not assigned" tab). EOD/midday per location: /eod-email, /workday. `ta/workLocations:inventory` lists legacy multi-city jobs, no backfill exists.

### 12. Briefs
- `briefs` rows: lead's brief at creation, TA's own via `saveBriefNotes`/`saveOwnNotes` (one `lead_to_ta` brief per author; updating replaces that author's notes and `extracted`; empty notes with no brief writes nothing). `extractFromText` (`src/lib/intake.ts`) fills `extracted` (salary, locations, nationalities, must-haves, headcount, priority). `OpeningBrief` shows every brief with text on Overview and JD (since 1 Oct, `4949a8d`). `briefNotes` internal query joins them for `draftJd` when the loaded store has none.

### 13. Clients (`/clients`, `src/app/clients/page.tsx`)
- Read: `pageUser("database.read")` (everyone except `client`); search over name, industry, contacts, opening titles; industry filter; PAGE_SIZE 20; each `ClientCard` lists its openings with days/target. Edit controls need `client.manage` (admin, director, ta_lead): `AddClient`, `ClientEditor` -> `updateClient` (`ta/clients:update`: name -> `nameKey` recomputed, industry -> pushes `clientIndustry` to its jobs except where `requirementsLockedFields` contains `clientIndustry`, status active|dormant|archived, `esaSignedAt` date, `researchNotes` <=2000 chars), `saveContacts` (first contact becomes primary if none, only one primary kept), `deleteClient`/`deleteClients` -> `ta/bin:binClient`.
- `binClient` refuses while any live (not binned/deleting) opening is under the client: page shows `?held=<n>`. `nameKey` = lowercased name with non-alphanumerics collapsed (`clientKey` in `ta/clients.ts`, duplicated in `tables.ts`; keep both in step).

### 14. Bin (`/bin`, `convex/ta/bin.ts`, `src/lib/bin.ts`, `ta/openingDelete.ts`)
- Delete (menu, bulk, mobile `POST /api/mobile/v1/openings/bin` max 200) -> `binOpeningNamed`/`binOpenings` -> `ta/bin:binOpening`: stamps `binnedAt/binnedBy`, saves `statusBeforeBin`, sets `jobs.status="cancelled"` (so follow-ups, routing and WhatsApp matching stop). Authority: web `opening.manage`; backend `MAY_DELETE_OPENINGS` (`admin, ta_manager, director, ops` by raw backend role) or an active primary/supporting seat (or `assignedTaIds` on openings with no rows).
- Restore: `restoreFromBin` -> `ta/bin:restore` (any desk user except viewer/client): old status back; un-bins its client if that was binned. Delete now: `deleteFromBinNow` web check `isDeskWide`, backend `MAY_DELETE_OPENINGS` only; clients with openings still in the Bin are refused.
- Purge: cron `ta-empty-bin` daily 21:30 UTC (03:00 Colombo, `convex/crons.ts`) -> `ta/bin:emptyDue`: items with `binnedAt <= now - 7 days` (`BIN_DAYS=7`) -> `purgeOpening` sets `deletingAt` and schedules `ta/openingDelete:step` (batched, 400 rows per transaction, children listed in `OPENING_CHILDREN`/`APPLICATION_CHILDREN`; candidates are never deleted and are re-statused); a client is deleted only when none of its openings remain, else counted "waiting" until the next run.

### 15. Dashboards by role (`src/app/page.tsx`)
- TA/TA Support: own open roles (`openingsForUser` filtered `open`), "Today, in order" from `alertsFor(user.id)`, each role card shows `LinkedInPill`, `openingNeed` line (`src/lib/openingNeed.ts`: JD waiting, <10 CVs today, open set needs N, on track), days of target.
- `ta_lead`/`admin`: `LeadDashboard` (all open roles scoped to `taLeadId===me`, falling back to the whole desk when none; stale = days > target; unassigned; awaiting JD; per-TA load incl. LinkedIn counts). `director`: `DirectorDashboard` (open roles, waiting on Director review, value in progress = sum `valueOnProgressing` of open, placed = sum `valueOfPlacement`). `ops`: `OpsDashboard` (sitting with clients, alerts to chase, interviews). Client/viewer get the TA-style page restricted by `openingsForUser`.

### 16. Reports/Master Sheet (`/reports`, `src/lib/reportSpec.ts`, `reporting.ts`, `masterSheet.ts`)
- Preset `master` (dataset `ta_jobs`, one row per TA per opening; TAs see "My Master Sheet" scoped by `subjectTaId`). Commercial source cells (position status, `assignedAt`, `closedAt`, `valueOnProgressing/OfPlacement/Lost`) are editable only for desk-wide users with `can(commercial.manage)` (admin/director/ta_lead/ops), via `updateMasterSheetOpening` (reason 3-500 chars; Colombo-day dates via `colomboDayFromValue`; amounts >= 0). Everything else is calculated. Aggregating `SHARED_TA_JOB_FIELDS` is blocked to avoid inflating per-TA rows. Other presets that read openings: `by-client`, `by-ta`, `over-target`.

### 17. Alerts and notifications
- Alerts are computed, never stored (`computeAlerts` in `src/lib/sla.ts`, memo 30 s keyed by `repo.version()`), only for `status==="open"` openings: `low_volume` (<10 CVs yesterday on live posts, or open set stuck under 5 after 2 days), `advert_quiet` (live post, 5 working days without applications), `stale_role` (`days > target`, assigned to `taLeadId`, href the Overview), `shortlist_sla` (unscreened new_cv/matched for 24 working hours, one per opening), `opening_assigned` (per recruiter seat assigned within 7 days; urgent within 2 days; runs on non-working days, `alertKinds.ts`), plus review/interview/joining kinds owned by other skills. Labels in `src/lib/alertKinds.ts` (shared with mobile).
- Notifications (stored, `ta/notifications.ts`, bell `NotificationBell` polls `/api/notifications`; types include `opening_assigned`, `opening_access_requested|approved|rejected`): written on creation, team change and access decisions as above. Bell hrefs: access requested -> `/openings?accessRequests=open`; rejected -> `/openings`.

## UI surface
| Where | Control | Server action / route | Who |
|---|---|---|---|
| `/openings` | bucket tabs, filters, search, pager | none (querystring) | all desk roles |
| `/openings` row | `StatusMenu` | `setOpeningStatus` | menu drawn for all, refused unless `opening.manage` |
| `/openings` row | `WorkingStageMenu` | `setWorkingStage` | `opening.act` seats |
| `/openings` row/ContextBar | `OpeningMenu` Delete; bulk Delete | `deleteOpening`, `deleteOpenings` | `opening.manage` |
| `/openings` header | Request access | `requestOpeningAccess` | TA, TA Support |
| `/openings` header | Approve/Reject queue | `decideOpeningAccess` | ta_lead (own), admin |
| `/openings/new` | `CaptureForm`, `BriefRecorder`, `NewClientDialog` | `createOpeningStep1Inline`, `createOpeningInline`, `createClientInline`, `POST /api/recording` | `opening.create` (not client); +client needs `client.manage` |
| Overview | Edit the details / Change the team | `updateOpening`, `setOpeningTeam` | `canEdit`, backend-checked |
| Overview | JD approval card | `approveJd`, `generateJdWithModel` | assigned TA/admin in UI |
| LinkedIn Job | `PostManager`, rail "+" and trash | `addJobPost`, `updatePost`, `setPostStatus`, `transferCvs`, `deleteJobPost`, `testPostRoute` | `opening.manage` (test route: `opening.sourcing`) |
| Job description | `JdScreen`, `JdChat`, `JdRead`, `JobDetailsPanel` | `generateJdInline`, `saveBriefNotesInline`, `approveJd`, `amendJd`, `reviseJdInline`, `restoreJdVersionInline`, `saveJobDetailsInline`, `reextractJobDetailsInline` | `opening.manage` |
| Snippets | `SnippetStudio` | `POST /api/snippet/refine` | signed-in active user (page: sourcing seat) |
| `/clients` | `ClientCard`, `ClientEditor`, `AddClient` | `addClient`, `updateClient`, `saveContacts`, `deleteClient(s)` | read: not client; write: `client.manage` |
| `/bin` | Restore, Delete now | `restoreFromBin`, `deleteFromBinNow` | desk roles; early delete lead/director/admin (backend narrower) |
| `/reports` | Master Sheet edit | `updateMasterSheetOpening` | `commercial.manage` |
Mobile mirrors (shared code in `src/lib/openings/*`): `src/app/api/mobile/v1/openings/**` (list, new, `[id]` status, team, details, admin, working-stage, access-request, access-requests, bin), `clients`, `home`, `alerts`.

## Data
- `jobs` (indexes `by_keyword`, `by_status`, `by_clientId`, `by_binnedAt`): `title`, `clientId`, `clientName`/`clientIndustry` (denormalised), `jobDescription`, `jdStatus` draft|pending_ta_approval|approved, `jdApprovedBy/At`, `briefId`, `status`, `positionStatus`, `priorityTier`, `headcount`, `workLocations`, `taLocations`, `location`, `targetNationalities`, `targetGender`, `salaryMin/Max/Currency`, `packageNotes`, `assignedTaIds`, `primaryRecruiterId`, `taLeadId`, `directorId`, `assignedAt`, `requirementReceivedAt`, `closedAt`, `valueOnProgressing/OfPlacement/Lost`, `followUpQuestions`, `requirements*` + `requiredSkills`, `niceToHaveSkills`, `seniorityLevel`, `experience*`, `educationLevel`, `languagesRequired`, `isConfidential`, `recruitmentType`, `binnedAt/binnedBy/statusBeforeBin/deletingAt/deletingBy`, `keyword`, `embedding`.
- `jobAssignments` (`by_jobId`, `by_jobId_userId`, `by_userId_isActive`): `jobId, userId, assignmentRole, assignedBy, assignedAt (ISO string), revokedAt, isActive, workingStage`.
- `jobPosts` (`by_opening`), `briefs` (`by_opening`), `jdChat` (`by_opening`), `clients` (`by_nameKey`, `by_binnedAt`), `openingAccessRequests` (`by_job`, `by_lead_status`, `by_requester_job`, `by_requester_job_status`; status pending|approved|rejected), `notifications` (`by_user`, `by_user_and_read`), `taSettings` (`by_key`: working stage for non-members, L-sheet metadata), `activityLog` (`master_sheet_updated`, `opening_access_*`, `work_location_assigned`).
- App-side mirror types: `Opening`, `OpeningRequirements` in `src/data/types.ts`; table mapping in `convex/ta/model/tables.ts` (`openings` -> `jobs`, `assignments` -> `jobAssignments`, `jobPosts`, `clients`).

## Backend wiring
- Internal functions only (every `convex/ta/*` function is internal; the app calls them with the admin key via `src/lib/convexServer.ts`): `ta/openings:{list,get,updateTaFields,updateMasterSheet,approveJd,briefNotes,saveJd,create,setWorkingStage}`, `ta/requirements:{scheduleExtraction (helper),jobForExtraction,applyExtraction,markExtractionFailed,reextract,save}`, `ta/requirementsActions:extract`, `ta/jdApproval:scoreWaitingCvs`, `ta/openingAccess:{listAvailable,listPendingForApprover,request,decide}`, `ta/clients:{list,add,update,saveContacts}`, `ta/bin:{binOpening,binClient,restore,deleteNow,list,emptyDue}`, `ta/openingDelete:step`, `ta/workLocations:{assign,inventory}`, `ta/notifications:{create,listForUser,markRead,markAllRead}`, `ta/firstPost:ensurePosts` (migration, `dryRun` default true, run by the pipeline), `ta/commit:apply`.
- Cron: `ta-empty-bin` daily 21:30 UTC. Crons gated by `jobs.status==="active"`: follow-up sweep and SLA breaches (see /follow-up).
- Next routes: `/api/recording`, `/api/snippet/refine`, `/api/notifications`, `/api/mobile/v1/openings/**`.
- Providers/models: JD generation and chat via `write()` (`src/lib/ai.ts`, OpenRouter task `jd`; only the served model works, see memory/openrouter-guardrails), requirements extraction `convex/lib/jdParser.ts` (DeepSeek via OpenRouter), transcription `src/lib/transcribe.ts` (needs an OpenAI key, else "no_key" message), snippets refine via Gemini. Spend metering: `reserve`/`modelCost` in `src/lib/spend.ts` for job details.
- Flags: none specific to openings. Outbound messaging is not sent from this skill's code; `OUTREACH_LIVE` is never set in code (repo rule). Kill switches for follow-up live in `appSettings` (see /follow-up).

## Access and roles
Capabilities from `src/lib/auth.ts` (`can`); seat from `seatFor` (`src/lib/visibility.ts`). "Seat" = assignment on that opening.
| Role | list "All" | read opening | manage (status, edit, team, posts, JD, bin) | create opening | client.manage | commercial.manage (Master Sheet) |
|---|---|---|---|---|---|---|
| admin | all | yes | yes | yes | yes | yes |
| director | all | yes | yes | yes | yes | yes |
| ta_lead | all | yes | yes | yes | yes | yes |
| ops | all | yes | yes | yes | no | yes |
| ta | own only | only if seat/strategy | only primary/supporting seat | yes (self-assigned) | no | no (My Master Sheet read-only scope) |
| ta_support | as ta, plus reads every TA's Excel rows | as ta | as ta | yes | no | no |
| client | seat only | seat only, shortlist stages only (`CLIENT_VISIBLE`) | no | no | no | no |
| viewer | seat only | read only, never writes | no | no | no | no |
- Backend second line (`convex/ta/guard.ts`): `assertJobAccess` (admin/ta_manager bypass; else active assignment with the named roles, or listed in `assignedTaIds`, or job `taLeadId`), `isDeskWideUser`. It is NOT identical to the web: ops/director/ta_lead are `opening.manage` on the web but `approveJd`/`saveJd`/`requirements:save` require a recruiter/director seat in the backend (lead passes via `taLeadId`); `updateMasterSheet` and `workLocations:assign` use `isDeskWideUser`.
- Workday gate: for TAs, `decideOn` calls `ta/workdays:checkScope` before `opening.act` and `opening.sourcing` only (not `opening.manage`, so status/JD/posts are not gated).
- Collision lock (`opening.act`): another TA's claimed candidate is refused for TAs, allowed for leads/directors; backend `assertNotAnotherTasCandidate`. Two TAs on one opening see only their own desk (`ownDeskOf`); leads see both. Pipeline detail: /sets-shortlist.
- Bin and clients: see sections 13-14 for the web/backend mismatch.

## Invariants and safety
- Never touch the live backend from a laptop; Convex changes only via the release pipeline. Data fixes are internal functions with a `dryRun` argument (`ta/firstPost:ensurePosts` is the pattern).
- Outbound to candidates (WhatsApp/email/calls) only through `convex/lib/outreachSafety.ts` and `outboundGuard.ts`; nothing in this feature should send directly. Binning sets `status` to `cancelled` precisely so follow-ups and routing stop (`cc2b2cf`, 28 Sep).
- The server action, not the UI, decides access ("hiding a control is a courtesy"): every opening write goes through `authorize()`/`decideOn()` with the record's own opening (never the posted `openingId`); do not add a write that skips it (13 Sep audit).
- Real candidates are never deleted by deleting an opening or client (`ta/openingDelete`); `syncCandidateOverallStatus` recomputes status.
- A job cannot have a live post before its JD is approved (store gate `JD_NOT_APPROVED`); CV scoring waits while `jdStatus==="pending_ta_approval"` (25 Sep, `convex/lib/jdGate.ts`).
- Fields a person corrected are never overwritten by automatic extraction (`requirementsLockedFields`, `keepLocks`).
- Convex write `repo` pattern: one writer per field; do not follow a backend write with a `repo.*` write of the same row in one request (stale `updatedAt` conflict, 22 Sep). After a direct backend write call `afterBackendWrite`/`resetStore` and revalidate the layout.
- Day counters use Colombo calendar days (`colomboDaysBetween`, 2 Oct `5f507c6`); purge cron and dates are Colombo-aware. Do not use UTC arithmetic.
- Alerts are computed from the record, not stored (a stored alert goes stale).
- Access requests expose only the small projection from `listAvailable`; JD, candidates and pipeline stay refused until approval; approve is one transaction (20 Oct, `61207fe`).
- Deleting a post orphans, never deletes, its applications.
- Binned/deleting rows must be filtered with `isGone` in any new list query.

## Known quirks, gaps and unverified items
- Save team resets every member's `workingStage` to 100% (rows re-created); `primaryRecruiterId` and `taLeadId` are never updated after creation, so `firstPostFor`/routing keep the original primary and `ta/openingAccess` needs the original lead to remain an active `ta_lead`.
- No UI to change `taLeadId`; no UI to clear a director.
- `create` leaves `assignedAt` empty (reads as `createdAt`); the first approved access request then sets `assignedAt = now`, restarting the day counter. `positionCode` is generated only by the JSON store (`C141-####`); `ta/openings:create` does not set it, so Overview "Reference" is blank for Convex-created openings (unverified whether another path fills it).
- The first post made at creation is `live` (job is active) without JD approval and without a link; the store gate applies only to later `setPostStatus`/`addJobPost`.
- `setPostStatus` passes `postedAt: undefined` for non-live statuses and `Object.assign` copies it, clearing `postedAt` on pause/close and re-stamping on every "live"; `low_volume` and `advert_quiet` read `postedAt`.
- "Job Status" in Job details (`ta/requirements:save`) edits `jobs.status` (active/draft/on_hold) without updating `positionStatus`/`closedAt` and offers no filled/closed.
- `deleteFromBinNow` web gate (`isDeskWide`, includes ta_lead) is wider than backend `MAY_DELETE_OPENINGS`; a `ta_lead` whose backend role is not in that list gets a backend error (how a lead's raw backend role reads is unverified here). Same for lead binning an opening they are not seated on.
- `StatusMenu`, `OpeningAdmin` and `OpeningMenu` appear for roles that the action then refuses (client/viewer).
- `ta/openings:list` loader limit is 500; `priorityTier` default and `assignedAt` fallbacks are applied in `mapOpening`, not in storage.
- `OpeningAdmin` locations editor on a legacy job only shows the setup control; no automatic split of headcount.
- No automation sets an opening to Placed/Closed. On-hold behaviour differs per subsystem (see section 5).
- Dashboards: `LeadDashboard` falls back to the whole desk when the lead leads nothing.
- Unverified: exact copy/behaviour of `NewClientDialog` and `ClientCard` internals, mobile payload shapes, `/api/openings/[id]/links/export` (belongs to /excel-tables).

## How to change it safely
- New opening field: `convex/schema.ts` (jobs, optional) -> `convex/ta/model/projections.ts` (`projectOpening`) -> `src/data/convex/map.ts` (`BackendOpening`, `mapOpening`) -> `src/data/types.ts` (`Opening`) -> `convex/ta/model/tables.ts` `openings.toDoc` (if saved via `repo`) -> `src/data/seed.ts`/store defaults -> UI -> mobile payload (`src/lib/mobile/openings*.ts`) -> reports (`src/lib/reportSpec.ts`, `reporting.ts`) if it should appear in the Master Sheet. Schema changes are optional fields (no migration); data fixes are `dryRun` internal functions run by the pipeline.
- New status behaviour: change `OPENING_STATUS` (map.ts), `toDoc.backendStatus`, `statusMatchesBucket`, `masterSheetStatusFields`, `repo.setOpeningStatus`, `StatusMenu` ORDER, mobile status route, and re-check each cron filter (`status==="active"`), `requestable`, `computeAlertsAt`, `postRouting` `linkOnly`, workday filters.
- Priority tiers: `PRIORITY_TARGET` (`types.ts`), `PRIORITY_TIERS` (map.ts), `["P1".."P5"]` in `ta/openings.ts:create` and `writeOpeningDetails`, `OpeningAdmin` select, `reportSpec` options.
- Permissions: edit `can()` in `src/lib/auth.ts`, then the backend line (`guard.ts`, `ta/bin.ts`, `ta/openingAccess.ts`); the web and backend rules differ today, change both and add a test.
- Team/seat logic is shared by web and mobile (`src/lib/openings/admin.ts`, `writes.ts`, `create.ts`); change there, not in `actions.ts` or the mobile route alone.
- JD prompts live in `src/lib/headhunt.ts` (`jdShape`, `HOUSE_RULES`); keep the "never invent a fact" rules. Requirement merge rules: `convex/lib/jobRequirements.ts`.
- Tests (all `tests/*.test.ts`, run by `npm test` -> `node tests/run.mjs`): `openingStatus`, `openingaccess`, `bin`, `setopening`, `workLocations`, `linkedinstatus`, `masterSheet`, `taReports`, `jdchat`, `jdtemplate`, `jobrequirements`, `workingstage`, `auth`, `taseparation`, `tasupport`, `postfiling`, `routing`, `daygroups`, `mobile-openings`, `mobile-opening-admin`, `mobile-new-opening`, `mobile-alerts`, `workday*`. Extend the nearest one; `tests/openingaccess.test.ts` shows the fake-`ctx.db` pattern for Convex mutations.
- Commands: `npm test`, `npx tsc --noEmit -p .`, `npx tsc --noEmit -p convex`. This Next.js version has breaking changes: read `node_modules/next/dist/docs/` before changing routing/server-action code.
- Pre-merge checklist: tests + both type-checks pass; every new write goes through `authorize`/`decideOn` and the backend guard; new list queries filter `isGone`; Colombo-day arithmetic only; no secrets/env values in code or docs; nothing sends to candidates outside `outreachSafety`/`outboundGuard`; dates and wording follow the surrounding comment style; update `docs/` and this skill if behaviour changed.
- Owner flags (do not decide alone): anything that changes what users see on `/openings`, Overview, status labels, dashboard wording, or what candidates receive (JD prompts feed adverts; snippets); status/automation effects; access rules; Bin retention. Never touch the live server/backend without the owner's explicit go-ahead in conversation.

## History
- 2026-09-14 `7470f4f` new TA platform (openings, posts, JD, pipeline) on the JSON store; 2026-09-15 `c4c5f0b`/`c71df93` store backed by Convex, every `repo` write one transaction (`commit.ts`); `2d8d85a` create/saveJd/approveJd in Convex, Job details extracted on approval; `84f7a5c` clients, openings, JD, posts verified end to end.
- 2026-09-16 `691f33c` create a client and its first opening in one pop-up; `1781451` assign to active TAs only; `81976d5` JD and Job details from the lead's brief and TA notes (DeepSeek); `5624082` Delete opening with batched cleanup.
- 2026-09-21 `dee90c2` no TA needed to create (Unassigned bucket), one industry list that follows client edits; `5dfe71c` JD reads as a document, job details beside it.
- 2026-09-22 `4c88bc3` route shared-mailbox CVs by job post (first post at creation, `firstPost.ts`); `30ed4ba` edit a post's title/link, `testPostRoute`; `18ec7fb` match by Recruiter project number.
- 2026-09-24 `3157970` working stage beside status on every row; `6221561` Openings/Clients filters. 2026-09-25 `6ebd3a7` everyone working a job has a stage (taSettings for non-members); `82b7876` JD chat with versions, details wait for approval.
- 2026-09-28 `cc2b2cf` the Bin (7 days, `ta-empty-bin`), after a mistaken delete took a whole pipeline; `2ac2934` TAs may bin openings they recruit on.
- 2026-09-30 `9bddad1` "On LinkedIn" pill on TA and Lead dashboards (PR #99). 2026-10-01 `4949a8d` TA sees the notes left with an opening; `fc5f763` two TAs on one opening work apart. 2026-10-02 `5f507c6` Colombo-day counters; `65a7dad` delete cleans every reference.
- 2026-10-09 `39618c9` TA Support seat. 2026-10-13/14 `23e6794`, `f036a64`, `e7c017b` workday checks (JD review) tie into approve/save JD.
- 2026-10-16 `3a25d55` separate Placed from Closed / Lost buckets (client feedback). 2026-10-19 `b027ae3`, `a4827c9`, `08c7207` Master Sheet generated from activity, editable, split by recruiter. 2026-10-20 `61207fe` TA access requests; 2026-10-21 `ec3d6f0` request moved into a header dialog; `4dd30a8` work locations with per-location L-sheets and daily emails.
- 2026-10-22 `cb821c3`, `7865d66`, `e959bb2` mobile openings, admin actions and New opening, sharing `src/lib/openings/*` with the web. 2026-10-23 `9d664d7` TA job performance in the Master Sheet.

<!-- skill-meta
verified-commit: d078fcb
verified-hash: 4aa65efd929ab3ba5695c45c1a1195d840f3705f
verified-date: 2026-10-27
sources:
  convex/ta/openings.ts
  convex/ta/openingAccess.ts
  convex/ta/openingDelete.ts
  convex/ta/bin.ts
  convex/ta/clients.ts
  convex/ta/requirements.ts
  convex/ta/requirementsActions.ts
  convex/ta/workLocations.ts
  convex/ta/guard.ts
  convex/ta/model/tables.ts
  convex/ta/model/projections.ts
  convex/lib/firstPost.ts
  convex/lib/jdGate.ts
  convex/lib/postRouting.ts
  src/app/openings/page.tsx
  src/app/openings/new/page.tsx
  src/app/openings/[id]/layout.tsx
  src/app/openings/[id]/page.tsx
  src/app/openings/[id]/OpeningAdmin.tsx
  src/app/openings/[id]/jd/**
  src/app/openings/[id]/linkedin-job/page.tsx
  src/app/openings/[id]/snippets/page.tsx
  src/app/openings/[id]/sourcingGate.ts
  src/app/actions.ts
  src/lib/openings/*.ts
  src/lib/health.ts
  src/lib/openingStatus.ts
  src/lib/linkedinStatus.ts
  src/lib/masterSheet.ts
  src/lib/bin.ts
  src/lib/workLocations.ts
  src/lib/auth.ts
  src/lib/visibility.ts
  src/components/ProjectSidebar.tsx
  src/components/ContextBar.tsx
  src/components/StatusMenu.tsx
  src/components/PostManager.tsx
  src/data/convex/map.ts
  docs/work-locations.md
-->
