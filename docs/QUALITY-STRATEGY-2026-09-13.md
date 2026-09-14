# Career141: workflow analysis and quality strategy

13 September 2026

**Recommendation: retain the recruitment workflow foundation, replace the suitability assessment approach, strengthen candidate evidence and identity, and repair decision and contact handling before enabling further automation. A complete application rewrite is not justified by the evidence. More small scoring penalties alone are unlikely to address the central weaknesses.**

Your priorities govern this recommendation: wrong candidates and incorrect scores waste the team's attention; missed candidates lose opportunities; incorrect follow-ups damage the brand; duplicate records waste time.

## 1. What this review establishes

This is a code and process review of the local platform: intake, job approval, advertising, routing, deduplication, database search, matching, LinkedIn sourcing and capture, scoring, shortlisting, follow-ups, voice assistance, reviewer replies, interviews, offers, placements, reporting, assistants, permissions and background work. I inspected the existing evaluation scripts and available result-file structure, reran the existing tests and constructed seven small synthetic diagnostic cases.

All 17 existing test suites passed, and type checking passed. The integration suite initially could not start its temporary localhost server inside the sandbox; it passed when rerun with that permission. These are software checks, not new recruitment-quality results. The diagnostic cases reproduced deficiencies described below despite those passing tests.

The reported 66% database relevance, 66% LinkedIn relevance and other performance figures are the results supplied in this conversation. I have not independently relabelled the real candidates, received TA judgements or repeated paid model evaluations. The present production system was not independently audited in this turn. Claims in code comments about earlier production findings remain historical claims, not newly verified findings.

No production records were changed, candidates contacted, providers switched or paid sourcing/ranking experiments run. The application implementation remains unchanged. This report is the deliverable.

## 2. Why the present approach is falling short

The system is good at moving records through a defined process. Its weakest step is deciding whether the record represents somebody who can do the actual job.

Five problems reinforce one another:

1. **Job requirements lose meaning.** Separate experience requirements become one minimum, job level largely comes from title words, and some responsibilities are assessed through word overlap.
2. **Candidate evidence is incomplete or inconsistent.** New intake does not build a full employment history; LinkedIn ranking sees small snippets; a newer CV can coexist with old structured fields.
3. **Retrieval and suitability are mixed together.** Similarity helps find related CVs, but the system also gives it 40% of the matching score. That can soften penalties for actual mismatches.
4. **There is no single assessment shared everywhere.** Matching, the candidate list and the chatbot can use different calculations or different ages of information.
5. **Evaluation is not yet independent enough to establish readiness.** Development examples have been used to improve the same system being measured. Human validation is still pending, and different evaluations cover different populations.

This explains why easy title-and-qualification roles can look good while senior and specialist roles remain weak. An accountant's credential may be visible in a short profile. Group-level supply-chain responsibility requires evidence of breadth, authority and operating scale that a title and shared vocabulary do not establish.

## 3. Confirmed defects and consequential weaknesses

“Reproduced” means exercised with synthetic inputs against the current code. “Code finding” means the behavior is visible in the implementation, but its frequency in real data has not been measured.

