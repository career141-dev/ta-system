# CI/CD

How a change gets from a laptop to staging and to production, without anyone
running deploy commands by hand.

## The flow

```
feature branch ──push──▶ CI (typecheck, Convex typecheck, unit tests, build)
      │
      └─ pull request ──▶ CI ──merge──▶ main ──▶ Deploy Staging (automatic)
                                                   https://ta-system.career141.com
                                          │
                   git push origin main:production
                                          ▼
                                   Deploy Production
                          (enabled switch + commit on main + reviewer approval)
```

| Branch | What happens on push | Environment |
|---|---|---|
| any other branch, and every PR | **CI** only | — |
| `main` | CI, then **Deploy Staging** | `staging` — copy of real data, crons off, outbound locked |
| `production` | checks, CI, approval, then **Deploy Production** | `production` — live |

Unfinished work stays on a feature branch; it reaches staging only when merged
to `main`, and live only when `production` is moved to a commit that is already
on `main` (so it has been on staging first).

## What a deploy does

`.github/workflows/deploy.yml`, identical for both environments:

1. **Build** the app image on GitHub's runner (never on the VPS, which it shares
   with the live system) and push it to GHCR as `<env>-<commit>`.
2. **Deploy** — one job inside the GitHub Environment, so production asks for
   approval once:
   1. *Backup* (production): `pg_dump` of the Convex database on the server into
      `/opt/backups/ta-production/`, newest seven kept; refuses if the disk is
      too full.
   2. *Convex*, through an SSH tunnel to the backend's loopback port (the backend
      is never exposed), with `deploy/scripts/convex-deploy.sh`:
      - sets the non-secret settings pinned in `deploy/convex-env/<env>.env`
        (staging: `C141_DISABLE_CRONS=true`, `C141_OUTBOUND_LOCK=true`) —
        *before* any function is deployed;
      - stops if a setting named in `deploy/convex-env/<env>.required` is missing,
        or one marked `!NAME` is present;
      - `convex deploy` — schema and functions together;
      - runs a one-off function if one was given (a migration);
      - smoke checks: TA functions are not public; staging is in its safe state.
   3. *App*, with `deploy/scripts/remote-app.sh` on the server: pull the image,
      replace **only** the app container, wait for it to be healthy, and roll
      back to the previous image automatically if it is not. Keeps the three
      newest images.
3. The deployed commit is appended to `<deploy_dir>/.deploy/history.log` and
   shown in the run summary.

Order matters: Convex goes first, so the new app never runs against old
functions. Keep each change backwards compatible for one deploy (see schema
changes below), so the old app also works for the minute before it is replaced.

## Everyday use

```bash
git switch -c feature/xyz
# work, commit
git push -u origin feature/xyz        # CI runs
# open a PR to main, merge when green  → staging deploys itself

git push origin main:production       # release what is on staging (production only)
```

### Doing part of it by hand

GitHub → **Actions → Deploy Staging** (or Production) → **Run workflow**:

| Input | Use |
|---|---|
| `components` = `convex` | backend only — Convex functions, schema, settings check. No image build. |
| `components` = `app` | frontend only |
| `ref` (staging) | deploy an older commit — this is the **rollback** |
| `run_function` / `run_args` | run a Convex function after deploying, e.g. a migration `migrations/backfillX:run` |

Production has no `ref` input: roll production back by moving the branch
(`git push --force-with-lease origin <good-commit>:production`, which must still
be on main) or by reverting on main and releasing again.

A direct `npx convex deploy` is still possible in an emergency (docs/STAGING.md,
"Common operations"), but the next pipeline run will redeploy what is in git.

## Convex specifics

**Functions** — deployed on every run; unchanged code is a no-op.

**Schema changes** — `convex deploy` checks the schema against the documents
already stored and refuses the whole deploy if any would not fit; the previous
functions keep running. So change the shape in steps:

1. *Expand*: add the field as `v.optional(...)`, deploy (write both old and new).
2. *Migrate*: write an internal mutation that backfills in batches; run it with
   `run_function` (on staging first).
3. *Contract*: make the field required / drop the old one, deploy.

Every production deploy that touches Convex takes a database backup first.

**Settings (environment variables)** — two kinds, kept apart on purpose:

| Kind | Where it lives | Example |
|---|---|---|
| Secret | set once on the deployment (dashboard, or `npx convex env set` through a tunnel); **never** in git or GitHub | `OPENAI_API_KEY`, `MS_GRAPH_CLIENT_SECRET`, `R2_SECRET_ACCESS_KEY` |
| Safety / behaviour switch (non-secret) | `deploy/convex-env/<env>.env`, set by the pipeline | `C141_DISABLE_CRONS=true` on staging |

