# Database Search: Relevant Experience First

## Scope

General natural-language Database search only. Boolean search, deliberate By
meaning search, opening auto-matches and applicant scoring keep their existing
behavior. No migration, embedding change or reindex is required.

## Before and After

| Scenario | Before | After |
| --- | --- | --- |
| Personal Assistant to CFO | Title substring matching could treat CFO as the occupation; absent inferred skills depressed assistant scores. | Assistant occupation is separate from the CFO reporting context. Supported assistant careers precede CFO-only profiles. |
| Assistant with sparse skills | Could miss the 10-person, score-band-only AI review. | Half of a 20-person review is reserved for supported careers, prioritizing low skill scores. |
| Keyword-only assistant and 200 vector hits | Vector-first truncation could discard the keyword-only candidate. | Separate allocations retain up to 200 keyword and 200 vector candidates, deduplicated. No vector score is not a zero score. |
| Former assistant | General search did not enable past-title scoring. | Previous relevant roles count, with dates used for recency. |
| Results page | Final numeric fit sorting could undo an engine ordering. | Engine order is retained before pagination and profile navigation; up to 400 results are available. |
| Explicit filters return nobody | The engine could fall back to the entire retrieved pool. | No silent relaxation. An empty eligible set remains empty. |

The previously observed live example was not a CFO-only result set: the engine
understood the assistant query, but an exact assistant dropped below broader
finance profiles after final scoring. Synthetic regressions reproduce the
underlying title, skill and retrieval defects without copying candidate data.

## Ranking Contract

1. Interpret target occupation, equivalent titles, reporting context and
   explicitly requested versus inferred skills.
2. Retrieve company and role-focused keywords before broad keyword queries
   within the keyword allocation; keep the vector allocation separately.
3. Enforce existing employer, location, experience and edited skill/industry
   constraints. The results page still enforces desk constraints.
4. Classify current relevant role, previous relevant role, or broader match.
   Summary-only evidence must explicitly describe work in the occupation.
5. Put supported careers before broader profiles. Within that grouping, use
   scores, current/past title evidence and recency, with stable ID tie-breaking.
6. Review up to 20 profiles with a 10/10 protected-career/uncertain allocation;
   refill unused places. AI cannot override the occupation grouping. Missing or
   unusable model results leave deterministic scores intact.

Quick and full results share this ordering rule. AI can refine order *within*
the supported or broader groups; their exact scores need not be identical.
Broader results remain in the same list, including zero-scoring broader hits.
Missing skill evidence is described as Verify, not as proof of a missing skill.

Model review adds only current title, three recent dated roles, a bounded
summary, twelve relevant skill tags and role/employer evidence. Summaries are
scrubbed for email/phone patterns. No contact fields or raw CV text are added.
Candidate names are omitted from the new review payload.

## Verification

- `tests/searchRoleEvidence.test.ts`: assistant/reporting-line distinctions,
  CFO, Assistant Accountant, Assistant Finance Manager, equivalent titles,
  previous roles, sparse skills, explicit requirements, no occupation, pool
  quotas, protected AI review, bounded payloads and opt-in legacy scoring.
- `tests/searchEngineRoleRanking.test.ts`: real orchestration with mocked IO;
  400 synthetic records exercise quick/full retrieval, role ordering, strict
  filters, employer constraints, caching and model failure. No network calls.
- The integration fixture checks engine pagination and the results page's
  engine-order guard. Existing search/chat and URL behavior tests remain part
  of the full repository suite.
- Run `npm test`, `npx tsc --noEmit -p .`, `npx tsc --noEmit -p convex`, and
  `npm run build` before merging. Build uses CI's public placeholder Clerk key,
  not production configuration.

## Release Acceptance

After owner approval, merge the PR and release only through the existing
production pipeline. Then recheck `personal assistant cfo` in the live app,
including page two and opening/closing a profile. Judge actual career evidence,
not whether any named person occupies a specific rank. This live acceptance
check is intentionally pending release; automated tests do not establish live
search quality. Rollback is a revert PR through the same release pipeline.
