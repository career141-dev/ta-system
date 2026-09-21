@AGENTS.md

## Claude Code specifics

- To review and merge a teammate's branch, use the `merge-teammate` skill
  (`.claude/skills/merge-teammate/SKILL.md`).
- Do the merge in a separate git worktree so uncommitted work in the current
  one is never mixed in.
- Anything that would touch the live server or live backend needs the owner's
  explicit go-ahead in the conversation, every time.
