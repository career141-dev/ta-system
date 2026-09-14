# Baseline register

14 September 2026 · Stage 1 of [the execution plan](../QUALITY-EXECUTION-PLAN-2026-09-14.md)

One row per workflow: what has been tested, what it scored, why it fails, what the evidence is, and the next change. **Judged by** matters: results judged only by Claude are not independent evidence. Test spend so far (all workflows): **$1.99** from `.data-live-test/spend.json`.

Test data: read-only copy of the live system on 13 September — 12 live jobs, 7,251 candidates with CV text, kept in `.data-live-test` (to be deleted after testing).

## Summary

| Workflow | Tested? | Current result | Judged by | Meets goal? |
|---|---|---|---|---|
| Database matching: assessment | Yes, 3 jobs × 40 people | Platform's top band: 10 of 53 acceptable (19%); ranking AUC 0.51 / 0.62 / 0.68 | **Recruiter (Uzmaan)** | No |
| Database matching: retrieval | No | Unknown: all 120 reviewed people came from the search's own pool | — | Unknown |
| Applicant scoring | Partly | Live system's own shortlist 58% precision, misses ~40% of good applicants; ours 53% on the same people (without their CV text) | Claude | No |
| AI screen (laptop, Qwen3.8-27B) | Yes, same 120 | Put forward 10, of which 4 acceptable; kept 4 of the recruiter's 18 | **Recruiter** | No |
| LinkedIn suggestions | Yes, 12 jobs | 66% suitable (priority tier 87%, screen tier 46%) | Claude | No |
| Benchmarking / research | No | Skipped: jobs don't name the client | — | Unknown |
| JD drafts | Yes, 12 jobs | Opus preferred (~$0.025/JD) over Sonnet ($0.010) | Claude | Not independently checked |
| Ask assistant | Yes, 20 questions | ~95% correct after moving counts to code | Claude (own questions) | Not independently checked |
| Calls and follow-ups | No real test | Logic tests only (decline, email-only branch) | Tests | Unknown |
| Reviewer replies, intake, merges | Logic tests only | Numbering against original roster fixed and tested | Tests | Unknown under real traffic |

## Database matching: assessment

- **Cases:** Procurement Manager (job 4), Head of Engineering (job 9), Group Chief Supply Chain (job 12); 40 people each: 24 the platform added, the rest just below the bar, title matches not added, or ruled out. Order shuffled, scores hidden. File: `.data-live-test/review/compare-u_lead.json`.
- **Recruiter decisions:** job 4: 3 shortlist / 8 maybe / 29 reject; job 9: 1 / 5 / 34; job 12: 0 / 1 / 39.

| Job | Platform top band (≥60) | Of those acceptable | Recruiter yeses missed | AUC vs recruiter |
|---|---|---|---|---|
| Procurement Manager | 26 | 8 | 3 of 11 | 0.51 |
| Head of Engineering | 9 | 1 | 5 of 6 | 0.62 |
| Group Chief Supply Chain | 18 | 1 | 0 of 1 | 0.68 |

- **Failure reason:** word-overlap scoring. It does not check what the current employer does (industry), the level of the current designation, the type of work (plant vs software/facilities engineering), or whether the person would move. Examples the platform added for Head of Engineering: a bread distribution agency manager, a Head of Software Engineering, an IT operations head.
- **Recruiter's actual logic:** gates in order: industry → current level → type of work → essentials → will they move. Saved as a rule.
- **Claude's own labels vs recruiter:** agree 83 of 120 (69%); Claude far more lenient (37 yeses vs 18).
- **Time / cost:** rules scoring is instant and free.
- **Caveat:** these 120 were used to write the AI screen's rules, so they are development examples, not an acceptance set.
- **Next change:** evidence-based gate assessment (Stage 3, candidate assessment), tested on unseen jobs.

## Database matching: retrieval

- **Cases:** none yet that can show people the search never pulled up.
- **Next change:** for 1–2 jobs, screen a wide slice of the database locally (free) and count good people outside the retrieved pool.

## AI screen (laptop model)

- **Run 1 (gates, strict):** agree yes/no 100 of 120 (mostly rejects); put forward 10 → 4 acceptable; kept 4 of 18 recruiter yeses and 1 of 4 shortlists.
- **Failure reasons:** rules stricter than the recruiter (years shortfall and related work treated as rejects); misreads (LAUGFS called "not a manufacturer"; Rockland Distilleries role read as facilities; Haleon EHS lead shortlisted).
- **Run 2 (loosened rules):** in progress; partial results not compared.
- **Time / cost:** ~40 s per person on the laptop; free. Too slow for production volume.
- **Next change:** evidence quotes per gate and a strict "clear fail" definition, then a priced comparison of hosted models (needs approval).

## LinkedIn suggestions

- **Cases:** 12 live jobs, one sourcing round each.
- **Result:** 66% suitable overall; priority tier 87%, screen tier 46%. Judged by Claude only.
- **Failure reasons (known):** thin search snippets; namesakes not verified; screen tier lets through weak matches.
- **Next change:** separate tests for discovery, deduplication, identity, evidence and ranking; recruiter-reviewed on 3 jobs; must reach 10–15 profiles per job at 90–95%.

## Benchmarking / research

- **Not tested:** live jobs don't name the client. Needs jobs with a known client and a claim-by-claim source check.

## JD drafts

- **Cases:** 12 jobs, Opus vs Sonnet, judged by Claude. Needs a recruiter's marks on a few drafts.

## Ask assistant

- **Cases:** 20 questions written by Claude; ~95% after deterministic counting. Needs 20 unseen questions from a recruiter, checked against the records.

## Calls and follow-ups

- **Tested:** logic only (`tests/followup.test.ts`, `tests/defects.test.ts`, `tests/voice.test.ts`): withdrawal before completeness, no repeat email straight after the first, voice webhook validation and signatures.
- **Not tested:** real conversations, transcript interpretation, audio, callback times, duplicates under real events. Also not measured: call volume and duration, which decide whether the $50 budget is feasible.
- **Next change:** synthetic transcripts and simulated events first; audio separately; no real contact without explicit approval.

## Stage 1 fixes verified (14 September)

| Defect from the 13 September review | Status | Test |
|---|---|---|
| Separate experience requirements collapsed (15 overall + 8 management) | Fixed | `defects.test.ts` "separate experience requirements keep their scope" |
| Negated responsibility counted as evidence | Fixed | "a denial is not evidence" |
| Studying a qualification counted as holding it | Fixed | "studying is not qualified" |
| Similarity changed the displayed score | Fixed | "one assessment, whatever the screen" |
| Four copies of the scoring setup (list, results, matching, assistant) | Fixed: one shared `lib/assessment.ts` with a version; matching runs record it; unavailable scores explain why | "one assessment code path, with its version" |
| Guessed nationality affected ranking | Fixed | "a guessed nationality does not rank" |
| Decline read as complete; repeat email with no phone | Fixed | "follow-up: withdrawal before completeness, and no repeat email" |
| Reply numbers shifted after a decision | Fixed | "a reply's numbers mean the email's numbers" |

All 18 test suites pass.
