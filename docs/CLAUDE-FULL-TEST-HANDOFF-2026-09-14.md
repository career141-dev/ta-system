# Career141 — complete implementation and testing handoff

Prepared 14 September 2026. This document is self-contained and supersedes the earlier high-level execution plan for testing detail. It is a proposed protocol, not a claim that the system has passed or that paid execution has been approved.

## 1. Objective and non-negotiable instructions

Improve the entire recruitment system and establish the least expensive configuration that meets the quality requirements. The priorities are: wrong candidates and incorrect scores; missed good candidates; brand-damaging calls/follow-ups; duplicates and wasted TA time. Do not optimize for low model spend while increasing recruiter rework or hiding missed candidates.

Monthly operating ceilings, at 60 jobs and approximately 6,000 incoming applicant CVs:

| Bucket | Ceiling | Coverage |
|---|---:|---|
| LinkedIn suggestions | $100/month | Discovery searches, identity verification, enrichment, assessment and ranking. |
| Database and research | $50/month combined | CV extraction, embeddings/search, database matching, scoring, company research and benchmarking. |
| Calls/follow-ups | $50/month combined | Speech recognition, voice generation, model use, messaging and retries. Exclude carrier charges already paid by the user. |

Ceilings are not spending targets. Do not move costs between buckets without documenting the allocation and getting agreement. Shared work must be allocated once, not omitted or double-counted. Report any additional necessary hosting/storage expense separately; it must not disappear from the feasibility assessment.

Testing is separate. The last checked test ledger recorded $1.991371. Recheck it. A **$10 total first-round testing cap, including prior spend, was proposed but has not been approved**. It is not a verified price for this full protocol. Do not assume any earlier $5 cap or monthly ceiling authorizes new spending.

**Every paid run requires explicit approval for its exact run card.** No approval is inferred from this plan, earlier tests, monthly budgets or a statement to prioritize quality. No automatic expansion, paid fallback or additional paid retry batch. Standard inference, embeddings, search, enrichment, audio and messaging can all incur charges.

Verify required zero-data-retention compatibility for the exact provider route before sending candidate information to a hosted service. Do not assume ordinary, cached and batch requests have the same retention behavior. Do not use unverified discounts in quotations.

Do not contact real candidates, send client emails, deploy or enable live intake/voice as part of model testing. Use isolated test data, synthetic recipients and mocked delivery. Real test-recipient contact requires separate explicit authorization.

## 2. Current system and starting evidence

Workspace: `/Users/uzmaan/career141-ta-platform`. Code is primarily TypeScript/Next.js, with a local JSON repository, a read-only source-system mirror and local model scripts. Recheck current files and applicable AGENTS.md before changing anything. Another task may have edited the implementation since this review. Do not reset or overwrite unrelated changes. The previous review found no Git repository at the workspace root; verify rather than assuming commits/worktrees are available.

The existing 17 test suites and type checking passed during the review, after the localhost mock-server integration test was rerun with the required environment permission. Passing those suites did not establish recruitment quality. README descriptions are stale and some apparently complete workflows remain simulated or disconnected.

Existing screening development set:

- `/.data-live-test/review/screenset.json` relative to the workspace: 120 candidate/job pairs, 40 for each of Procurement Manager (job 4), Head of Engineering (job 9), and GROUP CHIEF - SUPPLY CHAIN (job 12).
- Actual path: `/Users/uzmaan/career141-ta-platform/.data-live-test/review/screenset.json`.
- Reference reviewer in that file: `u_lead`; verify this is the user's intended decision set, not a substitute model judge.
- Results: `screen-qwen27b.jsonl` and `screen-qwen27b-v2.jsonl` in the same directory.
- First run: 10 Shortlist/Maybe proposals, 4 accepted as Shortlist/Maybe by the reviewer; 4 of 18 reviewer non-rejects retained. Binary agreement was 100/120, mostly rejections.
- Revised run was incomplete at the last planning check. Inspect result counts, unique IDs, schema validity and process status; do not assume the historical progress/ETA is current. Do not restart an existing run or overwrite its output.

The 120 cases were used to alter the prompt and are **development-only**. All previously used jobs, candidates, labels and evaluation outputs must be entered in an exposure register. Existing historical jobs include pricing, QA, BA, procurement, fabric, merchandise, accountancy, EHS, engineering, documentation, marketing and group supply chain. Picking another old job from this list does not make it untouched.

Seven synthetic diagnostics reproduced these issues:

1. “15 years overall, 8 in management” collapses to 8 minimum years.
2. “I have never managed procurement budgets” satisfies the written procurement-budget requirement.
3. “Currently studying CIMA” avoids the penalty for missing a required completed credential.
4. Similarity-inclusive matching and rules-only display yield different scores for the same candidate/job.
5. Completed salary/notice information takes precedence over a latest not-interested call, producing follow-up state `complete`.
6. An email-only candidate already emailed is immediately due for another email.
7. After original candidate 1 is decided, a partial reply saying “Shortlist 2” can select original candidate 3 because the remaining roster is renumbered.