| Finding | Evidence and consequence | Required response |
|---|---|---|
| Separate experience requirements collapse — reproduced | A job requiring 15 years overall and 8 years in management becomes a minimum of 8. An illustrative candidate with 8 years receives 92 under the rules-only assessment. This is not a calibrated probability. | Preserve each requirement and its scope; calculate relevant and leadership experience separately. |
| Negation does not prevent a requirement being marked met — reproduced | “I have never managed procurement budgets” receives 100 for “Managed procurement budgets” in the written-requirement component. | Require supporting evidence about work performed; distinguish contradiction from missing evidence. |
| Studying can count as qualified — reproduced | “Currently studying CIMA” avoids the missing-qualification penalty for a CIMA-qualified requirement. | Record credential status: studying, part-complete, affiliate, qualified, current/expired where relevant. |
| Scores depend on the path — reproduced and traced | With the same candidate and job, rules-only returned 92 and similarity-inclusive returned 91 for the illustrative similarity input. Production matching passes similarity; the candidate list does not. | Use one versioned assessment everywhere. Keep retrieval similarity separate from displayed suitability. |
| Decline can lose to data completeness — reproduced | A candidate with salary and notice completed, but a latest call outcome of “not interested,” receives follow-up state `complete`. Completion is checked before decline. | Check withdrawal and contact restrictions first; readiness must include current interest. |
| Email-only follow-up ignores an earlier email — reproduced | With no phone, a recorded outgoing email and missing information, the next step is immediately another email because the “no calls” branch wins. | Track contact state by recipient and channel, with delivery, waiting periods and stop conditions. |
| Partial replies change candidate numbering — reproduced | After original candidate 1 is decided, “Shortlist 2” against the remaining roster selects original candidate 3. Older email rounds can also be combined into the roster. | Resolve replies against the exact sent email and its immutable numbering; never renumber undecided candidates. |
| Title retrieval depends on database order — code finding | Automatic matching stops at the first 500 title-qualified additions, not the best 500. | Rank retrieval candidates before applying the limit; measure missed known-good candidates. |
| LinkedIn evidence may belong to a namesake — code finding | Enrichment searches a name, region and broad discipline, then appends returned snippets without an explicit identity-verification gate. | Require corroborating employer, role, dates or profile link before merging facts. |
| LinkedIn evidence is then heavily truncated — code finding | Ranking receives a headline plus 380 characters of profile snippets and 480 characters of enrichment. | Select relevant evidence by requirement and preserve sources, dates and contradictions. |
| Aggressive exclusion can be silently ignored — code finding | If the model excludes at least 75% of a sourcing pool, its exclusion pass is ignored. A bad search and a bad filter are indistinguishable under this rule. | Report that the pool failed screening and diagnose the cause; never restore rejected people simply to maintain volume. |
| Feedback does not reliably improve subsequent searches — code finding | A sourcing-chat SEARCH response records an action but does not run a search or persist its TERMS into `sourceFor`. Subsequent runs receive the JD and selected employers, not a structured history of rejection reasons. | Save accepted search refinements, show pending versus completed actions, and route reason-coded feedback into the next plan. |

Code: [experience extraction](/Users/uzmaan/career141-ta-platform/src/lib/scoring.ts:946), [written requirements](/Users/uzmaan/career141-ta-platform/src/lib/scoring.ts:329), [credentials](/Users/uzmaan/career141-ta-platform/src/lib/scoring.ts:646), [score blend](/Users/uzmaan/career141-ta-platform/src/lib/scoring.ts:678), [candidate list](/Users/uzmaan/career141-ta-platform/src/components/CandidateList.tsx:138), [follow-up](/Users/uzmaan/career141-ta-platform/src/lib/followup.ts:179), [reply roster](/Users/uzmaan/career141-ta-platform/src/data/store.ts:1891), [retrieval](/Users/uzmaan/career141-ta-platform/src/lib/dbMatch.ts:130), [sourcing enrichment](/Users/uzmaan/career141-ta-platform/src/lib/sourcing.ts:619), [sourcing chat](/Users/uzmaan/career141-ta-platform/src/app/actions.ts:1182).

These are mechanisms capable of causing mistakes. Except for the synthetic cases, this review does not assign a percentage of the reported errors to each mechanism.

## 4. Workflow-by-workflow decision

