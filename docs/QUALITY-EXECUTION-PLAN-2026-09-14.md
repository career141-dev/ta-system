# Career141: execution plan for quality and cost

14 September 2026

**Objective:** establish the lowest-cost complete system that meets the desk's quality requirements. Improve and test every workflow, not only the 120-person screening sample. Monthly budgets are ceilings, not spending targets. Do not claim the targets are achievable until tested.

This plan builds on the [workflow analysis](/Users/uzmaan/career141-ta-platform/docs/QUALITY-STRATEGY-2026-09-13.md). Preparing this plan and reading existing results incurred no new paid screening or sourcing work. No application code was changed in this planning step.

## Operating constraints

| Area | Monthly ceiling | Included |
|---|---:|---|
| LinkedIn suggestions | $100 | Discovery/search, identity verification, enrichment, assessment and ranking. |
| Database and research | $50 combined | CV extraction, scoring, database matching/search, company research and benchmarking. |
| Calls and follow-ups | $50 combined | Speech recognition, voice generation, model processing, messaging and retries. Already-paid carrier charges excluded. |

Plan for 60 jobs and about 6,000 incoming CVs each month. Search-pool sizes, candidate/job assessments, calls and messages are additional workload variables to measure; do not assume every incoming CV needs to be scored against every opening.

Testing is a separate ledger. The recorded cumulative test spend checked for this plan is $1.991371. Every paid test requires approval for that exact run. A monthly ceiling, earlier test approval or approval of this plan does not authorize another paid run. Check the required no-data-retention configuration before any hosted processing of candidate information. No batch or cache discount enters the budget unless its availability and compatibility have been verified.

## Existing evidence

The first laptop screening run completed 120 candidates. It put forward 10 as Shortlist/Maybe, of whom the reviewer also marked 4 Shortlist/Maybe. It retained 4 of the reviewer's 18 non-rejects. Overall yes/no agreement was 100/120, largely driven by rejections; this does not meet the product goal.

At this status check, the revised run had written 65/120 results. It is incomplete and the processed subset differs from the full set, so no full-run comparison is claimed. The 120 cases have been used to adjust the prompt and are development examples, not an untouched acceptance set. Let the existing free run finish; do not start repeated full laptop runs before analyzing the completed result.

The earlier review also reproduced failures in experience requirements, negated responsibilities, qualification status, score consistency, follow-up state and reviewer numbering despite all 17 existing suites passing. These are the first regression scenarios to address.

## Stage 1 — establish one baseline and repair known defects

**First implementation work; no paid provider calls needed.** Recheck current code before editing because another task may already have changed it. Coordinate changes and preserve unrelated work.

1. Turn the reproduced defects into meaningful regression cases and fix the underlying behavior. Preserve separate experience requirements, qualification status and explicit contradictions. Do not try to solve every interpretation problem with more keywords.
2. Make the candidate list, automatic matching and assistant agree on the assessment and its version. Explain stale or unavailable assessments.
3. Resolve reviewer replies against the exact original roster; fix decline handling and the email-only repeat-contact branch. Preserve approved workflow behavior without sending real messages.
4. Create a baseline register covering each workflow: test cases, current result, failure reason, input evidence, time, provider cost and next change.
5. Finish and summarize the existing laptop run, reporting Shortlist, Maybe and Reject separately, precision among proposals and the reviewer's acceptable candidates missed.

**Exit:** reproduced problems are fixed and verified; current behavior is recorded; no paid comparison is used to mask a deterministic defect. No live autonomous contact is enabled.

## Stage 2 — establish the evidence and acceptance set

**Local preparation is free; source extraction or hosted processing is separately quoted if needed.**

Use a small representative development set for each workflow rather than putting all work through the same screening test. For extraction, include scans, complex layouts, overlapping employment, negation and partial qualifications. For matching, include ordinary, senior and specialist openings, known good candidates, previous false positives and candidates missed by current retrieval.

For the independent acceptance test, start with six fresh openings spanning those role categories. Have TAs assess results without model scores or information about which system selected them. Include candidates outside the final top list to measure omissions. Obtain relevant source evidence for this set before considering a complete database CV-copy operation.

Define what counts as suitable before running the test. Keep definite suitability and “Maybe / needs verification” separate. Do not improve the headline precision by relabelling uncertain candidates as strong matches. Have a second reviewer examine a subset and resolve disagreements with the lead.

**Exit:** frozen role requirements, meaningful reviewer agreement, adequate evidence and untouched final-test cases. Six jobs are a starting test, not proof of performance across every role family.

## Stage 3 — optimize each component, in dependency order

| Component | First experiment | What decides whether it stays |
|---|---|---|
| CV extraction | Compare extracted facts with source documents; reuse facts by document version. | Accurate responsibilities, dates and credential status, with unknowns visible. |
| Job interpretation | Produce one approved structured role definition shared by search, assessment, research and screening. | Essentials, preferences and responsibility scope survive without invention or collapse. |
| Database retrieval | Compare existing retrieval with ranked title/skill search plus semantic retrieval on a fixed source snapshot. | More known good candidates in the pool without an impractical review workload. |
| Candidate assessment | Test the cheapest plausible model on fixed evidence; compare alternatives only if it fails. | Correct judgement and evidence, useful ranking, low missed-candidate rate and acceptable latency. |
| LinkedIn suggestions | Test discovery, deduplication, identity, evidence and ranking separately, then together. | 10–15 suitable profiles per job at 90–95% relevance, with honest handling of scarce supply. |
| Research and benchmarking | Check each company/person/role claim against its cited source and date. | Supported, current, relevant facts; absent evidence remains unknown. |
| Calls and follow-ups | Start with synthetic transcripts and simulated events; test audio separately before any real contact. | Correct data and zero critical contact/decision failures in the agreed test scenarios. |
| Intake, merges, replies and pipeline | Replay duplicates, late replies, corrections, simultaneous actions and failures using test data. | Correct person, job and stage; no lost changes or duplicated actions. |
| Assistant and reporting | Ask unseen operational questions and compare answers with authoritative records. | Correct counts, filters, dates, scope and current assessments. |