Reproduce against current code first; some may already be fixed. The evidence file is `/Users/uzmaan/career141-ta-platform/docs/QUALITY-ANALYSIS-EVIDENCE-2026-09-13.json`. Use it as historical evidence, not a replacement for fresh checks.

Important implementation locations:

| Area | Files relative to workspace |
|---|---|
| Job interpretation and score | `src/lib/scoring.ts`, `src/components/CandidateList.tsx`, `src/lib/deskAssistant.ts` |
| Retrieval and manual search | `src/lib/dbMatch.ts`, `src/lib/embed.ts`, `src/lib/query.ts`, `src/lib/match.ts` |
| LinkedIn/research | `src/lib/sourcing.ts`, `src/lib/serper.ts`, `src/lib/headhunt.ts`, `src/app/actions.ts` |
| Intake/identity | `src/lib/intake.ts`, `src/lib/ingest.ts`, `src/lib/dedup.ts`, `src/lib/extension.ts` |
| Contact and decisions | `src/lib/followup.ts`, `src/lib/voice.ts`, `src/lib/reviewReply.ts`, `src/lib/routing.ts`, `src/lib/pipeline.ts` |
| Data and background behavior | `src/data/store.ts`, `src/lib/live/`, `src/app/api/cron/nightly/route.ts`, `src/lib/session.ts`, `src/lib/auth.ts` |
| Reporting/closing | `src/lib/reporting.ts`, `src/lib/reportAsk.ts`, `src/lib/eod.ts`, `src/lib/sla.ts`, `src/lib/closing.ts`, `src/lib/pdf.ts` |

## 3. Meaning of suitable and release status

### Resource inventory verified locally on 14 September 2026

The following counts were read directly from the local files after the initial handoff was prepared. They describe local resources, not the complete live source system:

| Resource | Verified local inventory | How to use it |
|---|---|---|
| `.data-live-test/db.json` candidate mirror | 7,251 candidate records; 7,242 have copied CV text; 2 marked R2-only; 7 marked no text | Primary existing real-data test resource. Obtain missing evidence selectively; do not assume this mirror covers the full source database. |
| Mirror structured fields | 6,717 have current titles; 6,633 have work history; 6,752 have skills | Measure missing fields and source text independently; do not treat missing structure as lack of experience. |
| Test openings and clients | 12 approved/open openings and 12 clients; `live-jobs.json` also contains 12 jobs | Previously exposed evaluation pool. Confirm exposure before assigning any job to acceptance. |
| Existing matching/sourcing outputs | 315 application records, 161 suggestions, 12 match runs | Useful baselines; application records are not necessarily a complete applicant census or human labels. |
| Screening development labels | 120 candidate/job pairs across 3 of the test jobs | Reuse as development data as specified above. |
| `.data/db.json` | 755 candidate records, 6 openings and 4 clients, with operational fixtures | Separate development/demo store; do not substitute its counts for the live candidate pool or assume every record is production evidence. |
| Local model directory | `tools/embed/models/Qwen3.8-27B-4bit` present | Folder presence does not prove an active run or completed inference. Check process and result status separately. |

The implementation contains read-only source-system connectors and a sync path, but this count check did not query the full live candidate/job inventory. Before creating new data, inventory and reuse existing eligible records, source documents, labels and saved outputs. Then establish the full live candidate count, full live job pool, historical/active job availability, CV text versus stored-file coverage, snapshot completeness and which jobs have never been used for tuning. Check configured model/search/audio resources without printing secrets. Do not claim access, available credit, retention compatibility or a working integration from a code path alone. The six fresh acceptance jobs must come from genuinely unexposed available jobs; the 12-job local copy is not evidence that only 12 jobs exist in the business.

Freeze definitions with the TA lead before the paid acceptance test:

- **Shortlist / suitable:** sufficient evidence supports the essential job requirements; the TA would put the person forward for the next substantive recruitment step.
- **Maybe:** plausible, but evidence, experience scope, qualifications or another material requirement needs checking. Keep visible for review; do not count as a confirmed suitable candidate merely to improve headline precision.
- **Reject:** supported evidence shows an essential mismatch. Missing information alone is not proof of a mismatch.
- **Unjudgeable:** insufficient source material to assign a trustworthy judgement. Count and report these; do not discard them from the published result list denominator.

Record the original user labels unchanged. For the existing 120, report strict Shortlist and inclusive Shortlist+Maybe metrics side by side. Do not rewrite the historic 18 non-rejects as 18 definite suitable candidates.

The user requires 10–15 LinkedIn profiles per job at 90–95% suitability. Proposed operational interpretation: **90% minimum, 95% desired**, plus at least 10 unique profiles, aiming for 15. Obtain agreement on that interpretation before final acceptance; if 95% is the required floor, change the manifest before running, not after seeing results.

