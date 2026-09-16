# TA System staging on the live VPS

Server `94.136.189.48`, beside production (`~/career141`), which it never
touches. Code in `/opt/ta-staging-src` (this repository's branch), secrets in
`/opt/ta-staging-src/.env.staging` (chmod 600). The previous attempt is kept in
`/opt/ta-staging.bak-20260916-0920`.

## Addresses

- **App:** https://94-136-189-48.sslip.io — use this one. Clerk's session
  refresh needs HTTPS; on plain `http://94.136.189.48:3110` sign-in loops and
  pages lose the session.
- **Convex dashboard:** http://94.136.189.48:6792 — deployment URL
  `http://94.136.189.48:3220`, admin key from `.env.staging`.
- **Qdrant:** http://94.136.189.48:6336/dashboard — API key `QDRANT_API_KEY`
  from `.env.staging`.

HTTPS comes from the host's Caddy (the same one that serves the live sites), with
one block added on 16 September; a backup of the previous file sits next to it as
`/etc/caddy/Caddyfile.bak-*`:

```
94-136-189-48.sslip.io {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3110
}
```

## Data

Staging holds the local project database the whole workflow was tested on —
77,216 candidates, 97,308 CV records (files in Cloudflare R2), 8,378 applications,
95 openings, 40 clients, 258 job posts — and all 79,054 Qdrant vectors. Every
table's row count was checked against the export after the import.

## What runs

| Container | Purpose | Listens on |
|---|---|---|
| `ta-staging-app` | the TA System | `0.0.0.0:3110`, and https://94-136-189-48.sslip.io via Caddy |
| `ta-staging-convex` | Convex backend, instance `ta-staging`, 5 GB memory cap | `0.0.0.0:3220`, `:3221` (admin key required) |
| `ta-staging-postgres` | its own Postgres 16, database `ta_staging`, 1.5 GB cap | Docker network only |
| `ta-staging-convex-dashboard` | Convex dashboard | `0.0.0.0:6792` |
| `ta-staging-qdrant` | search vectors | `0.0.0.0:6336` (API key required) |

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

## Reaching the internal services

```bash
ssh -i github_deploy_key -N \
  -L 3220:127.0.0.1:3220 -L 6792:127.0.0.1:6792 -L 6336:127.0.0.1:6336 \
  root@94.136.189.48
```

Then open `http://localhost:6792` (dashboard; deployment URL
`http://127.0.0.1:3220`, admin key from `.env.staging`) and
`http://localhost:6336/dashboard` (Qdrant).

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

## Updating the code

From a machine with the repository:

```bash
git archive --format=tar HEAD | ssh -i github_deploy_key root@94.136.189.48 \
  'tar -xf - -C /opt/ta-staging-src'
```

then deploy functions and rebuild the app as above.
