# Team workflow — how the TA System goes from a laptop to live

Two developers, one live system (https://ta-system.career141.com, since
21 September 2026). This is the agreed way of working. The short version for
AI coding tools is in [`AGENTS.md`](../AGENTS.md).

| Who | Role |
|---|---|
| **Sanjeev** (`sanjeev200009`) | Owner. Reviews and merges into `main`. Approves every release to live. |
| **Binath** (`HDBinath`) | Developer. Works on branches, opens pull requests, reviews Sanjeev's too. |

## Branches

| Branch | Meaning | Who writes to it |
|---|---|---|
| `main` | Reviewed code, always releasable | Only by merging a reviewed pull request |
| `production` | Exactly what is live | Only by `git push origin main:production` (a release) |
| `<name>/<topic>` | One piece of work, a day or two | Its author |

The long-lived `staging` branch is retired once its last commit (5ba3d06) is
merged. Everything new goes through short branches and pull requests.

## Every change takes the same road

1. **Branch** — from the latest `main`, one topic per branch.
2. **Pull request** into `main` — CI runs the tests by itself.
3. **Review** — the *other* person reads every file and runs it if it touches
   candidates, messages or the database.
4. **Merge** — Sanjeev merges. `main` must always be releasable.
5. **Staging** — a copy of live that never messages anyone (being rebuilt; until
   then, test locally).
6. **Release** — `git push origin main:production`, Sanjeev approves in GitHub
   Actions, the pipeline backs up the database, deploys, and rolls back by
   itself if the new version is not healthy.

## Plan 1 — on your laptops

Each laptop runs the whole system against its **own local database**. Nothing
you do locally can reach live.

### One-time setup

```bash
git clone https://github.com/career141-dev/ta-system.git
cd ta-system
npm ci
cp .env.local.example .env.local        # model key only; never a live address
```

Create `deploy/local/.env.backend.local` (git-ignored) with your own random
values for `LOCAL_POSTGRES_PASSWORD`, `LOCAL_INSTANCE_SECRET`,
`LOCAL_QDRANT_API_KEY` and `LOCAL_SESSION_SECRET`, then:

```bash
# the local backend uses ports 3210/3211/6333/6791 — stop any other Convex
# (e.g. the old CV-Processing project's local containers) first
docker compose -f deploy/local/docker-compose.yml --env-file deploy/local/.env.backend.local up -d
docker exec ta-local-convex ./generate_admin_key.sh   # put it in .env.backend.local as LOCAL_ADMIN_KEY
npx convex deploy --url http://127.0.0.1:3210 --admin-key "<LOCAL_ADMIN_KEY>"   # local only
sh deploy/local/start-app.sh            # http://localhost:3100, local dev sign-in
```

`deploy/local/start-app.sh` forces every address to `127.0.0.1`, so a live URL
left in `.env.local` is never used. `deploy/local/start-ui.sh` runs the UI with
no backend at all. Test data: a copy of production with personal details
removed, shared by Sanjeev as a file — never over chat.

### Every piece of work

```bash
git switch main
git pull
git switch -c binath/short-topic-name     # or sanjeev/…

# …work, try it on localhost…

npm test
npx tsc --noEmit -p .
npx tsc --noEmit -p convex

git add -A
git commit -m "fix(reports): the Show me button says it is working"
git push -u origin binath/short-topic-name
# GitHub → "Compare & pull request" → base: main
```

When `main` has moved on, bring it into your branch before asking for review
(`git pull origin main`) and resolve conflicts there — never on `main`.

### Reviewing each other

- Pull request → **Files changed**: read every file.
- Run it: `git fetch && git switch <branch>`, then `npm test` and the two type checks.
- Anything that changes stored data needs a migration function with a dry run.
- Anything that sends to candidates must respect `OUTREACH_LIVE` and the
  outbound guards (`convex/lib/outreachSafety.ts`, `convex/lib/outboundGuard.ts`).
- Approve; Sanjeev merges.

## Plan 2 — on the server

One VPS (94.136.189.48). Code reaches it **only** through the release pipeline.
Details and addresses: [`deploy/production/README.md`](../deploy/production/README.md).

| Piece | Runs as | Changed by |
|---|---|---|
| Live app | `ta-prod-app`, `/opt/ta-prod` — ta-system.career141.com | A release |
| Live backend | `career141-backend-1` — ta-system-api.career141.com | The same release, after a database backup |
| Database | `career141-postgres-1` (`convex_self_hosted`) | Never by hand — data fixes ship as functions run by the pipeline |
| Search | `career141-qdrant-1` (password protected) | Filled automatically as CVs arrive |
| Voice | `ta-staging-livekit`, `ta-staging-voice-agent` | A release |
| Staging | to be rebuilt on its own ports and database | Auto-deploy on merge to `main` once it exists |

### Releasing (Sanjeev)

```bash
git switch main && git pull
git push origin main:production
```

Then GitHub → Actions → **Deploy Production** → **Approve**, and click through
the pages that changed on the live site.

### Urgent fix

```bash
git switch -c hotfix/short-name origin/production
# smallest possible fix + a test → pull request into main → merge → release
```

## Rules that protect the live system

- **Never** run `npx convex deploy`, `convex run` or `convex import` from a
  laptop against `api.career141.com` / `ta-system-api.career141.com`. That is
  how the live backend was overwritten on 21 September 2026.
- **Never** push straight to `main` or `production` (turn on branch protection
  so it is impossible).
- **Never** put keys, passwords or `.env` files in chat, WhatsApp or git.
- **Never** deploy from the old `CV-Processing-Recruitment-Pipeline-System`
  repository — its deploy would remove every `ta/*` backend function.
- **Never** switch on real candidate messages (`OUTREACH_LIVE`) except on live,
  and only when Sanjeev decides.
- **Always**: a pull request the other person has read; tests and both type
  checks green; data changes as a migration with a dry run first.

## One-time setup still to do

1. Disable the deploy workflow in the old CV-Processing repo (Sanjeev).
2. Merge Binath's `staging` (5ba3d06) after the score-display decision; retire the branch.
3. Branch protection on `main` and `production`: pull request, 1 approval, CI passing (Sanjeev).
4. Production release secrets and the `production` environment with Sanjeev as reviewer (list in `deploy/production/README.md`).
5. Rebuild staging on its own ports with a nightly copy of live; turn its auto-deploy back on.
6. Nightly database backups on the server.
7. Safe local test data for Binath; both laptops set up as above.