Other thresholds below are engineering recommendations except the earlier 0.90 ranking target. Mark proposed versus user-required in the acceptance manifest. A zero-result job cannot pass precision. A supply-limited job is “coverage not met / needs sourcing review,” not a successful exception silently removed from averages.

## 4. Job selection, ownership and independent judgement

Use **3 development jobs** (the existing 120) and **6 fresh acceptance openings**:

- 2 ordinary roles with clear functional/qualification criteria.
- 2 senior/leadership roles requiring assessment of responsibility and scale.
- 2 specialist roles requiring domain or process expertise.

Select actual approved openings with adequate source evidence. Prefer six different clients. None may have been used to tune or choose the final model, prompt, thresholds or retrieval configuration. The exact IDs are intentionally not fabricated: Claude must inventory exposure and fill the manifest before execution. If six untouched jobs are unavailable, request them or run a clearly labelled development trial. Do not claim an independent acceptance test.

Split candidate identities as well as jobs where feasible. Flag repeated people/near-duplicate CVs between development and acceptance; remove them from the primary held-out result or report the contamination. Freeze a dated source snapshot, eligibility rules and source-coverage counts. Candidate age/gender or inferred nationality are not job-fit evidence; do not infer them from names, schooling or employment. Explicit work eligibility, where relevant, must be assessed from verified information.

Assign one primary TA and one secondary TA/lead. A local evaluator creates blind row IDs and keeps system identity, retrieval route and scores out of reviewer sheets. Reviewers receive the approved role criteria and relevant full evidence, with source page/section references. Do not restrict senior-role judgement to the first few hundred characters.

For the fixed database acceptance pool, second-review **16 of 80 rows per job** (96 total), selected reproducibly before labels are read. For the LinkedIn published list, second-review all proposed profiles (up to 90). Double-review all material disagreements affecting acceptance. Report agreement before adjudication. Do not use an AI judge as the final ground truth.

Human time is separate from API charges. Initially time 10 candidate judgements and 10 profile/source checks. Use observed median minutes × required judgements plus adjudication to estimate TA effort; do not promise the full review takes 20 minutes.

## 5. Exact test inventory

Counts are planned scenarios or maximum samples, not statements about data already available. Cases may reuse approved source documents across workflows; do not pay for the same unchanged extraction twice.

| Test ID | Dataset/sample | Split or repetition |
|---|---|---|
| J01 Job interpretation | 12 brief/JD packages: 6 development, 6 acceptance | The acceptance six are the fresh jobs. Development packages may be previously exposed. |
| X01 CV extraction | 48 CV documents | 24 development, 24 acceptance; category details below. |
| S01 Screening warm-up | 24 of the existing 120 pairs, 8/job | Cheapest plausible hosted baseline only after approved quote, or local inference. |
| S02 Screening comparison | All 120 existing pairs | Warm-up results reused if exact inputs/settings match; no more than 2 challenger configurations without a revised approved plan. |
| D01 Database assessment | 80 fixed candidate/job pairs × 6 fresh jobs = 480 | Independent labels and scoring; no tuning on these labels. |
| D02 Database end-to-end | Full eligible frozen database × 6 jobs; assess top 60 retrieved/job | 360 assessment opportunities; reuse matching candidate/job/version results from D01. Up to 120 additional final-list labels if winners fall outside D01. |
| L01 LinkedIn discovery | 3 existing development jobs plus 6 fresh acceptance jobs; aim for 15 published profiles/job | Up to 45 development and 90 acceptance profiles; at least 10/job required. Initial search limits below. |
| R01 Company research | 12 company briefs: 6 development, 6 acceptance | Exactly 10 defined factual fields/company; absence is allowed but reported. |
| B01 Benchmarking | 3 development plus 6 acceptance jobs × up to 5 equivalent-role people | Up to 15 development and 30 acceptance people; no padding. |
| F01 Follow-up logic | 60 synthetic scenarios | 10 behavior groups × 6 cases. |
| V01 Speech recognition | 24 clips, each at most 60 seconds | Up to 24 input-audio minutes; split 12 development/12 acceptance. |
| V02 Voice interaction | 12 scripted test conversations, at most 2 minutes each | Up to 24 recognition minutes and 12 generated-speech minutes; split 6 development/6 acceptance. |
| O01 Intake/routing | 24 synthetic scenarios | 6 groups × 4 cases. |
| O02 Identity/merge | 24 synthetic scenarios | 6 groups × 4 cases. |
| O03 Reviewer replies | 24 synthetic scenarios | 6 groups × 4 cases. |
| O04 Permissions/concurrency | 24 synthetic scenarios | 6 groups × 4 cases. |
| O05 Interviews/offers/placements | 24 synthetic scenarios | 6 groups × 4 cases. |
| O06 Durable jobs/retries | 18 synthetic scenarios | 6 failure groups × 3 cases. |
| A01 Assistant | 60 questions | 30 development/30 unseen; 5 categories × 12. |
| A02 Reports | 24 report specifications with known expected results | 6 categories × 4. |
| U01 Documents/adverts | 12 prepared-CV cases and 12 advert/snippet cases | 6 layout/content categories × 2 per output type. |
| E01 Complete journeys | 18 isolated end-to-end journeys | 3/job for all 6 acceptance openings: normal, incomplete/decline, conflicting/replayed events. |