A model is not automatically needed for a task that code can perform reliably. A stronger model is not automatically needed for every person. If two-stage assessment is used, define the routing rule in advance: uncertainty, contradictory evidence or a policy-relevant gap. Review clear negative decisions for false exclusions. Test the complete routing system, including all cases the cheap model rejects, against held-out labels.

Testing only known mistakes on a stronger model is diagnostic; it does not demonstrate a deployable routing policy. Do not assume model confidence is calibrated until tested.

**Exit:** a measured component choice for each task, with an explanation of why a cheaper approach was insufficient wherever a more expensive one is selected.

## Every paid experiment gets a run card

Prepare this before requesting approval:

- The question the experiment answers and the workflow it affects.
- Exact model/provider route, settings and verified retention compatibility.
- Number of jobs, candidates, documents, audio minutes or search requests.
- Estimated input/output tokens, search usage, audio usage and retries.
- Expected charge and a hard maximum covering the specified experiment.
- What is sent externally and what remains local.
- Pass/fail criteria, baseline, and whether the examples are development or held-out.
- Stop conditions; no automatic model escalation, expanded sample or new paid retry batch.

Track reserved and actual cost. Stop at the approved ceiling rather than completing at an unknown extra charge. A failed test should produce an explanation and the smallest useful next experiment, not automatic authorization to try more models.

Do not adopt the older model-price tables as current quotes. Verify availability and pricing when preparing each run card, use measured token sizes for that workflow, and distinguish standard, cached and batch rates.

## Stage 4 — validate the whole recruitment process

Use the chosen components together on the untouched cases:

**Approved brief → discovery or CV intake → identity/merge → evidence extraction → matching/assessment → TA review → simulated follow-up → reviewer reply → interview/offer/placement → reporting.**

Exercise ordinary success and failure paths: revised JD, two TAs claiming the same person, a new CV changing a qualification, a candidate withdrawing, an email reply referring to an older shortlist, a callback tomorrow, provider timeout, repeated webhook and application restart.

External calls or messages to real people are not part of an ordinary model-test approval. Validate with simulated events and explicitly approved test recipients before candidate contact.

| Area | Release measure |
|---|---|
| LinkedIn | User requirement: 10–15 profiles per job with 90–95% TA-confirmed suitability. Unknowns and duplicates cannot be hidden. |
| Database results | Proposed minimum from the review: 85% relevance in the top 20; confirm as a release rule before the paid acceptance test. |
| Missed candidates | Proposed minimum: retain 90% of labelled good candidates in the assessment pool; separately measure losses during assessment. This is not whole-market recall. |
| Ranking | Agreed 0.90 target, with metric and candidate population fixed, plus useful top-result precision. |
| Evidence | No unsupported material recommendation or wrong-person evidence in the release sample; report unknowns and reviewer disagreement. |
| Contact and decisions | Zero critical scenario failures: wrong recipient, ignored withdrawal, duplicate contact or decision applied to the wrong candidate. Passing a finite test does not guarantee zero production errors. |
| Practical benefit | Reduced TA time per accepted candidate, without worsening omissions or brand-risk events. |

Always report actual denominators, list sizes and uncertainty. At 10 profiles, one wrong result is already 90%; at 15 profiles, one wrong result is about 93%. A single good list cannot establish reliable performance. Inspect role-family performance so ordinary roles do not hide poor senior-role outcomes.

## Stage 5 — verify full monthly cost, then pilot

Model the measured usage at 60 jobs and 6,000 incoming CVs. Include changed-CV extraction, candidate/job assessments, source enrichment, searches, embeddings, retries and delivery processing in their correct budget buckets. Reuse work rather than rerunning it because another screen needs the same fact.

Calls require measured candidate contact volume, average audio duration, retry rate and messages per conversation before the $50 ceiling can be declared feasible. Carrier costs remain excluded as instructed. For all buckets, keep a margin for normal usage variation rather than projecting operation exactly at the limit.

If quality passes but cost exceeds a ceiling, test caching, reduced repeated work, narrower evidence selection or fewer unnecessary escalations without changing the quality gates. Do not quietly downgrade quality or assume unverified discounts. If it still cannot fit, report the measured gap and the specific constraint requiring a decision.

Run in shadow mode first: the system proposes while established human processes remain authoritative. After independent quality, operational and cost checks pass, conduct a small supervised pilot. Expand only when fresh results sustain the targets. Keep senior or specialist families outside general rollout if they remain below requirements.

## Immediate next actions

1. Let the existing laptop run complete and assess the full results once.
2. Recheck and fix the known deterministic defects using local tests; establish the workflow baseline register.
3. Prepare the fresh-job review set and evidence requirements with the TA lead.
4. Prepare the first small paid run card only for the specific capability the free checks cannot settle. Obtain approval for that run before executing it.

Do not wait for one screening model to pass before examining matching, sourcing or contact correctness. Those have independent failure modes and can be prepared and tested locally while model evaluation continues.