| Workflow | Keep | Improve or replace | Acceptance evidence |
|---|---|---|---|
| Client brief and intake | Editable brief, recorded provenance and human approval. | Extract a structured role assessment with explicit essential/preferred/unknown fields. Currency and salary basis must be confirmed rather than inferred from unrelated numbers. | Compare extracted facts with actual client briefs, including incomplete and contradictory notes. |
| JD generation and approval | Draft from the brief, then approve. | Generate the JD from the same approved requirements used for assessment. Version changes and invalidate affected assessments and adverts. | No invented requirement or material discrepancy between brief, approved criteria and published JD in the release sample. |
| Job adverts and snippets | Many adverts linked to one opening; stable campaign codes. | Use approved role level and facts consistently; audit rendering on real content lengths. Version adverts and routing aliases together. | Test multiple titles, edited titles, long packages and a real application back to the intended opening. |
| CV arrival and routing | Queue, source attribution, ambiguity handling and one person across applications. | Real file extraction/OCR and channel connectors are still needed. The current external channel definitions remain blocked; do not treat the UI as proof of working email/WhatsApp intake. | Realistic PDFs, scans and repeated arrivals route correctly; every failure reaches a visible exception queue. |
| Candidate identity and merge | Normalized contact keys, ambiguous-match review and conflict-preserving merges. | Add transactional identity resolution, field provenance and an actionable conflict inbox. Update changed employment facts explicitly; keep a history instead of retaining stale fields indefinitely. | Duplicate arrivals create one person; namesakes stay separate; a verified correction survives re-import. |
| Existing-data sync | Read-only copying and source IDs for migration/testing. | Treat the current mirror as a test copy. Sync replaces candidate records, while its resume feed covers records with embeddings and does not fetch R2-only text. Reconcile all source candidates, files and deletions. | Source/target counts, ID integrity, text coverage, resumability and protection of local verified changes. |
| Manual database search | Natural-language filters, Boolean search and semantic search. | Share terminology and explicit unknown handling with automatic matching. Search presently has different filters and scoring from automatic matching. Explain relaxed conditions. | Known candidates are findable by title, skill, qualification and equivalent wording without unexplained omissions. |
| Automatic database matching | Broad search, small reviewable lists and TA confirmation. | Combine ranked lexical, semantic and structured retrieval; assess evidence afterward. Refresh unclaimed suggestions when the job or evidence changes. | Top-result precision, pool recall, useful result count and performance by role family. |
| Company research and benchmarking | Employer mapping and source-linked research. | Verify the source of each claim and whether the role is current. The active benchmark action still calls the older generator/parser; that parser can attach a fallback source unrelated to the person. A newer search-based path exists but is not used by that action. | Every named person-role-company relationship is supported by a matching source; dated information is labelled. |
| LinkedIn discovery and enrichment | Search returns actual profile URLs; employer/function queries; TA-initiated profile capture. | Verify identity, preserve source evidence and dates, persist feedback, and separate discovery from verified suitability. Ranking cannot recover unavailable facts. | Relevant, unique, evidenced candidates in the top results; namesake and stale-profile checks. |
| Fit scoring | Explainability and deterministic calculations for facts. | Replace the final title/keyword-weighted assessment with structured requirement evidence and a calibrated ranking policy. | Same assessment across screens; agreement with unseen TA judgements; explicit uncertainty. |
| TA shortlist and ownership | Human decision, ownership, stage events and duplicate-application prevention. | Avoid preselected bulk shortlisting based on an unvalidated score. Put ownership/uniqueness checks inside the write transaction. Current checks occur before the file lock in important paths. | Concurrent claims have one winner; all forwarded candidates have a review record. |
| Follow-up and voice | Assisted calling, explicit answers, consent recording and conflict handling. | A recipient-level contact policy must control all jobs/channels. Use candidate local time, preferences, requested callbacks and stop conditions. The present script collects mainly salary, notice and availability, not competence. Live calling is not verified here. | No duplicate contact, no contact after withdrawal, no wrong-role wording and correct handling of callbacks, restarts and late replies. |
| Director/client submission | Familiar email format and stored review rounds. | Separate draft, manually recorded sent, provider accepted, delivered and failed. The current send action records a round but sends no email. Validate eligible stages on the server. | The intended reviewer receives the exact reviewed roster; failed delivery cannot appear delivered. |
| Reviewer decisions | Decision history and protection against stale stage changes. | Bind decisions to exact messages and original numbering. Model fallback can overwrite deterministic decisions; conflicts and ambiguous replies need review before stage changes. Pasted replies need attribution distinct from authenticated reviewer actions. | Partial, delayed, forwarded, ambiguous and repeated replies never affect the wrong person. |
| Interviews | Scheduling records, outcomes and prerequisites before stage changes. | Add verified delivery/response state for invitations, explicit time zones, rescheduling and conflict handling. | Candidate, TA and client agree on one time; rescheduling invalidates old reminders. |
| Offers, placement and backups | Explicit offer/acceptance/placement records, fee basis and guarantees. | Reassess backups against the role and current interest; avoid treating similarity to the declined person as sufficient. Use agreed commercial terms and test cancelled/fallen-through scenarios. | Accepted offer, joining date and ownership reconcile; reminders and reports reflect changes. |
| Assistant and reporting | Calculate totals in code; authorize actions and present confirmation. | Replace bounded snapshots and note-parsed scores with typed queries and canonical assessments. Distinguish current stage counts from historical conversions. Dropped query filters must require correction rather than silently broadening important reports. | Unseen TA questions reconcile to records, filters, dates and access scope. |
| Alerts and management | Named owners, action links, escalation and review deadlines. | Prioritize qualified pipeline and unresolved decisions, not generic volume targets such as ten CVs/day for every role. Clarify working-day versus working-hour definitions; holidays are currently empty. | Low-quality volume cannot make a role look healthy; alerts identify an actionable issue. |
| Platform operation | Repository interface and centralized authorization policy. | Replace account-picker authentication and shared extension identity with real user identity. Replace whole-file production storage and request-lifetime background work with transactions and durable jobs. | Multi-user, restart, retry, access-isolation and restore tests before real operational rollout. |