These are a complete first evaluation protocol, not enough evidence to guarantee 90–95% long-term accuracy. Quote the paid portions separately. The full protocol may exceed the proposed $10 first-round allowance; determine that before approval rather than silently reducing coverage.

## 6. Procedures and thresholds for candidate quality

### J01 — understand the job

For each package, a TA records the expected function, essential responsibilities, overall experience, relevant-function experience, leadership experience, operating scope, credentials/status, location/work eligibility, and essential/preferred/unknown conditions. Preserve AND/OR alternatives, negations and salary currency/basis.

Generate the structured assessment and JD, compare each field against the approved record, and show differences to the reviewer. Test ambiguous and contradictory briefs. **Proposed gate: no material invented, reversed or omitted essential requirement in the six acceptance packages.** Cosmetic prose differences do not count as errors.

### X01 — extract candidate facts

Use 8 documents in each of six primary categories, with 4 development and 4 acceptance per category: straightforward digital CV; multi-column/layout-heavy CV; scanned/image CV; incomplete/ambiguous dates or overlapping jobs; partial/expired/negated qualifications or responsibilities; multilingual/code-switched CV relevant to actual supported languages. A document may have secondary tags but belongs to one primary bucket for counting.

If a category is unavailable, record it as not tested; synthetic adversarial documents can validate logic but cannot replace real-format accuracy evidence. Prepare field-level reference facts from the original documents, including normalized dates, credential status and missing values. Calculate supported-field precision, recoverable-field recall and document-level critical errors. Exclude genuinely absent fields only from recoverable-field recall, while requiring correct unknown handling.

**Proposed gates:** at least 95% supported-field precision and 90% recoverable-field recall overall; no fabricated identity, credential completion or employment history in the acceptance sample. Report by format; an unsupported language/scan workflow remains unavailable or routed to manual handling.

### S01/S02 — choose an assessment method cheaply

Choose 8 development cases/job deterministically: all known Shortlists up to 3, then Maybes up to a total of 5, then rejects to reach 8. If a class is smaller, keep every available case and fill using the remaining classes. Use seed 141 and persist IDs. Do not fabricate positive examples to balance a job.

The warm-up is for response validity, evidence grounding and gross failure detection, not proof of accuracy. Require valid output for every record; failed parses are errors/unknowns, not rejections or silently skipped records. Check quoted evidence exists and supports the claim. If it fails, fix the specific cause before a full rerun.

On S02, compare the current baseline and selected model on all 120 using exactly the same approved input evidence. Store original labels, three-way predictions, per-requirement evidence, unknowns, cost and latency. A paid second model is approved only to answer a named unresolved question; do not blindly run five models.

Develop the escalation policy here. Only supported essential failures qualify for an early reject. Ambiguous or contradictory evidence routes for further assessment. Measure whether actual errors are caught by the policy, not just whether a stronger model can fix a hand-picked list of known errors.

### D01 — fixed database assessment pool

Before final labels are visible to the implementing agent, build 80 unique candidate/job pairs per acceptance job using this order:

1. 20 candidates from the legacy/current baseline's ranked list.
2. 20 additional candidates from a fixed independent title/skill/semantic retrieval combination.
3. Up to 20 additional candidates independently identified by TAs as plausible or good, without showing their labels to the retrieval system.
4. 10 additional candidates around the baseline's actual current cutoff, including any documented similarity exception.
5. Fill to 80 from a seeded random sample of the remaining eligible database.

Deduplicate within each job. If a bucket is short because of overlap or scarce supply, fill from that bucket's next candidates, then the remaining eligible random pool; record every substitution. If fewer than 80 eligible people exist, evaluate all and report the actual count. Do not pretend bucket membership itself is a relevance label. Record before judging which candidates entered through each route.

Score all 480 pairs against their jobs. Models do not receive reviewer labels. Reuse outputs with matching candidate evidence, job, prompt and model versions across D01/D02.

### D02 — retrieval plus ranking against the full database

Search the entire eligible frozen source snapshot, not just the 80 judged people. On development jobs, compare retrieval pool limits 100, 300 and 800 using existing/local methods first. Freeze the smallest configuration that preserves sufficient labelled positives before acceptance. Rank title matches before truncating them; avoid database-order selection. Record source data/text/embedding coverage, stale or missing information and eligibility exclusions.

On each acceptance job, assess the top 60 retrieved candidates using the frozen assessment/routing policy and publish the top 20 eligible recommendations. Record assessment counts actually used, including all escalation calls. There are at most 840 distinct candidate/job assessment inputs across D01 and this D02 budget envelope before cache overlap; escalation calls are additional and must be quoted. No silent depth increase beyond 60 if the test underfills.

