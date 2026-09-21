# Production

Since 21 September the TA System **is** production: https://ta-system.career141.com,
on the live Convex backend that the CV platform used (api.career141.com). The old
cvportal web container (`career141-web`) is stopped; its backend, Postgres and
Qdrant keep running and are this system's backend.

| Piece | Where |
|---|---|
| App | container `ta-prod-app`, compose project `ta-prod` in `/opt/ta-prod`, 127.0.0.1:3110 |
| Secrets | `/opt/ta-prod/.env.production` (chmod 600, never in git) |
| Convex backend | `career141-backend-1`, loopback 3210 — https://ta-system-api.career141.com |
| Convex dashboard | https://ta-system-dashboard.career141.com (port 6791) |
| Postgres | `career141-postgres-1`, database `convex_self_hosted` |
| Qdrant | `career141-qdrant-1`, collection `candidate_vectors` — no API key yet |
| Voice | staging's LiveKit + agent, over the `ta-staging-voice` network |

## Releasing

    git push origin main:production

`.github/workflows/deploy-production.yml` then: checks the commit is on main,
runs CI, builds the image, waits for a reviewer, dumps the database, deploys the
Convex functions, and swaps the app container with a health check and automatic
rollback. It needs, once, in GitHub:

- repository secrets `VPS_HOST`, `VPS_USERNAME`, `VPS_SSH_KEY`,
  `PRODUCTION_CLERK_PUBLISHABLE_KEY`, `PRODUCTION_SERVER_ACTIONS_KEY` (the same
  value as `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` in `.env.production`)
- repository variables `PRODUCTION_ENABLED=true`, `VPS_KNOWN_HOSTS`
- an Environment `production` with a required reviewer, restricted to the
  `production` branch, holding the secret `CONVEX_SELF_HOSTED_ADMIN_KEY`

Pushing to `main` deploys nothing: the staging pipeline is paused until a new
staging exists (its old port is now the live app).

**The CV-Processing repository must not deploy any more.** Its own workflow
deploys its `convex/` to the same backend on every push to its main, which would
remove every `ta/*` function this app runs on.

## By hand

    cd /opt/ta-prod && docker compose -p ta-prod --env-file .env.production up -d

`copy-vectors.mjs` copied 38,963 candidate vectors from the old staging Qdrant
into the live one on 21 September (adds missing points only).