When code starts needing a new secret: set it on staging and production first,
then add its name to `deploy/convex-env/<env>.required` in the same PR. A deploy
that forgets fails at the check, before anything is changed.

**App settings** stay in the server's env file (`/opt/ta-staging-src/.env.staging`),
which the pipeline checks exists and never overwrites. The only build-time value
is Clerk's publishable key (a GitHub secret, below).

**Infrastructure** (Convex backend image, Postgres, Qdrant, the dashboard) is not
restarted by the pipeline. `deploy/staging/docker-compose.yml` is copied to the
server on each staging deploy, but only the `app` service is recreated;
changes to the other services are applied deliberately on the server.

## One-time GitHub setup

Settings → **Secrets and variables → Actions**:

| Type | Name | Value |
|---|---|---|
| Secret | `VPS_HOST` | `94.136.189.48` (probably already set) |
| Secret | `VPS_USERNAME` | `root` (probably already set) |
| Secret | `VPS_SSH_KEY` | private key whose public half is in the server's `authorized_keys` as `github-actions-deploy` (probably already set) |
| Secret | `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | staging Clerk publishable key (`pk_test_…`) |
| Secret | `PRODUCTION_CLERK_PUBLISHABLE_KEY` | production Clerk key (`pk_live_…`), when production exists |
| Variable | `VPS_KNOWN_HOSTS` | `94.136.189.48 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA0wRgI/0D7mHoHKPno9KNnglqUkMLHGjol5+fewyB+X` |
| Variable | `PRODUCTION_ENABLED` | leave unset until production is provisioned and approved |

Settings → **Environments**:

- **staging** — secret `CONVEX_SELF_HOSTED_ADMIN_KEY` = staging's admin key
  (the `CONVEX_SELF_HOSTED_ADMIN_KEY` line in `/opt/ta-staging-src/.env.staging`).
  Deployment branches: `main`.
- **production** — secret `CONVEX_SELF_HOSTED_ADMIN_KEY` = production's
  (rotated) admin key. **Required reviewers**: the people who approve releases.
  Deployment branches: `production` only.

Settings → **Branches** → protect `main` (require a PR and the CI check
`Typecheck, test, build`) and `production` (restrict who can push).

## Before production can be switched on

The production workflow is written and stays off (`PRODUCTION_ENABLED`) until
these are decided — each changes the live system and needs approval:

1. **Where production runs.** `docs/HOSTING.md` puts the app beside the live
   Convex backend in `~/career141`. Choose that or a separate project like
   staging; then set the `PRODUCTION_*` variables the workflow reads
   (`PRODUCTION_DEPLOY_DIR`, `PRODUCTION_ENV_FILE`, `PRODUCTION_COMPOSE_SOURCE`,
   `PRODUCTION_APP_SERVICE`, `PRODUCTION_APP_CONTAINER`, `PRODUCTION_HEALTH_URL`,
   `PRODUCTION_CONVEX_PORT`, `PRODUCTION_POSTGRES_CONTAINER`,
   `PRODUCTION_POSTGRES_DB`, `PRODUCTION_POSTGRES_USER`). The app's compose
   service must read its image from `TA_APP_IMAGE`, as staging's does.
2. **One owner for the live Convex functions.** A Convex deployment runs one
   set of functions, and `convex deploy` replaces all of them. The live backend
   is currently deployed from the CV-Processing repository. If this repository
   deploys to it too, each would delete the other's functions. This repository's
   `convex/` already carries the CV system's functions; before production is
   enabled, confirm it is a complete superset of what is live, and stop
   deploying to that backend from the other repository.
3. **Credentials rotated** (docs/DEPLOYMENT-ACTIONS-2026-09-15.md) and a
   production Clerk instance for the domain.

Then set `PRODUCTION_ENABLED=true`, and release with
`git push origin main:production`.

## Files

| File | Role |
|---|---|
| `.github/workflows/ci.yml` | checks; runs alone on branches and PRs, and first inside every deploy |
| `.github/workflows/deploy-staging.yml` | `main` → staging |
| `.github/workflows/deploy-production.yml` | `production` → live, gated |
| `.github/workflows/deploy.yml` | the shared deploy procedure |
| `deploy/scripts/convex-deploy.sh` | Convex settings, schema, functions, smoke checks (runs on the runner) |
| `deploy/scripts/remote-app.sh` | app replace with health check and rollback (runs on the server) |
| `deploy/scripts/remote-backup.sh` | database backup before a production Convex deploy (runs on the server) |
| `deploy/convex-env/*.env`, `*.required` | pinned and required Convex settings per environment |
