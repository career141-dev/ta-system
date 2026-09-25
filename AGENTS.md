# AGENTS.md — read this before changing anything

For every developer and every AI coding tool (Claude Code, Cursor, Copilot,
Codex…) working in this repository. The full playbook is
[`docs/TEAM-WORKFLOW.md`](docs/TEAM-WORKFLOW.md).

## What this is

Career141 TA System — Next.js 16 app (`src/`) on a self-hosted Convex backend
(`convex/`). **It is production**: https://ta-system.career141.com runs on the
live database behind api.career141.com (78,000+ real candidates). Server layout:
[`deploy/production/README.md`](deploy/production/README.md).

## Hard rules

1. **Never touch the live backend from a laptop.** No `npx convex deploy`,
   `convex run`, `convex import` or `convex env set` against
   `api.career141.com`, `ta-system-api.career141.com` or the VPS
   (94.136.189.48). Live changes go only through the release pipeline
   (`.github/workflows/deploy-production.yml`).
2. **Work on a branch, merge through a pull request.** Never commit or push
   straight to `main` or `production`. Branch names: `<person>/<topic>`.
3. **No secrets anywhere tracked or shared.** No keys in code, commits, docs,
   chat or example files. `.env*` files stay local.
4. **Real candidates are real.** Outbound WhatsApp/email/calls must go through
   `convex/lib/outreachSafety.ts` and `convex/lib/outboundGuard.ts`. Never set
   `OUTREACH_LIVE` in code or config.
5. **Data changes are migrations** — an internal function with a `dryRun`
   argument, run by the pipeline (`run_function`), never an ad-hoc script
   against live.
6. **The old repository is not a deploy source.** Nothing from
   `CV-Processing-Recruitment-Pipeline-System` is deployed any more; its
   `convex/` would replace this one's.

## Before you push

```bash
npm test                    # all suites must pass
npx tsc --noEmit -p .       # app types
npx tsc --noEmit -p convex  # backend types
```

Run locally with `deploy/local/start-app.sh` (local backend on 127.0.0.1 only,
dev sign-in). Never point a local run at a live address.

## Merging a teammate's work

Follow [`.claude/skills/merge-teammate/SKILL.md`](.claude/skills/merge-teammate/SKILL.md):
fetch, merge onto the latest `main` in a separate branch, read every file,
type-check, test, report, and only then merge — flagging anything that changes
what users see or what is sent to candidates for the owner to decide.

## Code style

Match the surrounding code: its comment density (comments explain *why*, often
with the date and the incident), naming, and idioms. User-facing copy is plain,
specific and active ("Saved", "Could not send — the number is missing").

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
