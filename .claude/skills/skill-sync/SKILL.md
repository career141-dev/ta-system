---
name: skill-sync
description: Keep the TA System feature skills (/follow-up, /scoop, /sets-shortlist, /strategy-planner, /voice-agent, /email-intake, /cv-extraction, /workday, /eod-email, /database-search, /excel-tables, /openings) in step with the code. Use after changing any feature, when a hook says a skill is out of date, before a pull request, or to add a new feature skill.
---

# skill-sync: keep feature skills true

Each feature skill (`.claude/skills/<feature>/SKILL.md`) describes how one feature works **today** so any coding agent can change it without breaking it. They are only useful while they are true. Every feature skill ends with a `skill-meta` block: the source files it describes plus a content hash taken when someone last checked the skill against the code. `staleness.mjs` compares that hash with the files now.

## The rule
**If you change code that a feature skill covers, update that skill in the same change** (same branch, same pull request), then stamp it. A skill that disagrees with the code is a bug.

## Commands (run from the repo root)
```bash
node .claude/skills/skill-sync/staleness.mjs check            # which skills are stale, with a diffstat of what changed
node .claude/skills/skill-sync/staleness.mjs list <path>...   # which skills cover these files
node .claude/skills/skill-sync/staleness.mjs stamp <name>...  # record "checked against the code as it is now"
node .claude/skills/skill-sync/staleness.mjs stamp --all      # only right after a full review
```
`check` exits 1 when anything is stale, so it can gate a pull request.

## Workflow when a skill is stale
1. `check` lists stale skills and the changed files (`git diff --stat` since the last stamp; it includes uncommitted edits).
2. For each stale skill: read the diff (`git diff <verified-commit> -- <files>`), open the skill, and fix every statement the change made false: flows, function names, numbers, tables, guards, UI, roles, the "How to change it safely" checklist. Add a dated line to `## History` with the short hash or PR number and the reason.
3. Check new files: if the feature now uses a file the `sources:` list misses, add it (a glob is fine). Check the other direction too: remove paths that no longer exist.
4. Run `stamp <name>`. Never stamp without reading the diff; a stamp is a claim that the skill is accurate.
5. Commit the skill with the code.

## How agents are reminded
A `PostToolUse` hook runs `staleness.mjs hook` after every file edit. If the edited file is in a skill's `sources:`, the agent is told once per session which skill to update and to stamp it before finishing. The hook is registered in the user's Claude settings (see "Hook setup"); it does nothing in a repo without this folder.

## Adding a new feature skill
1. Create `.claude/skills/<feature>/SKILL.md`. The name is the short feature name a person will type after `/` (`scoop`, not `scoops-upload-flow`).
2. Frontmatter: `name`, and a one-line `description` saying what the feature is, the words people use for it, and "Use when changing, debugging or extending ...".
3. Sections, in this order: Scope and boundaries; How it works now; UI surface; Data; Backend wiring; Access and roles; Invariants and safety; Known quirks, gaps and unverified items; How to change it safely; History. Be concrete: exact file paths and function names, numbers, tables and fields, refusal messages, flags (names only, never values). Mark anything not verified in the code as `(unverified)`. No overview or marketing text.
4. End with the meta block (placeholders are fine; `stamp` fills them):
```
<!-- skill-meta
verified-commit: pending
verified-hash: pending
verified-date: pending
sources:
  convex/ta/example.ts
  src/app/example/**
-->
```
Globs: `*` matches within a folder, `**` across folders. Include implementation, UI, tests and docs for the feature; leave out generated files.
5. Run `stamp <feature>` and add the skill to the list in this file's description and in `AGENTS.md`.

## Hook setup (per person, once)
Add to `~/.claude/settings.json` under `hooks`:
```json
"PostToolUse": [
  { "matcher": "Edit|Write|MultiEdit",
    "hooks": [ { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/.claude/skills/skill-sync/staleness.mjs\" hook" } ] }
]
```
`.claude/settings.json` is git-ignored in this repo (only `.claude/skills/` is tracked), so the hook cannot be shared through git unless the owner adds `!.claude/settings.json` to `.gitignore`. Cursor, Codex and other tools have no hooks: they rely on `AGENTS.md` and on running `check` before a pull request.

## Limits to remember
- The hash proves the sources changed, not what the skill got wrong. Reading the diff is the human/agent part.
- A new source file that matches no `sources:` glob is invisible until someone adds it; `check` cannot know a skill should cover it.
- Skills describe the code; they are not a spec. Where they disagree, the code wins and the skill is fixed.
