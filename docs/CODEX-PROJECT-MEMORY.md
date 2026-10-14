# Codex Project Memory

Read this as a working map for future Codex turns in this repository. It is not
a replacement for `AGENTS.md`; production safety rules there still win.

## Source Of Truth

- This is the production Career141 TA System: Next.js 16 in `src/`, self-hosted
  Convex in `convex/`, live at `ta-system.career141.com`.
- The stale `README.md` still describes an older synthetic/standalone phase.
  Treat `AGENTS.md`, `docs/TEAM-WORKFLOW.md`, deployment docs, and guarded code
  paths as current truth.
- Current workflow: branch, PR, review, tests, typechecks, release through
  GitHub Actions. Never push directly to `main` or `production`.

## Hard Safety Memory

- Never run laptop `npx convex deploy`, `convex run`, `convex import`, or
  `convex env set` against live URLs, `api.career141.com`,
  `ta-system-api.career141.com`, or VPS `94.136.189.48`.
- Local Convex CLI usage must go through `scripts/convex-local-only.mjs` or the
  npm scripts that wrap it.
- No secrets in code, docs, commits, or chat.
- Real candidate outreach must pass through `convex/lib/outreachSafety.ts`,
  `convex/lib/outboundGuard.ts`, and do-not-contact checks.
- Never set `OUTREACH_LIVE` in code or local config.
- Production data changes are migrations/internal functions with `dryRun`, run
  through the release pipeline, not ad-hoc scripts.
- Do not deploy from the old `CV-Processing-Recruitment-Pipeline-System` repo.

## Data Architecture

- UI code mostly talks to synchronous `repo` from `src/data/store.ts`.
- Production storage is Convex. `src/data/prime.ts` loads request-scoped
  working sets from Convex into the legacy synchronous store before pages or
  actions read `repo`.
- Pages/actions must call `primeStore(...)` with the right scope before reading
  candidates, openings, or all applications.
- Convex bridge and mapping live in:
  - `src/lib/convexServer.ts`
  - `src/lib/convexHost.ts`
  - `src/lib/safety.ts`
  - `src/data/convex/backend.ts`
  - `src/data/convex/map.ts`
- Writes through the legacy store are diffed and committed transactionally via
  `convex/ta/commit.ts`.
- Backend authorization for TA functions lives in `convex/ta/guard.ts`.

## Roles And Auth

- Session joins Clerk verified email to active desk users in
  `src/lib/session.ts`.
- UI/server permissions live in `src/lib/auth.ts`; row visibility lives in
  `src/lib/visibility.ts`.
- Main roles: `admin`, `director`, `ta_lead`, `ta`, `ta_support`, `ops`,
  `client`, `viewer`.
- Desk-wide roles include admin, director, TA lead, and ops. User management is
  admin-only.
- Backend role mapping is in `src/data/convex/map.ts`; for example backend
  `ta_manager` maps to app `ta_lead`, and `recruiter` maps to `ta`.

## TA Flow

- Entry dashboard: `/` in `src/app/page.tsx`.
- Normal TA sees assigned openings, urgent/routine alerts, follow-up counts,
  CVs today, opening aging vs priority target, and upcoming interviews.
- Openings list: `src/app/openings/page.tsx`.
- Opening overview: `src/app/openings/[id]/page.tsx`.
- Stage pages: `src/app/openings/[id]/pipeline/[stage]/page.tsx`.
- Candidate drawer: `src/app/openings/[id]/candidate/[appId]/page.tsx`.
- Pipeline stages and app/candidate types live in `src/data/types.ts`.
- Shortlist collision and set numbering live in `src/data/store.ts` and
  production equivalents in `convex/ta/applications.ts`.
- Follow-up UI and logic:
  - `src/components/LiveFollowUp.tsx`
  - `src/lib/followup.ts`
  - `convex/ta/followUp.ts`
- Calls:
  - `src/app/voiceActions.ts`
  - `convex/ta/voice.ts`
  - `convex/aiCalls/*`
- Interviews are driven by server actions in `src/app/actions.ts`.
- EOD/review rounds:
  - `src/app/openings/[id]/eod/page.tsx`
  - `src/lib/eod.ts`
- Prepared CVs:
  - `src/components/PreparedCvEditor.tsx`
  - `src/app/api/prepared-cv/[appId]/route.ts`
  - `src/lib/preparedCv.ts`
  - `src/lib/preparedCvFile.ts`
- Alerts are computed, not stored, in `src/lib/sla.ts`.

## TA Lead Flow

- TA lead and admin route from `/` to `src/components/dash/LeadDashboard.tsx`.
- Lead dashboard covers team load, assigned openings, stale roles, unassigned
  roles, pending JD approvals, LinkedIn coverage, CVs today, sets, and alerts.
- Create/opening flow:
  - `src/app/openings/new/page.tsx`
  - `src/components/CaptureForm.tsx`
  - `createOpeningStep1` / `saveNewOpening` in `src/app/actions.ts`
- JD page and approval:
  - `src/app/openings/[id]/jd/page.tsx`
  - `approveJd` in `src/app/actions.ts`
- Team assignment: `setOpeningTeam` in `src/app/actions.ts`; at least one
  recruiter seat is required.
- Job posts/routing: `addJobPost` in `src/app/actions.ts`.
- Intake:
  - `src/app/intake/page.tsx`
  - `src/app/intake/[id]/page.tsx`
- Reports:
  - `src/app/reports/page.tsx`
  - guarded by `report.read`; clients are denied.
- Strategy:
  - `src/app/strategy/page.tsx`
  - `src/app/strategy/[openingId]/page.tsx`
  - `src/app/strategy/manage/page.tsx`
  - `src/app/openings/[id]/strategies/page.tsx`
- Feedback desk:
  - `src/app/feedback/page.tsx`
  - `src/components/FeedbackDesk.tsx`
  - lead review/admin actions in `src/app/actions.ts`
- Do not confuse `/review` with live shortlist workflow. `/review` is QA /
  recruiter evaluation and does not move candidates or contact anyone.

## Admin And Production Control Flow

- User admin:
  - `src/app/people/page.tsx`
  - `src/app/people/PeopleAdmin.tsx`
  - `convex/ta/users.ts`
- Convex host and backend safety:
  - `src/lib/convexHost.ts`
  - `src/lib/safety.ts`
  - non-production must prove crons are disabled and outbound is locked.
- Production release:
  - `.github/workflows/deploy-production.yml`
  - `deploy/scripts/convex-deploy.sh`
  - `deploy/scripts/remote-app.sh`
  - `deploy/scripts/remote-backup.sh`
  - `deploy/production/README.md`
- Cron registry: `convex/crons.ts`.
- Webhooks and external bridges: `convex/http.ts`.
  - Meta/WhatsApp verification and POST handling.
  - Graph webhook requires `MS_GRAPH_CLIENT_STATE`.
  - ElevenLabs requires webhook HMAC secret.
  - Voice-agent bridge requires shared secret, timestamp, nonce, HMAC, and
    replay protection.
- Local/dev start:
  - `deploy/local/start-app.sh`
  - `deploy/local/start-ui.sh`
  - `deploy/local/docker-compose.yml`

## Verification Memory

Before push or PR:

```bash
npm test
npx tsc --noEmit -p .
npx tsc --noEmit -p convex
```

Use focused tests while working, but full test and both typechecks are the
project standard before shipping.
