---
name: merge-teammate
description: Review and merge a teammate's branch or pull request into main for the TA System — fetch, merge onto the latest main in a separate worktree, read every changed file, type-check, run all tests, report findings, and merge only after the owner decides on anything that changes what users see or what reaches candidates. Use when asked to "get my friend's changes", "merge Binath's branch", "review the staging branch", "merge the PR", or similar.
---

# Merge a teammate's work

Sanjeev (owner) and Binath (GitHub `HDBinath`) can both merge into `main`; each
merges the other's reviewed pull request. Nothing here deploys: merging to `main` changes no server. Releasing
is a separate, approved step (`docs/TEAM-WORKFLOW.md`).

## 1. See what is new

```bash
git fetch origin --prune
git log --oneline origin/main..origin/<branch>     # their commits not on main
git log --oneline origin/<branch>..origin/main     # main commits they don't have
git diff --stat origin/main...origin/<branch>      # files they changed
```

`<branch>` is the pull request's branch, or `staging` for the old way of
working. If there is nothing new, say so and stop.

## 2. Merge in a separate worktree

Never merge in the worktree the user is working in — uncommitted work would be
mixed in or block the merge.

```bash
git worktree add -b review/<branch>-<short-sha> <scratch-dir>/merge-review origin/main
cd <scratch-dir>/merge-review
git merge --no-ff --no-edit origin/<branch>
```

Reuse installed packages instead of a fresh `npm ci` (Windows:
`New-Item -ItemType Junction -Path node_modules -Target <main worktree>\node_modules`).

On conflicts: resolve keeping **both** sides' intent; read each side's commit
message first. Never drop a hunk to make it compile.

## 3. Read every file

`git diff origin/main...origin/<branch>` — all of it, not just the stat. For
each file, note what it changes for a **user**, not just in code. Flag:

- **Decisions for the owner** — anything that changes what recruiters see
  (numbers, scores, wording that implies something), who can see what
  (roles, `src/lib/auth.ts`), or what reaches candidates (anything under
  `convex/communications`, `convex/pipeline`, follow-up, outreach, voice).
- **Safety** — outbound sends bypassing `convex/lib/outreachSafety.ts` /
  `outboundGuard.ts`; secrets or live addresses in code; changes to
  `deploy/`, `.github/workflows/`, `convex/crons.ts`, `convex/schema.ts`.
- **Data** — schema changes (all fields optional? `schemaValidation`), anything
  that rewrites stored rows (must be a migration with `dryRun`).
- **Duplication** — something that already exists under another name.

## 4. Prove it

```bash
npx tsc --noEmit -p .
npx tsc --noEmit -p convex
npm test
```

All must pass. A failure the teammate introduced is reported, not quietly
fixed; a pre-existing flake is named as such with evidence (same failure on
`origin/main`).

## 5. Report to the owner, in plain words

- What is new (commits, files) and what each change does for a user.
- Test and type-check results.
- **Decisions needed**, each as a one-line question with a recommendation.
- Anything unsafe, with file and line.

Do not merge into `main` until the owner has answered every decision.

## 6. Merge

After the owner's go-ahead (dropping any part they rejected with a follow-up
commit on the review branch that says why):

```bash
git push origin HEAD:main
```

Then clean up: `git worktree remove <scratch-dir>/merge-review`, and tell the
teammate to start new work from the updated `main` (`git switch main && git
pull && git switch -c <name>/<topic>`). Releasing to live is a separate step
the owner approves: `git push origin main:production`.

## Never

- Never deploy, run Convex commands against live, or touch the VPS as part of a
  merge.
- Never force-push `main` or `production`.
- Never merge a change that sends to real candidates without the owner saying yes.