Additional evidence: [intake parser](/Users/uzmaan/career141-ta-platform/src/lib/ingest.ts:265), [new candidate history](/Users/uzmaan/career141-ta-platform/src/data/store.ts:3206), [sync](/Users/uzmaan/career141-ta-platform/src/lib/live/sync.ts:124), [mirror overwrite](/Users/uzmaan/career141-ta-platform/src/data/store.ts:3397), [active benchmark](/Users/uzmaan/career141-ta-platform/src/app/actions.ts:985), [fallback citation](/Users/uzmaan/career141-ta-platform/src/lib/headhunt.ts:152), [submission action](/Users/uzmaan/career141-ta-platform/src/app/actions.ts:1705), [model reply merge](/Users/uzmaan/career141-ta-platform/src/lib/reviewReply.ts:325), [prepared CV placeholder](/Users/uzmaan/career141-ta-platform/src/lib/pdf.ts:109), [session](/Users/uzmaan/career141-ta-platform/src/lib/session.ts:9), [background work](/Users/uzmaan/career141-ta-platform/src/app/actions.ts:351).

The prepared-CV export also still constructs a labelled stand-in page rather than annotating the original CV. That is an integration gap, not a finished candidate submission workflow. The README's description of synthetic-only stage-one functionality is outdated relative to the current code and local evaluation data. Replace it with a capability register that distinguishes implemented, simulated, connected and validated.

## 5. The recommended matching design

### One approved definition of the job

Create a versioned assessment agreed by the lead/TA. It should describe the actual function, essential responsibilities, technical domain, responsibility level, operating scale, relevant experience, credential status and genuine practical constraints. Preserve alternatives and combined conditions: “CA or ACCA” differs from “CA and manufacturing experience.”

For a Group Chief Supply Chain role, assess the breadth actually required by the brief: procurement, planning, logistics, inventory, group responsibility and leadership scale. For plant engineering, assess the relevant machinery, maintenance or plant responsibilities. For documentation, assess the specific shipping/customs workflow. Do not assume these requirements merely because of the title.

