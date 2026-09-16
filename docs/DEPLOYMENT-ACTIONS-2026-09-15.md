# TA System — deployment action list

Branch `claude/ta-cv-pipeline-integration-c3e27a` (integration of `sanjeev`, `binath` and this work).
Prepared 15 September 2026 after the full test run described at the end.

Production today: the live CV system (careerportal.com / careeronflow.com) runs on the self-hosted
Convex backend at `api.career141.com`. Nothing below has been done to production yet.

---

## A. Before anything touches production — security (you)

1. **Rotate every credential pasted in chat or committed anywhere.**
   - Microsoft Graph client secret for app `c909752a-…` (pasted on 15 September). Create a new
     secret in Azure, delete the old one.
   - The Convex `INSTANCE_SECRET` / admin key for `api.career141.com` (exposed in the public
     `CV-Processing-Recruitment-Pipeline-System` history). Rotating the instance secret invalidates
     every leaked admin key.
   - Any OpenAI / OpenRouter / NVIDIA / R2 / Meta / ElevenLabs keys that were pasted or committed.
2. Make the `CV-Processing-Recruitment-Pipeline-System` repository private (or purge the file from
   history) and delete `src/app/api/debug-env/route.ts` there if it still exists.
3. **Close the open functions in the live system (existing issue, found 15 September).** Public
   Convex functions answer anyone who knows `api.career141.com`, with no key and no sign-in.
   Verified on the local copy without a key:
   - `storage/r2:generateDownloadUrl` returns a signed link to **any** file key in the production
     CV bucket.
   - `matching/search:searchCandidates` returns candidate ids for any keyword.
   The live frontend calls these from the browser with a Clerk session, so the fix belongs in the
   CV-Processing repo and must be tested there: require a signed-in user in the public function,
   and give server callers (the TA app) an internal twin sharing the same implementation. The TA
   app's own functions (`convex/ta/*`) are already internal on this branch, and a unit test
   (`tests/internal.test.ts`) fails if one is ever made public.
4. Restrict the local development backend: Docker currently publishes Convex on `0.0.0.0:3210`, and
   something outside this work deployed older functions to it twice. Bind it to `127.0.0.1` and find
   who else deploys to it.

## B. Decisions to make before go-live (you)

