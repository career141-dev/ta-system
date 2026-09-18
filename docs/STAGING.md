# TA System staging on the live VPS

Server `94.136.189.48`, beside production (`~/career141`), which it never
touches. Code in `/opt/ta-staging-src` (this repository's branch), secrets in
`/opt/ta-staging-src/.env.staging` (chmod 600). The previous attempt is kept in
`/opt/ta-staging.bak-20260916-0920`.

## Addresses

| What | Address | Needs |
|---|---|---|
| TA System app | https://ta-system.career141.com | Clerk sign-in |
| Convex backend (deployment URL) | https://ta-system-api.career141.com | admin key |
| Convex HTTP actions | https://ta-system-actions.career141.com | — |
| Convex dashboard | https://ta-system-dashboard.career141.com | deployment URL above + admin key |
| Qdrant | https://ta-system-qdrant.career141.com/dashboard | `QDRANT_API_KEY` |
| Screening call server | https://ta-system-voice.career141.com/ready | — (call tokens are minted by the app) |

The five names are Cloudflare DNS records (A, DNS only) pointing at the server.
HTTPS comes from the host's Caddy — the same one that serves the live sites —
with one block per name, each proxying to a staging container on 127.0.0.1.
Every change to `/etc/caddy/Caddyfile` was validated before a graceful reload,
and backups sit next to it as `Caddyfile.bak-*`. Nothing staging runs is
published on the server's public IP any more.

Sign-in needs HTTPS: Clerk's session refresh does not work on plain HTTP off
localhost. The Clerk instance is still a development one; a real launch needs a
production Clerk instance for the domain.

## Data

Staging holds the local project database the whole workflow was tested on —
77,216 candidates, 97,308 CV records (files in Cloudflare R2), 8,378 applications,
95 openings, 40 clients, 258 job posts — and all 79,054 Qdrant vectors. Every
table's row count was checked against the export after the import.

## What runs

| Container | Purpose | Listens on |
|---|---|---|
| `ta-staging-app` | the TA System | `127.0.0.1:3110` |
| `ta-staging-livekit` | the screening call's server | `127.0.0.1:7890`, media on `7891/tcp`, `3479/udp`, `5350/tcp`, `50300-50400/udp` |
| `ta-staging-voice-agent` | Aura, which talks to the candidate | `127.0.0.1:18082` (health) |
| `ta-staging-voice-redis` | LiveKit's own store | inside `ta-staging-voice` only |
| `ta-staging-convex` | Convex backend, instance `ta-staging`, 5 GB memory cap | `127.0.0.1:3220`, `:3221` |
| `ta-staging-postgres` | its own Postgres 16, database `ta_staging`, 1.5 GB cap | Docker network only |
| `ta-staging-convex-dashboard` | Convex dashboard | `127.0.0.1:6792` |
| `ta-staging-qdrant` | search vectors | `127.0.0.1:6336` (API key required) |

Compose file: `deploy/staging/docker-compose.yml`, copied to
`/opt/ta-staging-src/docker-compose.yml`. Every command below runs from
`/opt/ta-staging-src` with `--env-file .env.staging`.

## Why it is built this way

- **Its own Postgres.** Self-hosted Convex names its database after
  `INSTANCE_NAME` and ignores a database name in `POSTGRES_URL`. The earlier plan
  used `INSTANCE_NAME=convex-self-hosted` against production's Postgres, which
  resolves to production's own database — a `--replace-all` import would have
  replaced live data. Staging uses `INSTANCE_NAME=ta-staging` on a separate
  Postgres container, so it cannot reach production's database at all.
- **Memory caps on every container.** The earlier SQLite attempt had no cap; each
  import pushed Convex to 8.9 GB and the kernel killed it seven times, with
  production on the same 11 GB host. Now a spike kills only the staging
  container.
- **Chunked import.** The CV table is 1.19 GB of text and embeddings. Imported
  whole, its search indexes are built in memory at once. The snapshot is split:
  every other table plus the first 500 CVs with `--replace-all`, then the rest in
  chunks with `--append`. Convex keeps the memory it used to build indexes, so the
  import restarts the staging Convex container between chunks when it is above
  3 GB (the data is in Postgres; nothing is lost). Tools:
  `deploy/staging/split-export.py` and `deploy/staging/run-import.sh`. (Appending into a table that does not exist yet fails — its internal
  table number clashes — which is why the first CVs go in with the base.)
- **Safety switches before functions.** `C141_DISABLE_CRONS=true` and
  `C141_OUTBOUND_LOCK=true` are set on the backend before any function is
  deployed, so the copy of production data never polls live mailboxes or
  messages real people. The app refuses to start if either is missing
  (`C141_DEPLOYMENT=staging`).
- **Postgres is never published.** The backend and dashboard need the admin key;
  Qdrant needs its API key; the TA functions are internal.

## Common operations

```bash
cd /opt/ta-staging-src
AK=$(grep ^CONVEX_SELF_HOSTED_ADMIN_KEY= .env.staging | cut -d= -f2-)

# deploy functions after a code change
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3220 CONVEX_SELF_HOSTED_ADMIN_KEY="$AK" \
  node node_modules/convex/bin/main.js deploy --yes

# rebuild and restart the app
docker compose --env-file .env.staging up -d --build app

# status and memory
docker compose --env-file .env.staging ps
docker stats --no-stream ta-staging-convex ta-staging-postgres ta-staging-app

# re-import from a snapshot (split, then import; logs in /opt/ta-staging-import)
cd /opt/ta-staging-import && python3 split.py && ./run-import.sh
python3 count.py            # compares every table's row count with the snapshot
```

## The screening call (Voice agent)

Staging runs its own copy of the CV platform's voice stack — LiveKit, its Redis
and the Aura agent — on ports of its own, so production's server keeps 7880,
7881, 3478, 5349 and 50000-50200 and a staging call is never served by
production's agent.

Settings in `.env.staging`:

| Name | Value |
|---|---|
| `LIVEKIT_URL` | `http://livekit:7880` — the app reaches it inside the network |
| `LIVEKIT_BROWSER_URL` | `wss://ta-system-voice.career141.com` — what the browser dials |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | the call server's own key pair |
| `STAGING_VOICE_REDIS_PASSWORD` | LiveKit's Redis |
| `DEEPGRAM_API_KEY` | the agent's speech-to-text and voice |
| `OPENAI_API_KEY` | what the agent thinks with |

One-off setup: add the site in `deploy/staging/caddy-voice.conf` to
`/etc/caddy/Caddyfile` (`caddy validate` then `systemctl reload caddy`), and
point `ta-system-voice.career141.com` at the server in DNS.

```bash
cd /opt/ta-staging-src
# start (or rebuild) the call server and the agent
docker compose --env-file .env.staging up -d --build livekit voice-agent voice-redis

# is the server reachable through Caddy?
curl -s https://ta-system-voice.career141.com/ready

# did the agent register? ("registered worker ... career141-aura")
docker logs ta-staging-voice-agent --tail 20
```

## Updating the code

Merge to `main`: the **Deploy Staging** workflow builds the app, deploys Convex
and replaces the app container, with a health check and automatic rollback
(docs/CI-CD.md). The manual route below is for emergencies only.

From a machine with the repository:

```bash
git archive --format=tar HEAD | ssh -i github_deploy_key root@94.136.189.48 \
  'tar -xf - -C /opt/ta-staging-src'
```

then deploy functions and rebuild the app as above.