This follows the underlying assessment principle that job tasks and competencies should determine selection criteria. [OPM job analysis guidance](https://www.opm.gov/policy-data-oversight/assessment-and-selection/job-analysis/)

### One evidence record for each person

Store the original document or permitted profile capture, extracted text, employment timeline, responsibilities, qualifications and source dates. Every material fact should record where it came from and whether it was confirmed by a TA or candidate. Separate identity confidence from job fit.

Extract role history once per document version, then reuse it across jobs. A new job should not require a model to reread every CV in the database. Select relevant source passages for each assessment rather than taking the first few hundred characters.

Do not infer gender from names or nationality from schooling, employers or location history for suitability decisions. Those inferences appear in current sourcing/scoring paths and can incorrectly remove good people. Assess job-related requirements; where work eligibility needs checking, use explicit, verified information. A person's employer or country also does not establish their salary expectation or willingness to move.

### Retrieve broadly, assess narrowly

Build a candidate pool from several routes: title/function terms, semantic similarity, specialist skills and relevant employment history. Rank each route before limiting results, merge by identity, and record which route retrieved each candidate.

Start by testing a pool size in the hundreds and evidence review of perhaps 40–100 candidates per job. These are experimental settings, not fixed requirements. Select the smallest pool that retains the known good candidates. Preserve promising but uncertain people in a separate review queue rather than silently excluding them.

Hybrid retrieval and subsequent reranking are established search patterns; they are candidates to test here, not a guarantee of improvement. A second-stage model cannot recover candidates absent from its input pool. [Elastic ranking documentation](https://www.elastic.co/docs/solutions/search/ranking)

### Assess requirements before producing a number

For every important requirement, return:

| Result | Meaning | Action |
|---|---|---|
| Evidenced | Relevant source material supports it. | Count it with the agreed importance. |
| Contradicted | Reliable evidence conflicts with it. | Explain the mismatch; apply the agreed requirement policy. |
| Unknown | The record does not establish it. | Ask a targeted question or obtain better evidence. |

Separate **professional suitability**, **evidence completeness** and **practical readiness**. Salary availability is not proof of competence; a thin profile is not proof of incompetence. Broad text similarity must not erase a confirmed essential mismatch.

The model can extract and compare evidence. Code should check output structure, verify that quoted passages exist, calculate dates, enforce policy and store results. Checking that a quote exists is necessary but not sufficient: the evaluation must also test whether it actually supports the claim.

Store one assessment keyed by candidate evidence version, approved job version and assessment-policy version. Every badge, shortlist, explanation and chatbot answer reads it. If an input changes, mark the assessment stale and refresh it. Stop parsing scores out of narrative notes. Until calibrated, a score is a ranking index, not “percentage suitable.” Standardize bands: the assistant currently calls 70+ strong while the scoring module uses 85+.

### Use a different evidence workflow for executive searches

The same application can support both ordinary and senior roles, but executive search needs more evidence. Use employer mapping, verified role scope, achievement examples and a structured TA conversation when public profiles cannot establish fit. Do not compensate for missing evidence by increasing model confidence.

A short, consistent interview against role-specific criteria can establish facts that a CV omits. Use the same standards for comparable candidates. [OPM structured interview guidance](https://www.opm.gov/policy-data-oversight/assessment-and-selection/structured-interviews)

## 6. Follow-ups should be a controlled process

Before any future automatic send or call, create a durable contact record containing recipient identity, opening, purpose, approved wording, channel, planned time, deduplication key and current eligibility to contact. Recheck that eligibility immediately before dispatch.

Recipient-level withdrawal/contact preferences must override all openings. Application-level “not interested in this role” should stop that role's outreach without silently assuming the person refuses every future opportunity. Record these separately. A callback requested for tomorrow must take precedence over a generic three-hour reminder.

Track planned, attempted, provider accepted, delivered, failed and replied as distinct states. A timeout after dispatch must lead to reconciliation before retrying, not a blind resend. Human edits and incoming replies must cancel or supersede queued messages. Persist these rules across restarts and multiple workers.

Use assisted outreach until the contact scenarios pass. The goal is fewer unnecessary contacts and reliable responses, not maximizing the number of automated touches in 24 hours. Keep the existing operational pace only where it matches recipient preferences and observed outcomes.

## 7. Evaluation that can decide whether it works

The current numbers are useful development signals, with important limits:

- The 0.88 ranking result and the 0.71 applicant comparison concern different candidate populations. Neither is “88% accurate.”
- Current-system shortlist membership is an operational outcome, not ground truth. One embedding comparison script treats stages as positive/negative labels; that measures resemblance to earlier selections, not independent fit.
- Review sheets and some model-comparison inputs truncate CV evidence. Senior-role judgements need the relevant full evidence, not only the opening paragraph.
- The “just below” sampling in the matching evaluation still uses 35–44, although the normal matching floor is now 60, with an exception for high similarity. Update the evaluation to sample around the actual policy boundary.
- Judging selected buckets does not establish how many good people exist throughout the entire database. Report recall against the labelled pool and test broader coverage separately.
- Two TA review sheets establish initial agreement on those examples, not readiness across all jobs. Twenty developer-written chatbot questions are also a development set.

Build a versioned evaluation set spanning ordinary, senior and specialist roles, rich and thin records, applicants and database prospects. Start with roughly 500–800 candidate/job judgements, including current results, alternative retrieval results, near misses and a sample outside the retrieved pool. This is a planning range; adjust for TA workload and disagreement.

Have a second TA independently review a meaningful overlap, such as 20%, and resolve material disagreements with the lead. Reviewers must not see model scores or which system retrieved the candidate. Mark insufficient evidence separately. Give them the approved requirements and relevant source material.

Split by opening/client and avoid repeated candidate leakage where practical. Keep entire jobs unseen during development. Freeze the rubric and acceptance rules before the final test. New unseen examples are required after tuning against an old test set.

Compare in stages to isolate the cause:

1. **Extraction:** do both systems have the correct job and candidate facts?
2. **Retrieval:** does the pool include the labelled good candidates?
3. **Assessment:** on the same pool and evidence, which method ranks candidates best?
4. **End to end:** which complete system gives TAs useful results at acceptable effort and cost?

Measure precision at the list sizes TAs use, known-good recall within the labelled pool, rank quality, result count, evidence accuracy, review time and cost per TA-accepted candidate. Report counts and uncertainty, and show results by role family and source. Human-rated relevance is the basis for standard search evaluation. [Elastic ranking evaluation](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/search-rank-eval)

### Proposed release criteria

These are recommendations for agreement before testing, not achieved results or universal industry standards. The original database target was 75%; I recommend 85% for the first screen given your stated tolerance for wrong candidates. Keep the agreed 0.90 ranking target, with its metric definition and population explicitly fixed.

| Area | Proposed gate |
|---|---|
| Database suggestions | At least 85% TA-approved among the top 20 on the final test, with results broken out by role family and enough useful candidates to meet the actual requirement. |
| LinkedIn suggestions | At least 80% TA-approved among the top 10, with verified identity and supporting role evidence. Report unknowns and underfilled lists. |
| Retrieval coverage | At least 90% of labelled good candidates reach the assessment pool. This is labelled-pool recall, not a claim about every suitable person in the market. |
| Ranking | Meet the agreed 0.90 target on unseen data using the defined metric, while also passing top-result precision. |
| Consistency | Identical candidate/job/evidence versions produce the same displayed assessment everywhere. |
| Decisions and contact | No wrong-person action, contact after applicable withdrawal, duplicate send or incorrectly interpreted approval in the release scenario suite. Pilot monitoring remains necessary. |
| Practical benefit | Demonstrable reduction in TA time per accepted candidate, without increasing missed good candidates or brand-damaging contacts. |

An empty list does not pass precision. If the database has fewer than 20 suitable people, report the actual count and evidence of scarcity rather than adding weak people. One job with 17 good candidates out of 20 is encouraging but statistically imprecise; report confidence intervals across sufficient cases and avoid letting high-volume easy roles hide weak families. All required areas should pass before a general rollout.

## 8. Implementation order and ownership

| Order | Work | Accountable owner | Deliverable and stopping condition |
|---|---|---|---|
| 1 | Correct the reproduced decision/contact defects, score inconsistencies and misleading action states. | Engineering, with TA lead validating scenarios. | Diagnostic cases become regression tests; assessments and message states are consistent. Keep autonomous outreach disabled until verified. |
| 2 | Define requirements and independent evaluation labels; obtain the missing CV evidence for those cases first. | TA lead and reviewing TAs; engineering supports extraction. | Approved assessment criteria, evidence-quality audit and untouched final-test jobs. Expand copying after source coverage and resumability are established. |
| 3 | Build structured candidate evidence and retrieval experiments. | Engineering, checked by a specialist TA. | Compare ranked title search, lexical/semantic combination and evidence extraction separately; meet pool coverage before tuning final ranking. |
| 4 | Compare assessment approaches on frozen inputs. | Engineering and blind TA reviewers. | Existing scorer versus dedicated reranker versus requirement-based model assessment; choose using quality and reviewer effort. |
| 5 | Repair LinkedIn identity/evidence and persist sourcing feedback. | Sourcing lead and engineering. | Verified top suggestions and clear failure reasons; test provider coverage only if discovery remains the limiting step. |
| 6 | Harden the operational foundation and integrations. | Engineering and operations. | Real identity, transactional storage, durable jobs, original-CV export, message reconciliation, backups and restore checks. |
| 7 | Run shadow evaluation, then a limited supervised pilot after gates pass. | TA lead/operations; director approves rollout criteria. | New system proposes alongside existing work; compare accepted candidates, misses, contacts, effort and failures. |

This order is milestone-based because TA labels and source quality determine the work. It is not credible to promise a launch date or monthly cost before measuring those dependencies. Quality work can proceed immediately without waiting for an overnight copy of every CV.

The existing system reportedly uses Convex. Subject to verifying its actual backend, reusing its transactional records and durable scheduling is a sensible default, with the new assessment capability integrated behind the current repository boundary. Avoid maintaining two independent operational candidate databases. Convex can atomically schedule work from a mutation; external actions still need explicit retry and reconciliation design. [Convex scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions)

## 9. What to use if the current method still does not pass

| Option | When it makes sense | What must be proved |
|---|---|---|
| Keep rules as final scorer | Only if the corrected rules pass unseen tests for the required role families. | Stable precision and recall, not another gain on development examples. |
| Hybrid retrieval plus requirement-based assessment — recommended experiment | Good candidates can be retrieved and the evidence exists, but current ranking misses responsibility or domain meaning. | Better TA-approved top results on the same evidence, with reliable explanations. |
| Dedicated relevance reranker | Candidate/job text is sufficient and the main problem is ordering. | It beats the baseline; it will not by itself verify credentials, identity or interest. |
| Better sourcing data or recruiter-assisted profile capture | Relevant candidates or essential facts are absent from public search results. | A sample provides additional unique suitable people or missing facts, rather than more duplicates and titles. |
| Specialist TA research plus structured screening | Executive/niche roles remain below target or public evidence cannot support judgement. | Strong candidates with substantiated role scope; AI assists research and documentation while TAs decide suitability. |
| Entire platform rewrite | Only if a separate integration/operability assessment shows the existing boundaries cannot support the required behavior economically. | Measured migration and maintenance advantage. Current findings do not establish this. |

Do not repeat the failed generic AI reviewer unchanged. Test why it failed: inadequate evidence, vague criteria, excessive positive ratings, weak model capability, or a poor candidate pool. Change one layer at a time. A stronger model should be tested on a small fixed set before broad adoption; there is no basis yet to claim it will meet the targets.

If the evidence-based approach still fails on an untouched test, diagnose by stage. If retrieval fails, improve retrieval or data coverage. If evidence is missing, collect it. If the model misreads available evidence, change the assessment method. If TAs disagree, refine the rubric. If a required role family remains below the agreed threshold, keep it in supervised research and do not declare the whole product ready.

## 10. Spending and the business decision

The reported $1.99 is historical spend, not a quality measure or a defensible operating-cost forecast. The earlier $0.30 test and $2–5/month estimates cannot establish cost for a rebuilt pipeline without workload measurements.

Track extraction per changed CV, enrichment per unique prospect, assessment per candidate/job version, retries, and TA review minutes. Reuse extracted evidence, cache unchanged assessments and reserve stronger models for difficult or disputed cases. Compare total cost per accepted candidate: a small model saving is not worthwhile if it creates repeated manual re-screening.

The next decision should therefore be to fund a bounded quality experiment with an agreed cap and clear acceptance gates, not to optimize for the cheapest model first. No new paid experiment was started during this review.

**The intended product is a recruitment desk that presents a short, credible list, shows why each person belongs, finds overlooked candidates and never confuses a prediction with an approved decision. The present workflow foundation can support that product, but the assessment and contact/decision gaps above must be addressed before it is ready for dependable use.**