| # | Decision | Why it matters |
|---|---|---|
| B1 | Where the TA app runs | The TA server only talks to a Convex backend on the same machine (`src/lib/convexServer.ts` refuses any non-loopback URL, deliberately). Run the TA app on the VPS that hosts `api.career141.com` and point it at `http://127.0.0.1:3210`, or decide to relax that rule with an explicit production allow-list (a code change). |
| B2 | Turn on `C141_TA_INTAKE` or not | Off: an emailed CV goes straight to the candidate table and the job (today's behaviour, tested in Phase 3). On: it lands in the TA intake queue for a person to admit. Changes where every arriving CV goes — decide before switching. |
| B3 | The ~967 applications whose job no longer exists | Found during Phase 1. Left untouched. Delete, archive or reattach. |
| B4 | Contracts and invoices | Deferred ("not now"). Placements record the default fee (12%) and guarantee (90 days) when no ESA is on file; there is no screen yet to record an ESA or invoice status. |
| B5 | The nightly job | `/api/cron/nightly` (database matching for every open job) needs a scheduler calling it with `Authorization: Bearer $C141_CRON_SECRET`. Choose system cron on the VPS or a Convex cron. |

## C. Backend (Convex, `api.career141.com`) — deploy steps

1. **Back up first.** `npx convex export` of the production deployment (or a volume snapshot).
2. Deploy the functions from this branch to production. Schema changes are additive only
   (`schemaValidation: false`): new tables `taAlerts`, `taOutreach`, `taScreeningCalls`,
   `taSettings`; new optional fields on `jobs`, `applications`, `candidates`, `referees`,
   `pipelineEvents`. No existing field changes meaning. Note `scripts/convex-local-only.mjs`
   refuses non-local targets on purpose — deploy from the VPS or with the production deploy key in
   the CV-Processing repo's usual way.
3. **All `convex/ta/*` functions are internal** (only the TA server, holding the admin key, can call
   them). Confirm after deploy: a request without a key to `ta/candidates:stats` must return
   "Could not find public function". The test-only functions (`ta/inboxTest`, `ta/ingestionTest`,
   `ta/testSweep`) are internal too and refuse to run unless `C141_OUTBOUND_LOCK=true`, so they do
   nothing on production.
4. Environment on the production deployment:
   - `C141_OUTBOUND_LOCK` **unset** (or `false`) — on production messages must reach people.
   - `C141_DISABLE_CRONS` **unset** — production crons stay on.
   - `OUTREACH_LIVE=true` — the fail-closed outreach gate (`convex/lib/outreachSafety.ts`,
     from main). Without it every WhatsApp and email is redirected to
     `OUTREACH_TEST_EMAIL` / `OUTREACH_TEST_PHONE`, or blocked when those are unset.
     Test and staging deployments leave it unset.
   - `MS_GRAPH_TENANT_ID`, `MS_GRAPH_CLIENT_ID`, `MS_GRAPH_CLIENT_SECRET` — the **new** secret.
   - `C141_TA_INTAKE` — per decision B2.
   - R2, OpenRouter/NVIDIA/OpenAI, Qdrant, Meta, ElevenLabs as today (unchanged).
5. Behaviour that differs from a test deployment and is correct only with the lock off:
   CV files and CV text go to the R2 bucket; ingested mail is marked read.
6. Re-run the search-vector repair on production once (`scripts/qdrant-payload-repair.ts`, pointed
   at the production Qdrant) so city filters find people — the local run repaired 77,216 points.

## D. TA web app — deploy steps

1. `npm ci && npm run build` (clean on this branch).
2. Environment for `next start` on the server:
   - `C141_DEPLOYMENT=production` (the only way past the safe-backend check).
   - `CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210` and `CONVEX_SELF_HOSTED_ADMIN_KEY` (rotated).
   - `C141_SESSION_SECRET` — a new long random value.
   - `C141_CRON_SECRET` — a new random value (decision B5).
   - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY` from the production Clerk instance
     (the dev sign-in list is off in production builds; confirmed the dev cookie is refused by
     `next start`). Every TA's email in Clerk must match their row in the `users` table.
   - **Do not set** `C141_DEV_SIGNIN`, `C141_STORE`, `C141_TEST_RUN`, or any `C141_LIVE_*` variable.
3. Put it behind HTTPS (reverse proxy), process manager (pm2/systemd), and log rotation.
4. The browser extension: set its server URL to the production address and issue the extension
   token from the app (stored in the `taSettings` table).

## E. After deploy — smoke checks (15 minutes)

1. Sign in as a TA lead, a TA and a director; open Openings, Database, Reports, Alerts.
2. Create a `C141 TEST` client and opening, approve its JD, add a job post, then delete them.
3. Search the database by name from the top bar and by plain language on Database.
4. Open a candidate profile; open the CV file.
5. Watch the Convex logs for 30 minutes for uncaught errors and "Could not find public function".
6. Confirm one real emailed CV arrives, is extracted and scored (production path).

## F. Test evidence (this branch, local copy of production data)

Run everything with `npm run e2e` (local Convex with crons off and the outbound lock on, dev server on
:3177 with `C141_DEV_SIGNIN=on`). Each script cleans up and ends with `ta/testSweep:sweep`, so a run
leaves no test rows; each writes a log to `docs/quality/test-log/`.

| Phase | Covers | Result |
|---|---|---|
| 1 Data foundation | saves reach the database in one transaction; conflicts refused; no JSON at runtime | 24 / 24 |
| 2 Clients and openings | roles, clients, opening from brief, JD approval/amendment, team, posts, status, delete | 31 / 31 |
| 3 CV ingestion | real inbox read-only; upload, extraction, profile, vector, scoring; known CV links; invoice rejected | 25 / 25 |
| 4 Profiles and search | profile, CV file, database-wide search, AI/keyword search, reverse matching both ways, prepared CV | 15 / 15 |
| 5–6 Pipeline to placement | sets, stage rules, follow-up, screening call, director review, interviews, offers, placement | 27 / 27 |
| 7 Desk-wide | suggestions, extension, reports/CSV, dashboards, assistant questions and confirmed actions | 24 / 24 |
| Unit tests | 24 suites, including `internal.test.ts` (no public TA functions) | 24 / 24 |

Also checked: `npm run build` clean; `next start` redirects signed-out pages, refuses the CSV export
without a session, and rejects the development sign-in cookie; table counts after the final run
match the Phase 1 baseline apart from usage logs and the extension-token setting.