Blind-review final top-20 results absent from D01: at most 120 additional judgements, giving **a maximum of 600 database candidate/job judgements** for the primary TA. Also second-review at least 20% of these additional rows. They improve final-list evaluation, not the original seeded-pool estimate.

**Proposed gates:** top-20 precision at least 85% per job where at least 20 candidates are returned; at least 90% recall of labelled Shortlists into the assessment pool; at least 90% retention of labelled Shortlists through screening, with inclusive Shortlist+Maybe recall reported separately. Report underfilled lists and likely supply/data limitations explicitly. If there are no labelled positives for a job, recall is undefined and that job cannot certify retrieval quality.

Define the existing ranking target explicitly: use within-job ROC AUC for Shortlist versus Reject, excluding Maybe/Unjudgeable from that metric but reporting their counts. Target 0.90 on the agreed aggregate, and report each job and family; do not silently substitute this definition for a different historic metric. If the original metric cannot be established, obtain agreement before acceptance. Add NDCG@20 using fixed gains Shortlist=2, Maybe=1, Reject=0 as a secondary ranking measure, without inventing a new required threshold.

Do not pool incomparable score scales across jobs for AUC. Report undefined metrics when a job lacks either class. Macro-average defined job results and report the number covered. Small positive counts require more evidence before a broad performance claim.

### L01 — LinkedIn suggestions, discovery through final list

Rehearse on the three existing development roles first, then use the six fresh roles only after freezing the pipeline. Freeze the JD, employer targets, geography, exclusion policy and search settings. Initial per-job envelope: **12 discovery requests plus up to 18 targeted evidence/enrichment requests = 30 paid search requests maximum**, with up to 10 results/request. This means at most **90 development and 180 acceptance search requests**, 270 for both stages before any approved expansion. Requests are not necessarily provider billing credits; quote the exact provider's returned-page/result-depth billing. There is no authorized extra round if the pool is poor.

Deduplicate URLs/identity, keep at most 60 candidate evidence packs/job for assessment, and preserve every source URL and timestamp. Fetch permitted public source pages only as necessary; bound to 2 pages per investigated person and include any charged fetch/enrichment API in the run card. Do not defeat access restrictions or infer unavailable profile facts.

Require identity corroboration before attaching a search result's employer, credential or responsibilities to someone. A matching name alone is insufficient. Prefer current source evidence; conflicting dates/current titles become unknown until resolved. First classify facts, then evaluate role fit. Do not add unsuitable people to fill a quota and do not ignore a large exclusion rate merely to preserve the list.

Publish up to 15 profiles/job. The TA checks every published profile for identity, relevant recent work, responsibility level and essential evidence. A second TA checks all published profiles too. Report: unique profiles, confirmed suitable, Maybe, Reject, unjudgeable, stale/current uncertainty, wrong-identity facts, source support, requests, tokens, latency and cost/job.

**User gate subject to section 3 interpretation:** at least 10 profiles/job, aim 15, at least 90% confirmed suitable and target 95%. Show precision at 10 and 15 when available plus actual-list precision. At 15 results, 14/15 is 93.3%; it passes a 90% floor but not a 95% floor. Evaluate each job and pooled totals. A short list cannot establish that suitable people do not exist: say “not found within tested sources and search budget,” record coverage, and obtain a targeted expansion quote if needed.

## 7. Research and benchmarking procedures

R01 fields per company: official identity/domain, core business, products/services, operating sector, headquarters, relevant operating locations, target operation/site, scale where available, relevant leadership role, and a dated development relevant to the hiring brief. Each field must have source support or be explicitly unknown. Avoid filling a template with generic industry prose.

B01: rehearse on the three existing development jobs, then verify up to 5 people per fresh job holding equivalent roles at relevant employers. This is at most 15 development and 30 acceptance people. Verify person, role/function, employer, source date and basis for equivalence. Verify current role where possible; otherwise mark uncertain. Source fallback to an unrelated page is a failure. Label incumbent versus predecessor separately.

For cost predictability, initially allow at most **6 research search requests per company** (72 over both splits) and **6 benchmark search requests per job** (18 development plus 36 acceptance = 54), with up to 10 results/request. Reuse relevant existing sources from L01; log that reuse without claiming a new search. Across L01/R01/B01 the initial envelope is at most 396 search requests before source reuse, excluding model calls and any separately approved expansion. Requests are not a dollar quote. Any expansion requires a revised quote and approval. Do not force five benchmark names if fewer can be verified.

**Proposed gates:** no fabricated or misattributed person/company/role fact; at least 95% support accuracy among substantive asserted research facts; an unknown rate reported separately. For benchmarking, every recommended named person must have a verified identity and role-source relationship. Supply shortfalls remain visible. TA relevance judgement of competing employers is required; shared sector alone is not equivalence.

## 8. Operational scenario catalogue

Prepare input state, triggering event, expected record changes, forbidden effects and audit evidence for every case. Give cases stable IDs. Existing regression cases count only if they exercise the specified behavior meaningfully; do not add tests that merely restate constants.

