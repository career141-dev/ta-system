# Ops System <-> TA System: connection points

**Draft for review, 27 Oct 2026.** This document lists **only the common points**, the places where the new Ops system and the existing TA System (the recruiter system) touch. For each one it gives what data crosses, which way, when, and which TA endpoint serves it. It does not design either system's screens or internals.

**Agreed shape (owner, 27 Oct):** two separate UIs and **two separate backends**. The **TA System backend becomes an API** for Ops. Ops gets its **own new backend and database** and reads and writes TA data **only through endpoints**: no shared database, no admin keys. TA-side changes come later. This document only names what the TA API must offer.

Built from:
- the final Ops flow: c5237, the 250-step two-system flow with its OPS/REC/LINK steps; c3626, the locked business flow; and the dated decisions of 20/22/23/26 Oct, all in `/ops`;
- the stage-by-stage comparison (`COMPARISON.md`);
- the TA System code on `main` (`4c355c4`): schema, server actions, the partner API, the mobile API and the alerts.

Field names in `code` are real TA field names unless marked **(new)**.

---

## 0. Reading guide
- **TA** = the existing recruiter system (Next.js app `src/` + self-hosted Convex `convex/`, live at ta-system.career141.com / api.career141.com).
- **Ops** = the new system (new UI + new backend + its own DB).
- **Direction**: `TA -> Ops` (Ops reads or is told), `Ops -> TA` (Ops asks TA to change something), `both`.
- **Kind**: `read` (Ops pulls data), `event` (TA tells Ops something happened), `command` (Ops asks TA to do something; TA applies its own rules and permissions).
- **Status of the TA endpoint**: **exists** (works today), **adapt** (exists, needs a filter or a field), **new**.
- c5237 step names are quoted as written on the canvas (`OPS ...`, `REC ...`, `LINK ...`).

---

## 1. The shape of the connection

