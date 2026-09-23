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
| Web search | container `ta-prod-searxng`, `http://searxng:8080` on `career141_default` — no published port |

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

## Web search (SearXNG)

Suggestions, Benchmark and Research search through our own SearXNG rather than
Serper (23 Sep). It takes no key and costs nothing. No public instance can be
used: every one probed served HTML or 403 rather than the JSON API, which is
off by default and stays off on a public instance by design.

First install, on the server:

    cd /opt/ta-prod
    mkdir -p searxng
    # settings.yml from deploy/production/searxng/ in this repository, then:
    sed -i "s|^  secret_key: .*|  secret_key: \"$(openssl rand -hex 32)\"|" searxng/settings.yml
    # The container reads this as its own unprivileged user, not as root: a
    # root-owned 600 file is a PermissionError and a container that restarts
    # for ever (23 Sep). 644 is right here — the key signs session cookies for
    # an instance nothing outside this stack can reach, and only root logs in.
    chmod 755 searxng && chmod 644 searxng/settings.yml
    TA_APP_IMAGE=$(cat .deploy/app-image) docker compose -p ta-prod --env-file .env.production up -d --no-deps searxng

Then add to `/opt/ta-prod/.env.production` and restart the app:

    SEARXNG_URL=http://searxng:8080

Brought up on 23 September; `docker exec ta-prod-app node -e "fetch('http://searxng:8080/search?q=hayleys+plc&format=json')..."` answered with 43 results.

`settings.yml` is put on the server by hand and is never replaced by a release
— the pipeline copies only `docker-compose.yml`. The service itself belongs in
that compose file, because a deploy overwrites it: a service added only on the
server disappears at the next release.

## By hand

    cd /opt/ta-prod && docker compose -p ta-prod --env-file .env.production up -d

`copy-vectors.mjs` copied 38,963 candidate vectors from the old staging Qdrant
into the live one on 21 September (adds missing points only).