F01 — six cases in each of 10 groups (60):

1. Correct person/opening/channel and prevention of namesake contact.
2. No answer and email-only/phone-only/no-contact-information branches.
3. Partial answers, completed fields, declined disclosure and conflicting values.
4. Role-specific withdrawal, global do-not-contact, and consent withdrawal.
5. Requested callback, changed callback and cancellation.
6. Recipient time zone, quiet hours and applicable holiday/weekend policy.
7. Multiple TAs/openings contacting the same person.
8. Late reply, reply during dispatch and new information cancelling a reminder.
9. Provider rejection, timeout after acceptance, delayed delivery and reconciliation.
10. Restart, duplicate events and retry exhaustion with human handoff.

O01 intake/routing (24): exact job/campaign; edited advert aliases; ambiguous jobs; unknown destination; attachment/scan failure; repeat arrival. Four variants per group.

O02 identity/merge (24): exact contact match; conflicting strong identities; similar names; formatted/recycled/shared phone or email; updated employment/credential; concurrent arrivals. Four variants per group. Uncertain identity must not auto-merge; confirmed updates must preserve provenance and avoid stale overwrite.

O03 reviewer replies (24): partial numbered replies; replies to older rosters; named/ambiguous people; mixed approve/reject/hold/negation; repeated/forwarded replies; late reply after stage change. Four variants per group. Original roster numbering remains immutable. Model/parser conflict requires review; a model cannot silently override a clear deterministic interpretation.

O04 permissions/concurrency (24): unauthenticated/deactivated user; cross-client access; unauthorized stage decision; extension actor identity; simultaneous ownership claim; same candidate/job insertion race. Four variants per group. Validate checks inside transactions, not only before a lock.

O05 closing (24): interview time zones/rescheduling; invite acceptance/cancellation; offer creation/withdrawal; accepted offer/joining date; fee currency/basis and agreed terms; fall-through/guarantee/backup. Four variants per group. No fabricated financial terms, placement without required records or obsolete reminder after cancellation.

O06 jobs/retries (18): worker restart; duplicate event; stale job/JD version; partial provider response; timeout after possible success; exhausted retry/budget. Three variants per group. A durable operation ledger records intent, outcome and reconciliation. Retries must not duplicate a send or charge outside the approved envelope.

**Gate for all operational suites:** every required case passes, zero forbidden side effects, all critical operations attributable and replay-safe. Unimplemented integrations are “blocked/not tested,” never passes based on UI appearance or a mock alone.

## 9. Audio tests and brand protection

Audio tests are separately priced; mock-text success does not prove speech accuracy. Use recordings from explicitly consenting test participants or approved test material. Never start with candidate calls. Source text/transcripts are reference truth, not model-generated ground truth.

V01: 8 clear Sri Lankan English clips, 8 realistic noisy/accented English clips, and 8 supported-language/code-switching or explicit unsupported-language handoff clips. Confirm actual supported languages before populating the third bucket. In each bucket, split 4 development/4 acceptance. Cover currency, salary period, numbers, notice, dates, correction, refusal and withdrawal. Maximum 60 seconds each.

V02: 12 scripted conversations: 2 normal completion, 2 figure/date correction, 2 refusal/withdrawal, 2 callback/time-zone requests, 2 interruption/noise or unsupported-language handoff, 2 provider/restart failure. Use one of each pair in development and one unseen variation in acceptance. Max 2 minutes total conversation and 1 minute generated voice per case. No carrier charges enter this budget; speech, model, messaging and retry charges do.

Compare extracted fields to reference truth and listen to generated speech. Inspect names, number readback, naturalness, correct role/company, handling of uncertainty and speed. Record recognition and response latency without inventing a universal latency requirement; set a usability limit with operations before pilot.

**Proposed gate:** at least 95% accuracy on critical reference fields across acceptance audio, zero incorrect salary/notice/callback values committed without successful confirmation, zero withdrawal or recipient errors, and human handoff on unresolved ambiguity. Transcript quality alone cannot pass the calling workflow. Any absent voice integration is a blocker for that part of the release claim.

## 10. Assistant, reports, documents and full journeys

A01: 12 questions in each category — counts/ties/ranking; evidence/qualifications; workflow/next action; ambiguous/unsupported requests; permissions/client scope. Split 6 development/6 acceptance per category. The 30 unseen questions are written by TAs after the implementation is frozen. Check answer meaning, numbers, filters, dates, links and permissions. Unsupported questions must be declined or clarified. Proposed gate: at least 90% correct answers, 100% correctness for reported critical counts/decisions within that sample, no unauthorized disclosure or unapproved action. Errors remain visible rather than excluded as “unexpected phrasing.”

A02: four specifications in each of six groups — current-stage counts; historical stage transitions; date/time-zone filters; grouping/ties; placement/fee reporting; export and null/zero handling. Expected results are computed independently from the synthetic ledger. All 24 must reconcile. Do not interpret current-stage counts as historical conversion totals. Invalid/dropped filters cannot silently broaden a material report.