```
            Ops UI (new)                                   TA UI (existing, unchanged for now)
                 |                                                   |
        Ops backend + Ops DB (new)                     TA Next.js app (src/)  ── TA Convex backend (convex/)
   leads, ESA workflow, client comms,                 server actions, repo/store,     tables, crons, mail intake,
   interview scheduling (client side),                can() permissions,              follow-up, Director emails
   invoices, payments, guarantees, timers             candidate/interview/offer writes
                 |                                         |                               |
                 |   1) READ    GET  https://api.career141.com/integrations/v1/...   (Convex HTTP, bearer token)  ◄── exists today (Capacity Planner)
                 |   2) EVENTS  GET  .../integrations/v1/events?after=<cursor>     (outbox feed)                ◄── new
                 |   3) COMMAND POST https://ta-system.career141.com/api/ops/v1/... (Next.js route handlers)    ◄── new
                 |   4) WEBHOOK POST <ops-backend>/ta-events  (optional nudge, HMAC signed)                     ◄── new
                 └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Why reads and commands sit in two places (important):**
- **Reads** are simplest from the Convex HTTP router, the same place as today's Capacity Planner API (`convex/http.ts`, `convex/integrations/partnerRead.ts`, `partnerReadHttp.ts`). It already does bearer-token auth (fails closed with 503 when the token is not set), paged reads with an opaque cursor (max 100 rows), CV download and CV upload into R2. It has **no filters and no writes**, which Ops needs.
- **Commands must go through the Next.js app.** Many TA writes are not Convex functions on their own: they run in the app layer through the synchronous `repo` (`src/data/store.ts`), `can()`/`decideOn()` permissions (`src/lib/auth.ts`, `src/lib/openings/writes.ts`), and are committed to Convex by `ta/commit:apply`. This covers placing a candidate (`src/lib/candidates/closingWrites.ts`), interviews (`src/lib/candidates/interviewWrites.ts`), stage moves (`src/lib/openings/pipelineWrites.ts`), clients and openings (`src/app/actions.ts`). An Ops command endpoint must reuse those writers so the same rules apply: collision lock, Director-review details gate, reasons, workday gate, Bin, audit. The mobile API (`src/app/api/mobile/v1/*`, 26 routes) already shows this pattern. It is session-based for people, so Ops needs a **service** version (`/api/ops/v1/*`) with its own token.
- **Events**: TA has no outbound webhooks today. The stage-change log `pipelineEvents` (every stage move; `jobId`, `applicationId`, `fromStage`, `toStage`, `actorType`, `createdAt`) is a ready-made feed for candidate moves. Other changes (opening created, JD approved, interview booked, offer, placement) need a small **outbox** table written in the same transaction **(new: `integrationEvents`)**. Ops pulls `GET /integrations/v1/events?after=<cursor>`; a signed webhook is only a nudge to pull now.

---

## 2. Who owns which record (system of record)
A common point only works if each record has one owner. The other side reads it, or asks the owner to change it through a command.

| Record | Owner | The other side | Why |
|---|---|---|---|
| Lead, intro call, ESA workflow (drafts, chase, countersign, negotiation, decline) | **Ops** | TA reads ESA **status and terms** only | Ops onboards clients |
| Client (company, industry, contacts, ops owner, banking/finance flag) | **Ops** (master) | TA keeps its `clients` table as a **mirror**, written only by Ops commands, because openings and placements point at `clients` | Openings in TA need `clientId`; TA screens show the client |
| ESA terms used for fees (status, fee rule, guarantee days, signed date) | **Ops** | Mirrored into TA `esaRecords` (exists, dormant) so `esaFor()` keeps snapshotting fee and guarantee on Place | TA already snapshots terms at placement |
| Requirement (from the requirement meeting) | **Ops** | Becomes a TA opening through a command | Ops runs the meeting; TA runs the search |
| Opening (job), team seats, JD, job posts, stages, candidates, CVs, follow-up, Director set | **TA** | Ops reads + receives events | TA's core |
| Client round (client set): which candidates, which CVs | **TA builds it** (`reviewRounds`, kind client) | **Ops sends it**, records receipt, ownership claims and client decisions, and pushes decisions back | Client communication belongs to Ops; the candidate list belongs to TA |
| Interview record (time, round, mode, outcome, feedback) | **TA** (`interviews`) | Ops schedules the **client side** and writes the booking into TA by command; TA handles the **candidate side** (reconfirm, availability) | One interview record, two teams |
| Offer and placement (salary, join date, fee snapshot) | **TA** (`offers`, `placements`) | Ops reads + events; Ops adds package, offer letter, DOJ changes by command | TA presses Place |
| Invoice, payment, late charge, write-off, surcharge, guarantee, replacement/refund decision | **Ops** | TA gets **status only** (for display later) and commands (reopen opening, close opening) | Money and guarantee are Ops |
| People (users, roles) | **TA** (`users`, Clerk) for now | Ops reads the directory; Ops-only roles live in Ops | One sign-in directory to start |
| Ad channels TopJobs / Talent Pulse | **Ops** | TA receives source tags and the CVs | Ops runs the ad relay |
| Alerts and bells | each side its own | cross-notifications through a command (`notify`) | TA users live in TA |

---

## 3. The common points, step by step (client onboarding -> close)
Each block: **c5237 steps** -> **direction / kind** -> **data** -> **TA endpoint** -> **rules** -> **notes**.

### CP-01 People directory and roles
- **Steps**: every step with an owner: "Owner alerted", "Primary TA picked", "TA alerted of booking", "Asma and ops told".
- **Direction / kind**: TA -> Ops, read (plus changes via events).
- **Data** (`users`): `_id`, `email`, `fullName`, `initials`, `taRole` (admin, director, ta_lead, ta, ta_support, ops, client, viewer), `isActive`, `routingEmail` (a TA's own jobs mailbox), `workCountry`, `phone`. Plus `teams`/`teamMembers` if used.
- **TA endpoint**: **exists** as `GET /integrations/v1/tables/users` (whole table, paged). **Adapt**: `GET /integrations/v1/people?role=&active=` returning only these fields, never `tokenIdentifier`.
- **Rules**: match a person across systems by **email** (TA's sign-in joins Clerk to `users` by verified email). Ops-only roles (ops owner, ops lead, accounts, Director of Operations, marketing) are kept in Ops.
- **Notes**: Ops needs TA user ids to assign the primary TA and to notify people.

### CP-02 Client master: create, link, update
- **Steps**: "OPS Duplicate client match", "OPS Existing client linked", "LINK Client, ops owner recorded".
- **Direction / kind**: Ops -> TA, command; TA -> Ops, read for matching.
- **Data**: `clients`: `name`, `nameKey` (TA's dedup key: lower case, punctuation stripped), `industry`, `contacts[] {name,title,email,isPrimary}`, `status` (active/dormant/archived), `esaSignedAt`, `researchNotes`. **New** on the TA mirror: `opsClientRef` (Ops id), `opsOwnerEmail` (display only), `bankingFinanceFlag`.
- **TA endpoints**:
  - read: **exists** (`/tables/clients`). **Adapt**: `GET /integrations/v1/clients?nameKey=` and `?updatedSince=` (the table has no `updatedAt` today: **new field**).
  - command: **new** `POST /api/ops/v1/clients/upsert`, reusing `convex/ta/clients.ts add/update/saveContacts`. `add` already returns the existing id when the `nameKey` matches, and restores a binned client.
- **Rules**:
  - one client per `nameKey`;
  - adding a client that is in the Bin restores it;
  - a client can be binned only with no live openings (`convex/ta/bin.ts`);
  - industry changes flow to the client's openings unless the job locked the field (`clients.ts update`).
- **Notes**: in TA today only admin/director/ta_lead may manage clients (`client.manage`). The Ops service token is authorised for this command instead.

### CP-03 ESA status and terms
- **Steps**:
  - "OPS ESA lookup" (needs: is there a signed ESA?);
  - "LINK Notice to ops, TA, director";
  - "LINK Director countersigns";
  - "OPS ESA declined" -> "Search blocked, team told";
  - "LINK Client, ops owner recorded".
- **Direction / kind**: Ops -> TA, command (mirror the outcome); TA -> Ops, read (existing ESAs at go-live).
- **Data**:
  - `esaRecords`: `clientId`, `openingId` (null = client-wide), `status` (pending/sent/signed/expired/not_required; **add `declined`**), `sentAt`, `signedAt`, `signedBy`, `documentName`/`esaDocumentUrl`, `dueAt`, `feePercent`, `guaranteeDays`.
  - **New**: fee rule (months of gross 1 or 2 by nationality, gross/basic, flat fee), `countersignedAt`, `opsEsaRef`.
- **TA endpoints**:
  - read: **exists** (`/tables/esaRecords`). **Adapt**: by `clientId`.
  - command: **new** `POST /api/ops/v1/esa/upsert`, built on the dormant `repo.saveEsa`. It already keeps `clients.esaSignedAt` in step with the newest signed record.
- **Rules**:
  - only the ESA outcome crosses; drafts, chase messages and negotiation notes stay in Ops;
  - **ESA declined blocks search**: TA must refuse `opening.create` for that client (**new** guard);
  - `esaFor(clientId, openingId)` picks the ESA for a placement in this order: signed for this opening, then signed client-wide, then not_required, then the latest unsigned.
- **Notes**: fee and guarantee terms are snapshotted at Place (CP-17), so a wrong mirror means a wrong invoice basis.

### CP-04 Requirement -> opening created in TA (the main hand-over)
- **Steps**: "LINK Requirement meeting held" -> "LINK Requirement saved" -> "LINK Opening built" -> "LINK Primary TA picked" -> "LINK 100% day set" -> "LINK Bell to TA".
- **Direction / kind**: Ops -> TA, command; TA -> Ops, event `opening.created`.
- **Data sent** (maps to `jobs`):
  - `title`, `clientId`;
  - salary `salaryMin`/`salaryMax`/`salaryCurrency`, `location` and work locations, `seniorityLevel`, `experienceMinYears`/`experienceMaxYears`, `isConfidential`, `headcount`, priority tier (P1-P5; TA default P3), `recruitmentType`;
  - requirement notes (into a `briefs` row: `kind`, `notesMarkdown`, `transcript`, `recordingKey`, `capturedBy`, `method`);
  - JD draft text if Ops has one;
  - team: `taLeadId`, primary TA, supporting TAs (`jobAssignments` with `assignmentRole` primary_recruiter / supporting_recruiter / director / client_contact);
  - the primary TA's 100% day (`jobAssignments.workingStage = "100%"`);
  - **new** `opsRequirementRef`, `handoverAt`.
- **Data returned**: `openingId` (`jobs._id`), `keyword`, `status`, `jdStatus`, the first LinkedIn job post id.
- **TA endpoint**: **new** `POST /api/ops/v1/openings`, reusing the opening create path: `createOpening` in `src/app/actions.ts`, `ta/openings:create`, `setAssignments`, `setWorkingStage`. The mobile API has `openings/new`, `team` and `working-stage` routes to copy.
- **Rules**:
  - TA creates the first LinkedIn advert automatically;
  - new openings start with the JD "waiting for approval";
  - `taLeadId` is set once at creation;
  - saving the team resets every TA's working stage to 100% (a known TA quirk);
  - the 100% rule in TA's workday (`/workday`) may refuse 100% on a returning job (later TA change);
  - **idempotent** on `opsRequirementRef`, so a retry never makes two openings.
- **Notes**: the "bell to TA" is a TA notification (`notifications`, type opening_assigned) raised by TA itself.

### CP-05 Opening state that Ops watches
- **Steps**: "LINK JD approved", "REC Approval alert" (JD unapproved after 1 day), "LINK LinkedIn advert Live", "REC LinkedIn reposted", "LinkedIn closed", monitor-only.
- **Direction / kind**: TA -> Ops, read + events.
- **Data**:
  - `jobs`: `status` (active/on_hold/filled/cancelled/draft; UI open/on_hold/filled/closed), `jdStatus`, `jdApprovedAt`/`jdApprovedBy`, priority, `assignedAt` (day-N-of-target), `binnedAt`.
  - `jobPosts`: `status` (draft/live/paused/closed), `externalUrl` (the LinkedIn job URL), `postedAt`, `channel`, `cvCountToday`, `assignedTaId`.
  - `jobAssignments`: `workingStage` per TA.
- **Events (new)**:
  - `opening.updated` (status, priority, team);
  - `opening.jd_approved`;
  - `jobpost.live` / `jobpost.closed` (with `externalUrl`);
  - `opening.working_stage_changed`.
- **TA endpoint**: read **exists** (`/tables/jobs`, `/tables/jobPosts`, `/tables/jobAssignments`). **Adapt**: `GET /integrations/v1/openings/{id}` returning one opening with posts, team and stage counts (`jobs.stageCounts`).
- **Rules**: Live needs an approved JD (TA rule today); Ops needs the LinkedIn URL for Talent Pulse and closing.

### CP-06 Ad channels: TopJobs and Talent Pulse -> source-tagged CVs
- **Steps**: "TopJobs requested" -> "OPS Request routed to marketing" -> "OPS Flyer designed" -> "OPS Flyer sent to TopJobs" -> "LINK TopJobs ad Live" -> "LINK TopJobs ad closed" (2 weeks); "OPS Talent Pulse list compiled" (Tue) -> "OPS Newsletter posted" (Wed) -> "REC CV arrives" -> "LINK CV source tagged".
- **Direction / kind**: TA -> Ops, command `request TopJobs` (raised by a TA); Ops -> TA, events/commands (live, closed, cost); TA -> Ops, read (open openings with a short brief, for the Talent Pulse list); Ops -> TA, CVs with a source tag.
- **Data**:
  - TopJobs: request (`openingId`, requester), live date, close date, cost (5,400 / 12,700).
  - Talent Pulse: edition date, list of `openingId` + title + short brief + tracked apply link **(new)**.
  - CV source: `cvUploads.source` / `applications.sourceChannel` / `taSourcingChannel` with **new** values `topjobs`, `talent_pulse`.
- **TA endpoints**:
  - read: open openings for the list (**adapt**: `GET /integrations/v1/openings?status=active` with title and brief);
  - command: **new** `POST /api/ops/v1/openings/{id}/ad-channel` (record TopJobs live/closed and cost for display and the TA alert);
  - CVs: TopJobs/Talent Pulse applicants reach TA through its mailboxes (mail intake routes by advert: `convex/ta/intakeRouting.ts`, `src/lib/routing.ts`) **or** through a **new** command `POST /api/ops/v1/cvs` that files a CV to an opening with a source (built on the existing upload path `/api/cv/upload` -> `ta/cv:attach` / extraction queue). The existing partner CV upload stores files only and does **not** create candidates, so it is not enough.
- **Rules**: TopJobs closes 2 weeks after posting; LinkedIn reposted under 20 CVs/day; CVs must be source-tagged (brief: Talent Pulse CVs don't land in the TA's job today).

### CP-07 Candidate pipeline feed (counts and stage moves)
- **Steps**: "LINK Pipeline pending counted", "LINK Total shortlisted counted", "LINK Add-on alert to TA", "LINK Hold at five CVs", "LINK Five-CV hold lifts", the weekly report.
- **Direction / kind**: TA -> Ops, events + read.
- **Data**:
  - `pipelineEvents`: `jobId`, `applicationId`, `candidateId`, `eventType` (stage_change_<stage>), `fromStage`, `toStage`, `actorType`, `actorId`, `isBackwardMove`, `createdAt`.
  - `applications`: `currentStage` (backend: new_cvs, matched_candidates, ta_shortlist, follow_up, second_shortlist, director_shortlist, client_review, interview, offer, placed, rejected, unresponsive), `ownerTaId`, `setNumber`, `isAddOn`, `backupForApplicationId`, `lastStageChangedAt`.
  - `jobs.stageCounts`.
- **TA endpoint**: read **exists** (`/tables/pipelineEvents`, `/tables/applications`). **Adapt**: `GET /integrations/v1/openings/{id}/pipeline` (counts by stage + list of client-stage candidates), and the events feed (**new** `GET /integrations/v1/events`, with `pipelineEvents` as its first source; needs a time-ordered index, today only `by_job_time` etc.).
- **Rules**:
  - only TA's stage names and translator (`convex/ta/stages.ts`) are authoritative; TA's UI names differ (director_review = second_shortlist, client_shortlist = client_review, dropped_out = unresponsive);
  - depth rule: <=3 pending interviews -> add-on; 5 shortlisted in total -> hold; below five -> lift.
- **Notes**: decide who computes depth (recommendation: Ops computes from the feed and sends a command, CP-14, because the rule needs client-side facts).

### CP-08 Director set (stays in TA) -> its result
- **Steps**: "REC Director set size check" (min 5) -> "REC Set email drafted/approved" -> "LINK Set emailed to Director" -> "LINK Director reviews" -> "REC Director chase" -> "LINK Reply read in" -> "REC Director shortlist recorded" / "REC Rejected by Director".
- **Direction / kind**: TA -> Ops, events + read (Ops does not touch the Director process: decision "Director process unchanged").
- **Data**:
  - `reviewRounds` (kind director): `openingId`, `setNumber`, `applicationIds`, `sentAt`, `sentBy`, `status` (awaiting/partial/returned), `decisions[]`.
  - `dailyEmails` (EOD records) for the weekly report.
- **TA endpoint**: read **exists** (`/tables/reviewRounds`, `/tables/dailyEmails`). **New** events: `director_round.sent`, `director_round.decided`.
- **Rules**: min 5 CVs (planned; TA today closes a set at 5+ in a Colombo day); no reason needed from the Director.

### CP-09 Client set: built by TA, sent by Ops (core hand-over)
- **Steps**: "Client set size check" (min 5) -> "LINK Client set drafted" -> "OPS Set due date tracked" (7-14 days of ESA) -> "OPS Ops reviews set" -> "OPS Set approved" -> "LINK Set sent to client" -> "OPS Client group created" -> "OPS Set posted in client group" -> "OPS Set logged" -> "OPS Client receipt date saved".
- **Direction / kind**: TA -> Ops, event `client_set.ready` + read; Ops -> TA, command `client_set.sent`.
- **Data TA -> Ops**:
  - the round: `reviewRounds` kind client, `setNumber`, `applicationIds`, subject "CLIENT > ROLE > SET n";
  - per candidate: name, current company and designation, notice, current/expected salary, notes. These are the EOD table fields: `shortlistRows` in `src/lib/eod.ts`, from `applications` + `candidates`;
  - **files**: the prepared CV PDF per candidate (`src/lib/preparedCvFile.ts`, `/api/prepared-cv/[appId]`) and the original CV (`GET /integrations/v1/cv/{cvUploadId}`, exists).
- **Data Ops -> TA**: `sentAt`, `sentTo`, `receivedAt` (starts the 7-working-day ownership clock and the feedback timer), the Ops message id.
- **TA endpoints**:
  - read **adapt**: `GET /integrations/v1/openings/{id}/client-set/{setNumber}` (candidates + fields above);
  - files: **exists** for the original CV; **new** `GET /api/ops/v1/applications/{appId}/prepared-cv` (service-token version of `/api/prepared-cv/[appId]`);
  - command: **new** `POST /api/ops/v1/client-sets/{roundId}/sent`. Today the client round is saved with `dispatch: "held"` and never sent (`src/data/store.ts`), so Ops becomes the sender and TA records it as sent.
- **Rules**: ops owner approves before sending; WhatsApp group posts stay manual (Ops logs them); sending to a client goes through Ops's own outbound safety (same principle as TA's `outreachSafety`).

### CP-10 Client decisions on the set -> candidate stage in TA
- **Steps**: "LINK Client replies" -> "LINK Reply read into system" -> "LINK TA informed" -> "LINK Reason saved" -> "LINK Client decision" -> "REC Rejected by client" -> "REC Client rejection notice" / "LINK Candidate marked shortlisted".
- **Direction / kind**: Ops -> TA, command; TA -> Ops, event (the stage change).
- **Data**: `applicationId`, decision (shortlisted / rejected / hold), reason (if given), source (email/WhatsApp/call), who recorded it, the reply text or reference.
- **TA endpoint**: **new** `POST /api/ops/v1/applications/{appId}/client-decision`, reusing the stage move path (`src/lib/openings/pipelineWrites.ts` -> `ta/applications:moveStage`, `recordShortlistDecision` in `convex/lib/shortlistDecision.ts`). It sets director_shortlist -> client_review (client shortlist), or rejected with a reason, as a **recorded client reply** (TA's `decide.client` / `decidedByReviewer` path, so no TA user is impersonated).
- **Rules**:
  - TA must inform the TA either way (bell);
  - rejected -> candidate rejection notice (sent by TA, CP-21);
  - reason required for reject and hold;
  - a decision applies only if the candidate is still in the stage the round left them in (TA reply-reader rule).
- **Notes**: TA also reads client replies itself from shortlists@ (`convex/mailIntake/*`). **Pick one reader** for client replies once Ops owns client email (recommendation: Ops; TA keeps reading Director replies).

### CP-11 CV ownership claim (7 working days)
- **Steps**: "OPS Ownership clock starts" -> "OPS Countdown shown" -> "OPS Claim checked" -> "OPS CV dropped, not pursued" -> "OPS Candidate marked client-owned" -> "OPS Rest of set continues" / "OPS Claim refused".
- **Direction / kind**: Ops -> TA, command.
- **Data**: `applicationId`, `claimedAt`, decision (dropped/refused), reason "client already had CV".
- **TA endpoint**: **new** `POST /api/ops/v1/applications/{appId}/client-owned` (moves the candidate out of the client round with reason; **new** flag `clientOwnedAt` so TA never offers that person to that client again).
- **Rules**: 7 working days from receipt (CP-09 `receivedAt`); working days use one shared holiday calendar (see section 6).

### CP-12 Client silence -> position on hold / lift / close
- **Steps**: "OPS Feedback timer starts" -> "OPS Chase drafted/approved/sent" -> "OPS Owner calls client" -> "OPS Client silent after call" -> "OPS Inactive notice drafted/approved/sent" -> "OPS Position on hold" -> "OPEN Silent-hold limit" -> "LINK Lead or position closed".
- **Direction / kind**: Ops -> TA, command; TA -> Ops, event.
- **Data**: `openingId`, new status (`on_hold` with reason "client inactive (ESA)"), later back to `active`, or closed.
- **TA endpoint**: **new** `POST /api/ops/v1/openings/{id}/status` (reuses `setOpeningStatus` / `repo.setOpeningStatus`; the mobile API has `openings/[id]/status`).
- **Rules**:
  - TA On hold already stops TA's automatic follow-up sweep and SLA alerts and keeps intake only through the post's own link;
  - hold needs a reason (**new** field);
  - the silence clock is 14 calendar days after profiles shared (resolved rule).

### CP-13 Unreported hire (3 months)
- **Steps**: "LINK Set sent to client" -> "OPS Unreported hire flagged" -> "OPS Surcharge invoice drafted/approved/sent".
- **Direction / kind**: TA -> Ops, read.
- **Data**: candidates sent in each client set and their later status (placed with this client? reported?).
- **TA endpoint**: read **adapt** (client rounds + applications by `clientId`).
- **Notes**: the surcharge invoice itself is Ops-only.

### CP-14 Pipeline depth -> TA mode (add-on / monitor / resume)
- **Steps**: "LINK Add-on alert to TA" -> "REC Add-on search" (30-60 min a day); "LINK Hold at five CVs" -> "REC Monitor position" (LinkedIn closes); "LINK Five-CV hold lifts".
- **Direction / kind**: Ops -> TA, command (if Ops computes; see CP-07).
- **Data**: `openingId`, TA user, mode (`Add-on`, monitor), reason (counts).
- **TA endpoint**: **new** `POST /api/ops/v1/openings/{id}/working-stage` (reuses `setWorkingStage`; the mobile route exists) + `notify` (CP-22).
- **Rules**:
  - TA working stages are 100% / Follow-up / Add-on; "monitor" does not exist as a mode (**new** value or a flag);
  - mode changes are refused after the day's EOD is sent (TA `recordActiveMode`).

### CP-15 Interviews (shared record; Ops = client side, TA = candidate side)
- **Steps**:
  - **Ops**: "OPS Who schedules?", "OPS Client slots requested/received", "OPS Slots checked with candidate", "OPS New slots requested", "OPS Slot loop, TA alerted", "OPS Client contacts candidate", "OPS Date reported/logged", "OPS Report reminder to client";
  - **booking**: "LINK Interview booked" -> "LINK Invite and Teams sent" -> "LINK TA alerted of booking";
  - **reconfirm**: "OPS Day-before reconfirm" -> "REC Candidate reconfirms" / "REC Reconfirm call task" / "REC Candidate out or no-show";
  - **cancel**: "LINK Client cancel logged" -> "LINK TA told of cancel";
  - **on the day**: "OPS Interview day arrives" -> "LINK Interview held" -> "OPS Attendance marked".
- **Direction / kind**: both. Ops -> TA, commands (book, reschedule, cancel, attendance); TA -> Ops, events (candidate confirmed, candidate out, feedback); Ops -> TA, read (candidate phone/availability for slot checks).
- **Data** (`interviews`, which exists and is rich):
  - `applicationId`, `jobId`, `candidateId`, `title`, `round`, `scheduledAt`, `timezone`, `interviewFormat`/mode (in_person/video/phone), `location`, `interviewers[]`, `durationMins`;
  - `confirmedAt`;
  - `taOutcome` (pending/attended/no_show/cancelled), `taResult` (pending/passed/failed/on_hold);
  - `taHistory[]` (rescheduled/status/edited with reason);
  - `taFeedback[]`, `clientFeedback`, `clientRating`;
  - **new**: `scheduledBy` (client/us), Teams link, slot proposals, `opsInterviewRef`.
- **TA endpoints**:
  - read **exists** (`/tables/interviews`);
  - commands **new** `POST /api/ops/v1/interviews` (book), `.../{id}/reschedule`, `.../{id}/outcome`, reusing `writeCandidateInterview` (`src/lib/candidates/interviewWrites.ts`), which already handles schedule, confirm, reschedule (old time kept with reason), outcome, result, edit and feedback;
  - events **new**: `interview.confirmed`, `interview.candidate_out`, `interview.outcome`, `interview.feedback`.
- **Rules**:
  - client notified at least 1 day (or 3 hours) before a candidate drops out (Ops sends; TA tells Ops);
  - TA already raises `interview_confirmation` (day of), `interview_confirmation_escalation` (<4 h, nobody called) and `interview_followup` (after attended) alerts (`src/lib/sla.ts`);
  - candidate messages (reconfirm, notices) stay TA's (TA owns the candidate WhatsApp/email and safety gates);
  - Teams/Outlook invites to the client and interviewers are Ops's.

### CP-16 Interview feedback and round decision
- **Steps**: "REC TA logs feedback after 5 PM" -> "REC Candidate told" -> "OPS Client message drafted/approved" -> "OPS Feedback posted to client" -> "LINK Client round decision" -> "LINK TA informed of decision" -> round 2 / reference / rejected after round -> "REC Candidate told not moving".
- **Direction / kind**: TA -> Ops, event (TA feedback); Ops -> TA, command (client round decision).
- **Data**: interview feedback (`taFeedback`), client decision (round 2 / selected / not moving) + reason.
- **TA endpoint**: **new** `POST /api/ops/v1/interviews/{id}/client-decision` (round 2 -> new interview round; not moving -> rejected with reason, same stage-move path as CP-10).
- **Rules**: TA informed either way; back-up kept at the final stage (TA's back-up tag `backupForApplicationId`).

### CP-17 Reference check (only if the client asks)
- **Steps**: "REC Client asks for reference?" -> "REC TA calls referee" -> "REC Reference reported to client" / "REC Referee not reached" -> "Client clears reference".
- **Direction / kind**: Ops -> TA, command (request); TA -> Ops, event (result).
- **Data**: request (`applicationId`, who asked); result (referee name, company, notes as is, not reached).
- **TA endpoint**: **new** `POST /api/ops/v1/applications/{appId}/reference-request` + event `reference.reported`. TA has `referees` from CVs and the Referee Calls grid (sourcing); a client-requested reference record is **new**.

### CP-18 Offer: made, accepted, declined (search stops)
- **Steps**: "LINK Offer made" -> "LINK Search stops" -> "LINK Offer accepted" / "REC Offer declined" -> "REC Back-up promoted" / "REC Search reopened"; "OPEN Offer silent".
- **Direction / kind**: TA -> Ops, events + read.
- **Data** (`offers`): `applicationId`, `jobId`, `candidateId`, `offeredSalary`, `offeredSalaryCurrency`, `salaryBasis` (monthly/annual), `startDateMs`, `status` (pending/accepted/declined/withdrawn), `declineReason`, `madeBy`, `createdAt`.
- **TA endpoint**: read **exists** (`/tables/offers`). Events **new**: `offer.made`, `offer.accepted`, `offer.declined`.
- **Rules**: search stops at the offer (Ops closes TopJobs; TA closes LinkedIn); TA's offer panel only allows offers from Client Shortlist/Interview/Offer/Placed (`src/components/ClosingPanel.tsx`).

### CP-19 Placement: Place, package, DOJ, offer letter, Asma told the same day
- **Steps**: "LINK TA presses Place" -> "LINK Package, DOJ, offer letter asked" -> "LINK Placement saved" -> "LINK Asma and ops told" -> "OPS DOJ tracked" -> "OPS Date move logged" / "LINK Placement cancelled" (candidate lost).
- **Direction / kind**: TA -> Ops, event `placement.created` + read; Ops -> TA, command (package, offer letter, DOJ change, cancel).
- **Data** (`placements`):
  - `applicationId`, `jobId`, `candidateId`, `offerId`, `clientId`, `placedBy`, `joinDateMs`/`joinDate`, `placedSalary`/`placedSalaryCurrency`, `salaryBasis`;
  - **snapshot** `feePercent`/`flatFee`, `guaranteeDays` (taken from the ESA via `esaFor`, CP-03), `taSourcingChannel`, `sourceChannel`;
  - **new**: package details, offer-letter file, DOJ history `[{from,to,at,by,reason}]`, invoice address.
- **TA endpoints**: read **exists** (`/tables/placements`); event **new** `placement.created` (raised by `recordPlacement` -> `writeCandidateClosing`); commands **new** `POST /api/ops/v1/placements/{id}/details`, `.../doj`, `.../cancel`.
- **Rules**: "Asma and ops told" the same day = Ops reacts to the event; the placement **snapshots** terms (a later ESA change does not change it).
- **Notes**: TA's Place currently redirects the TA to `/placements/{id}`, a page that does not exist. A TA fix, not a connection.

### CP-20 Joining day, no-show, guarantee start
- **Steps**: "OPS Joining-day 9am alert" -> "LINK TA confirms joined" -> "LINK 90-day clock starts" / "OPS No-show flagged" -> "OPS Client options sent" (replace or stop, no refund).
- **Direction / kind**: TA -> Ops, events; Ops -> TA, command (replacement search or close).
- **Data**: `placements.joinConfirmedAt` (**exists**), no-show flag/reason (**new**; TA has `fellThroughAt`/`fellThroughReason`).
- **TA endpoint**: events **new** `placement.joined`, `placement.no_show`. TA already raises the `joining_date` alerts ("starts today" 9 AM Colombo; "no start date agreed").
- **Rules**: the guarantee starts on the join date; invoices for the first hire only.

### CP-21 Candidate rejection notices
- **Steps**: "REC Director rejection notice", "REC Client rejection notice", "REC Candidate told not moving".
- **Direction / kind**: inside TA, triggered by CP-08/10/16.
- **Data**: `applicationId`, template id, channel.
- **Rules**: one approved template, automatic (resolved rule); goes through TA's `outreachSafety`/`outboundGuard`; Ops only needs the "sent" event for its log.

### CP-22 Guarantee events -> TA opening
- **Steps**: "LINK Candidate leaves" -> "LINK Position reopened" (replace first) -> "OPS 60-working-day clock starts" -> "OPS Director of Operations told" -> "OPS Refund 25%" -> "OPS Refund logged"; "OPS No guarantee, clock stopped" (fee unpaid); "LINK 90-day clock starts" (replacement hire: new guarantee, no invoice); "OPS Guarantee ends clean" -> "OPS Commitment done".
- **Direction / kind**: Ops -> TA, commands; TA -> Ops, event (a replacement placement links to the original).
- **Data**: `placementId`, leaver date and reason, decision (replace / refund / void), `replacementOf` (**new** on placements).
- **TA endpoints**:
  - **new** `POST /api/ops/v1/placements/{id}/left` (TA marks fall-through: `fellThroughAt`/`Reason`; moves the candidate out of Placed; TA allows Placed -> Dropped Out/Rejected inside the guarantee);
  - **new** `POST /api/ops/v1/openings/{id}/reopen` (same opening back to active, TA told).
- **Rules**: TA's checklist today raises "refund or free re-run owed" at once (`src/lib/closing.ts refund_due`); with Ops owning the guarantee this becomes display-only (later TA change).

### CP-23 Close: posts, position, lead
- **Steps**: "LINK Lead or position closed" -> "LinkedIn closed" (TA closes; also when under 20 CVs/day or monitor-only), TopJobs closed (Ops).
- **Direction / kind**: Ops -> TA, command; TA -> Ops, event.
- **Data**: `openingId`, close reason (placed/guarantee ended; lost; refund; written off; client silent; ESA declined), posts to close.
- **TA endpoint**: **new** `POST /api/ops/v1/openings/{id}/close` (reuses `setOpeningStatus` filled/closed + `setPostStatus` closed). Event `opening.closed`.
- **Rules**: resolved rule: the position closes when the guarantee ends (clean, refund paid or fee written off); placing a candidate never marks the opening Placed in TA today.

### CP-24 Weekly report to Mr Azeem
- **Steps**: "OPS Weekly report built" -> "OPS Report sent to Mr Azeem" (TA lead owns).
- **Direction / kind**: TA -> Ops, read.
- **Data**: per open opening: client, title, TA, days against target, stage counts, sets sent, interviews, offers, client feedback pending.
- **TA endpoint**: **adapt** `GET /integrations/v1/reports/active-positions` (TA Reports page logic, `src/lib/reporting.ts`, `masterSheet.ts`).

### CP-25 Notifications across the line
- **Steps**: "LINK Owner alerted", "LINK Bell to TA", "LINK TA alerted of booking", "LINK TA told of cancel", "LINK TA informed", "REC Escalated to TA", "OPS Late-send alert".
- **Direction / kind**: Ops -> TA, command; TA -> Ops, events.
- **Data**: `notifications`: `userId`, `type`, `title`, `body`, `jobId`, `candidateId`, `read`, `createdAt`.
- **TA endpoint**: **new** `POST /api/ops/v1/notify` (insert a TA notification; TA's bell plays the chime). TA -> Ops alerts arrive as events.
- **Rules**: a person is identified by email (CP-01); no duplicates (idempotency key).

### CP-26 Files
- **What crosses**: CVs, prepared CVs (CP-09), offer letters (CP-19), signed/countersigned ESAs (CP-03), requirement recordings (CP-04).
- **TA endpoints**:
  - **exists**: `GET /integrations/v1/cv/{cvUploadId}`, `POST /integrations/v1/cv/uploads` + `/complete` (R2, 10 MB, PDF/DOC/DOCX, checksum, store-only);
  - **new**: prepared CV by application; attach an offer letter or ESA document to a placement/ESA record.
- **Rules**: server to server only; `Cache-Control: no-store`; never put file links in browser code.

---

## 4. TA endpoint catalogue (what Ops calls)
| # | Method + path | Kind | Status | Serves |
|---|---|---|---|---|
| 1 | `GET /integrations/v1/tables`, `GET /integrations/v1/tables/{table}?limit&cursor` | read | **exists** | bulk/initial sync of any whitelisted table |
| 2 | `GET /integrations/v1/cv/{id}`; `POST /integrations/v1/cv/uploads`, `/complete` | files | **exists** | CP-26 |
| 3 | `GET /integrations/v1/events?after&limit` | events | **new** | every TA -> Ops event (section 5) |
| 4 | `GET /integrations/v1/people` | read | adapt | CP-01 |
| 5 | `GET /integrations/v1/clients?nameKey|updatedSince` | read | adapt | CP-02 |
| 6 | `GET /integrations/v1/openings?status&clientId`; `/openings/{id}` | read | adapt | CP-05, CP-06, CP-24 |
| 7 | `GET /integrations/v1/openings/{id}/pipeline` | read | adapt | CP-07, CP-13 |
| 8 | `GET /integrations/v1/openings/{id}/client-set/{setNumber}` | read | adapt | CP-09 |
| 9 | `GET /integrations/v1/reports/active-positions` | read | adapt | CP-24 |
| 10 | `POST /api/ops/v1/clients/upsert` | command | new | CP-02 |
| 11 | `POST /api/ops/v1/esa/upsert` | command | new | CP-03 |
| 12 | `POST /api/ops/v1/openings` | command | new | CP-04 |
| 13 | `POST /api/ops/v1/openings/{id}/status` / `/close` / `/reopen` | command | new | CP-12, CP-22, CP-23 |
| 14 | `POST /api/ops/v1/openings/{id}/working-stage` | command | new | CP-14 |
| 15 | `POST /api/ops/v1/openings/{id}/ad-channel` | command | new | CP-06 |
| 16 | `POST /api/ops/v1/cvs` | command | new | CP-06 (file a sourced CV to an opening) |
| 17 | `GET /api/ops/v1/applications/{appId}/prepared-cv` | files | new | CP-09 |
| 18 | `POST /api/ops/v1/client-sets/{roundId}/sent` | command | new | CP-09 |
| 19 | `POST /api/ops/v1/applications/{appId}/client-decision` | command | new | CP-10 |
| 20 | `POST /api/ops/v1/applications/{appId}/client-owned` | command | new | CP-11 |
| 21 | `POST /api/ops/v1/applications/{appId}/reference-request` | command | new | CP-17 |
| 22 | `POST /api/ops/v1/interviews`; `/{id}/reschedule`; `/{id}/outcome`; `/{id}/client-decision` | command | new | CP-15, CP-16 |
| 23 | `POST /api/ops/v1/placements/{id}/details` / `/doj` / `/cancel` / `/left` | command | new | CP-19, CP-20, CP-22 |
| 24 | `POST /api/ops/v1/notify` | command | new | CP-25 |
Command response (all): `200 {ok:true, id, changed}` or `4xx {ok:false, code, message}` with TA's own refusal text (e.g. collision lock, details gate, workday rule). Every command takes an `Idempotency-Key` header; a repeat returns the first result.

## 5. Event catalogue (TA -> Ops feed)
Every event: `{ id, type, at, openingId?, applicationId?, candidateId?, clientId?, actor:{type,id,email?}, data:{...} }`, ordered by `id` (monotonic cursor), kept at least 30 days.
| Event | Raised in TA by | Used for |
|---|---|---|
| `opening.created` / `opening.updated` / `opening.closed` | opening create, `setOpeningStatus`, team saves | CP-04, CP-05, CP-23 |
| `opening.jd_approved` | `approveJd` | CP-05 (JD alert, Talent Pulse) |
| `opening.working_stage_changed` | `setWorkingStage` / `recordActiveMode` | CP-14 |
| `jobpost.live` / `jobpost.closed` | `setPostStatus` | CP-05, CP-06, CP-23 |
| `application.stage_changed` | `pipelineEvents` (every `executeStageTransition`) | CP-07, CP-10, CP-13 |
| `director_round.sent` / `director_round.decided` | `finalizeDailyEmail`, reply reader | CP-08 |
| `client_set.ready` | client round created (today `dispatch:"held"`) | CP-09 |
| `interview.booked` / `interview.confirmed` / `interview.candidate_out` / `interview.outcome` / `interview.feedback` | `writeCandidateInterview` | CP-15, CP-16 |
| `reference.reported` | reference record (new) | CP-17 |
| `offer.made` / `offer.accepted` / `offer.declined` | `writeCandidateClosing` (offer/respond) | CP-18 |
| `placement.created` / `placement.joined` / `placement.no_show` / `placement.fell_through` | `recordPlacement`, join confirm, fall-through | CP-19, CP-20, CP-22 |
| `candidate.rejection_notice_sent` | rejection template send | CP-21 |
| `notification.for_ops` | escalations meant for an ops owner | CP-25 |

## 6. Shared rules both backends must use the same way
1. **Identities**:
   - people by email;
   - clients by TA `nameKey` + Ops ref;
   - openings by TA `jobs._id` + `opsRequirementRef`;
   - candidates and applications only by TA ids (Ops never creates candidates directly; it files CVs through CP-06).
2. **Stage names**: TA backend names are the contract (`new_cvs ... placed, rejected, unresponsive`); the translator is `convex/ta/stages.ts`.
3. **Time**:
   - all timestamps UTC milliseconds;
   - days are **Asia/Colombo** days (TA uses Colombo days everywhere since 2 Oct);
   - **working days** need one shared Sri Lankan holiday list. TA's `src/lib/calendar.ts` has `HOLIDAYS = []`, which must be filled and served (**new** `GET /integrations/v1/calendar`) so the 7-working-day ownership clock and the 60-working-day replacement clock match on both sides.
4. **Money terms**: the fee rule and guarantee days come from the ESA (CP-03) and are **snapshotted on the placement** (CP-19). Ops invoices from the snapshot, never from today's ESA.
5. **Reasons**: reject, hold, decline and drop-out carry a reason across the line (Director rejection excepted).
6. **Messages**:
   - candidate-facing messages are sent by TA (WhatsApp number, follow-up, rejection notices, reconfirms);
   - client- and interviewer-facing messages are sent by Ops (ESA, client sets, chases, invites, invoices);
   - the Director set stays with TA;
   - each side runs its own fail-closed safety gate (TA: `convex/lib/outreachSafety.ts`, `outboundGuard.ts`, `OUTREACH_LIVE` never in code).
7. **One reader per mailbox**: TA reads shortlists@ for Director replies; client replies move to Ops (CP-10); interviews@ moves to Ops when Ops owns scheduling.

## 7. Security for the connection
- Two **service tokens**, one per direction, scoped (`read`, `events`, `commands`), stored only in each backend's secret manager. Same model as `CAPACITY_PLANNER_READ_TOKEN`: at least 32 random bytes, fail closed (503) when unset, server to server only, no browser CORS.
- **Never** give Ops the Convex admin key or database access (AGENTS.md hard rule 1: no laptop or ad-hoc access to the live backend).
- Commands run as a **service actor** recorded in TA's audit (`activityLog`, `pipelineEvents.actorType`), plus the Ops user's email in the body for "who did it".
- Webhook nudges (optional) are HMAC-signed with a timestamp and nonce (TA already does this for the voice agent: `/api/voice-agent/events`).
- Send only the fields each connection needs (section 3). No CV text in events; fetch files on demand.
- New endpoints are released through the pipeline (`git push origin main:production`), never from a laptop; Ops is tested first against a non-production TA (staging is paused today, so a local or staging copy must exist first).

## 8. First sync (go-live)
1. People (CP-01).
2. Clients (CP-02): Ops imports TA `clients`; nameKey matches become linked.
3. ESA records (CP-03).
4. Open openings and their teams (CP-05).
5. Candidates in client stages: `director_shortlist`, `client_review`, `interview`, `offer`.
6. Placements still inside a guarantee (CP-19/22).
7. Then switch to the event feed from the cursor at sync time.
Data repairs on the TA side are `dryRun` migrations run by the pipeline (AGENTS.md hard rule 5).

## 9. What this implies for the TA System later (list only)
**Endpoints**: the new/adapt endpoints in section 4; the outbox `integrationEvents`.

**New fields**:
- `clients`: `opsClientRef`, `bankingFinanceFlag`, `updatedAt`;
- `esaRecords`: `declined`, fee rule;
- `jobs`: `opsRequirementRef`, `handoverAt`, hold reason;
- `interviews`: `scheduledBy`, Teams link, `opsInterviewRef`;
- `placements`: package, offer letter, DOJ history, `replacementOf`;
- `applications`: `clientOwnedAt`.

**New values**: a source tag for TopJobs and Talent Pulse; a "monitor" mode.

**Behaviour**:
- block openings when the ESA is declined;
- the client round is marked sent by Ops;
- one reader per mailbox;
- guarantee and refund display only;
- fix the `/placements/{id}` redirect.

These are TA customisations to do after this contract is agreed.

## 10. Questions on the connection (to settle before building)
1. Ops is the master of clients and ESA, and TA keeps a mirror written only by Ops. Agreed?
2. Who computes pipeline depth (Ops from the feed, or TA)? Recommendation: Ops.
3. Client replies: move from TA's shortlists@ reader to Ops. Agreed? And interviews@?
4. Interviews: one TA record, client side written by Ops. Agreed?
5. Events: pull feed with an optional webhook nudge. Agreed? How fresh must Ops be (seconds or minutes)?
6. Where does the Ops backend run (same VPS, separate container)? This decides the network path to `api.career141.com` and `ta-system.career141.com`.
7. Shared holiday calendar: who maintains it?