U01: six categories, two cases each per output type — long text; multilingual/unicode; missing information; changed job/candidate version; complex layout/scan; multiple pages/overflow. Inspect rendered output visually, including original-CV preservation, correct annotations, no overlap/truncation, correct contact/routing information and clear unknowns. A labelled placeholder CV is not a successful real-CV export. All 24 reviewed outputs must be accurate and usable before their production workflow passes.

E01: for each fresh job, run 3 complete isolated journeys: (1) normal candidate to completed placement record and reconciled report, (2) incomplete evidence/answers followed by clarification or withdrawal, (3) duplicates/concurrent claim plus delayed/replayed review/contact event. Include email recorded-as-sent versus actually accepted/delivered, candidate identity, versions, role permissions, time zones and costs. No real external delivery. All 18 must end with the expected records and no forbidden side effect. A later integration pilot must test actual delivery with separately approved test recipients.

## 11. Metrics, fair comparisons and evidence limitations

For every job and source, report counts as well as percentages:

- Precision@K = confirmed suitable among first K / K. Report K=10,15 for LinkedIn and K=20 for database, only when K results exist; also report actual list precision and count.
- Known-good retrieval recall = labelled Shortlists in retrieved assessment pool / all labelled Shortlists in the independent evaluated pool.
- Screening retention = labelled Shortlists retained / labelled Shortlists assessed. Inclusive Maybe retention is a separate number.
- Overall end-to-end retention includes losses from both retrieval and assessment; do not multiply estimates from incompatible samples.
- Quote existence, actual claim support and identity correctness are three different checks.
- Invalid outputs, unjudgeable evidence, refusals, timeouts and empty lists are recorded as outcomes, not removed to improve results.
- Time per TA-accepted candidate includes source checks, screening and rework. Cost includes every paid operation required to produce the result.

Show macro job averages, role-family results and pooled totals. Report 95% confidence intervals for precision proportions with a documented method; use job-level resampling for aggregate comparisons where appropriate and flag only six job clusters as limited evidence. Never advertise statistically established 90–95% production accuracy based on a handful of lists. This first acceptance test permits a supervised pilot only if agreed gates pass; it does not certify every future job.

For a fair legacy comparison, freeze the same source snapshot, evidence, eligibility rules and output-list size. Where the legacy system cannot accept that evidence or expose its historical input, label the comparison observational and do not claim like-for-like superiority. Legacy shortlist membership itself is not human ground truth.

Do not tune on acceptance failures and then reuse the same jobs as untouched evidence. Once inspected for tuning, mark the batch development and obtain fresh jobs for the next final acceptance test. New paid work needs a new approved run card.

## 12. Costing, approvals and monthly feasibility

Before paid execution, compute costs from the **exact input manifest**, using current official provider/model prices. Older tables in the conversation are not authoritative current quotes. Report model availability, route and date checked. Count all input/output, reasoning tokens if billed, search pages/credits, audio minutes, enrichment and messaging. Include provider/account fees where applicable and distinguish marginal usage from minimum account top-up. Existing prepaid credit consumption is still economic spend.

Run card fields:

`run_id`, purpose, test IDs, data split, exact job IDs, input manifest hash, records/requests/audio caps, model/provider/version, retention configuration, prompt/config hash, expected usage, maximum usage, price source/date, expected charge, hard charge cap, included retries, permitted fallback (default none), pass rules, stop rules, approval reference/status, actual cost and outcome.

Price and seek approval in this order, rather than funding the complete inventory upfront:

1. Free local preflight, deterministic repairs and reference-data preparation.
2. S01 warm-up, then S02 only if the warm-up and evidence checks justify it. Approvals are separate unless one explicit run card includes both with a stop after warm-up failure.
3. Development J01/X01, R01's 6 development companies, and L01/B01 on the 3 existing development jobs if those components require paid improvement. The initial development search maxima are 90 sourcing, 36 research and 18 benchmarking requests before source reuse. Use already exposed jobs for this rehearsal, never the six acceptance jobs. Quote exact quantities and all model calls before approval; a smaller approved first batch is allowed, but does not count as completion of the development inventory.
4. Freeze the selected pipeline, prepare final acceptance manifests, then quote D01/D02, L01, research/benchmark and audio as separate run cards. Reuse identical outputs across cards but never reuse candidate labels in model inputs.
5. Quote actual connected integration tests separately if required. Most state-machine, report and replay testing should remain local and unbilled.

An approved run checks reserved cost before every paid operation and settles actual usage afterward. Stop before exceeding the hard cap, preserve partial outputs and report remaining work. Never spend remaining allowance merely because it exists. A test cancelled after spending is still charged to its ledger.

Monthly projection must use measured quantities:

- Suggestions: 60 × measured searches, evidence processing and ranking cost/job, with role mix and a high-usage scenario.
- Database/research: 6,000 incoming CVs × fraction requiring new extraction × extraction cost, plus measured candidate/job assessments and escalations, changed-document embeddings, and research/benchmark cost for actual jobs/clients. Do not assume every CV is re-read 60 times; do not assume only 150/job without measurement.
- Calls: contacted candidates/month × measured conversation minutes and per-minute audio charges, plus generated voice, model calls, messages and retries. Carrier excluded. Contact count and average duration are unresolved inputs and must be measured or confirmed before declaring the $50 ceiling feasible.
- Separate warm-start/one-time historical ingestion costs from recurring operation. Report latency and any local compute capacity requirements alongside API cost.

If quality fails, identify whether the problem is evidence, retrieval, judgement or workflow; propose the smallest informative next test. If quality passes but cost fails, reduce duplicate processing, improve evidence reuse and test efficient routing. Do not secretly lower quality or assume a cache/batch discount. If required quality cannot fit the budget, state the measured gap and decision needed.

## 13. Implementation sequence and required deliverables

**Phase A:** inspect current state, isolate data, finish/read the existing laptop run, reproduce defects, add meaningful regression cases and implement local fixes within the user's authorized scope. No production changes. Output a baseline and fix log; record what remains unimplemented.

**Phase B:** create source/evidence manifests, exposure register, reviewer protocol, 12 job packages, 48 extraction documents and the six fresh jobs. Prepare all free synthetic scenario suites. Unavailable data remains explicitly blocked.

**Phase C:** run specifically approved development experiments, choose the cheapest passing components, and freeze the model/prompt/retrieval/routing configuration. Persist one assessment keyed by job/evidence/policy version; separate suitability, evidence completeness and readiness.

**Phase D:** execute only approved final acceptance cards and the local full-process tests. Produce the report with every gate marked PASS, FAIL, BLOCKED or NOT TESTED. A partially tested system cannot receive an overall PASS.

**Phase E:** validate monthly costs and run shadow mode first. A supervised pilot requires explicit launch scope and actual integration readiness. Production expansion requires sustained quality on new cases, not just a rerun of these fixtures.

Save outputs under a new isolated folder such as `quality-evaluation/2026-09-14/`, without modifying original labels or results:

1. `protocol.md` — approved definitions, thresholds, scenario catalogue and amendments.
2. `exposure-register.json` — prior job/candidate use and contamination.
3. `job-manifest.json` — actual development/acceptance IDs, approved requirement versions and reviewers.
4. `input-manifest.jsonl` — stable blind ID, private source-ID mapping, source hashes, document version, split and test membership.
5. `reference-labels.jsonl` — original primary/secondary labels, reason codes and adjudication, excluded from model prompts.
6. `runs/<run-id>/` — input/config hashes, raw responses, normalized outputs, errors and result counts.
7. `run-cards/<run-id>.json` — scope, pricing, retention, caps and explicit approval reference.
8. `cost-ledger.jsonl` — operation, run, reserved/actual charge, bucket and timestamp.
9. `metrics-by-job.json` and `failures.jsonl` — complete denominators, uncertainty, misreads and missed good candidates.
10. `fix-log.md`, `test-results.md`, `monthly-cost-model.md` and `decision-report.md` — changes, verification, recurring costs and recommendation.

Protect candidate information in these outputs. Reviewer-facing sheets use blind IDs; only authorized internal evidence contains identities. Keep credentials out of logs. Report model errors with redacted context where possible.

## 14. Mandatory preflight checklist and unresolved decisions

Claude must complete and report this checklist before quoting final paid acceptance:

- [ ] Current active runs/results checked; no duplicate job started.
- [ ] Existing spend reconciled; no new paid run assumed approved.
- [ ] Scope of local implementation authorized by the user's handoff instruction.
- [ ] Actual six untouched job IDs and adequate source evidence selected.
- [ ] User-required versus proposed gates distinguished and agreed.
- [ ] Definition of suitable, handling of Maybe and 90% versus 95% floor fixed.
- [ ] Historic ranking metric resolved; AUC definition agreed if used.
- [ ] Primary/secondary reviewers and their available time established.
- [ ] Supported call languages, contact policy and reference audio confirmed.
- [ ] Exact model/provider routes, prices and retention verified.
- [ ] Exact input counts, token/audio/search caps and required top-ups quoted.
- [ ] Live integrations clearly distinguished from simulations; missing ones listed.
- [ ] Snapshot isolation, versioning, replay handling and result/cost output paths ready.

Do not ask the user to reconfirm facts already explicit in this document. Ask only for actual missing job data, reviewer decisions, unsupported-scope choices or the specific paid-run approval needed. Continue independent free preparation while awaiting those inputs. Do not confuse a proposed spending allowance with permission to use it.

**Completion means a reviewable, reproducible answer for every workflow: what was tested, on which data, how it performed, what it cost, what failed, what was fixed, and whether that workflow is ready. It does not mean merely finding one model that agrees with the old 120 labels.**
