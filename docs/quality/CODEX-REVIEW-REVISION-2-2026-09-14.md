# Review of the resource inventory and test plan, revision 2

14 September 2026. Review of the supplied plan and selected local source files only. No paid services, production reads or writes, or external contact were initiated for this review. Provider prices and live counts below remain the supplied report's claims, not independently rechecked account facts.

## Decision

Revision 2 is a sound direction for development, with substantially better coverage. P1 is a reasonable first paid experiment once its execution and cost controls are made concrete and the user explicitly approves that run. The complete programme is not yet a release-ready protocol or an all-inclusive quote.

Preserve the improvements already made: actual top-result review, independent human labels, separate model selection and acceptance, checks on every published LinkedIn identity, explicit snapshot limitations, specialist end-to-end tests, and coverage through placement and permissions. Do not restart the plan or run additional model comparisons merely to improve the plan's presentation.

## Corrections required before requesting approval for P1

1. **Implement and demonstrate a separate run cap.** `src/lib/spend.ts` currently sets `TEST_CAP_USD = 5`; it does not implement the proposed $0.40 P1 allowance. Reservations are in process memory, the ledger is not protected across concurrent processes, and a missing or unreadable ledger is treated as zero spend. Use an isolated test runner/key, an approved per-run allowance, durable accounting, and fail closed on an unreadable existing ledger. Prove the stop and restart behaviour with mocked providers before any paid request. Do not change a potentially shared production key as part of this work.

2. **Account for uncertain charges and retries.** In `src/lib/ai.ts`, cost starts at zero, is only set for a successful response, and is settled in `finally`. A failed request can therefore be recorded as free even when its billing outcome is unknown. The request loop also permits up to four attempts, whereas P1 specifies at most one retry. The P1 runner must have an explicit attempt policy and retain a conservative reservation for an uncertain charge until reconciled. An unchanged local ledger alone cannot establish that all unexplained provider usage came from elsewhere. The dedicated runner may differ from this helper; show which code it actually uses.

3. **Make the $0.40 promise precise.** Using the plan's stated prices and 3,700 input tokens, 360 calls with 220 output tokens cost approximately $0.322 including the stated fee. At the allowed 600 output tokens they cost approximately $0.432, before retries or longer inputs. The new evidence-quoting prompt has not yet been measured. Keep $0.40 as a genuine stop if desired, but state that it may produce an incomplete comparison. Alternatively, measure the frozen inputs locally and submit a revised maximum for approval. Do not silently raise it. Missing or capped responses must be shown as incomplete, not dropped from the comparison.

4. **Freeze the runnable manifest.** Record exact model and provider routes, their current prices and retention settings, input hashes, prompt, output limit, retry policy, and expected/worst-case charge. The proposed `unknown` quantization allowance does not establish that all routes are verified standard versions. Check the actual outbound CV text for contact details embedded within it; removing top-level fields does not guarantee removal from raw text. Describe these CVs as de-identified rather than guaranteed anonymous.

5. **Keep P1's conclusion narrow.** Keeping 15 of 18 acceptable candidates is 83.3% retention. That can justify more development work, but it does not meet the later 90% retention gate or demonstrate 90–95% recommendation suitability. Report Shortlist-only results, Shortlist-plus-Maybe results, false rejects, invalid responses, and each job separately. Compare against the newly frozen laptop prompt, not only the previous run.

## Corrections required for the full testing protocol

### Retrieval and ranking

- T6's O1 and O2 can contain the same people. Define mutually exclusive strata before sampling: retrieved top 20; the rest of the actual retrieved pool; outside-pool keyword/history candidates; outside-pool semantic candidates excluding the previous group; and the remainder. Save every stratum's size, sampling seed and sampled IDs. Define whether ranks are retrieval ranks or final assessment ranks. Handle pools smaller or larger than 500 explicitly.
- Ten reviews from a large remaining stratum can yield very uncertain missed-candidate estimates. Zero observed good candidates does not establish zero good candidates there. Use an interval method that handles zero counts, then expand the stratum responsible for uncertainty. Adding only 20 O1 reviews is not a general solution. Predefine the maximum additional reviewer work; return **inconclusive** when precision is insufficient.
- Recall on the first 7,251 records is a valid snapshot result, but cannot establish full-live-database recall. Add a separate, explicitly scoped production-scale shadow gate before making a live coverage claim. It can use approved server-side retrieval; a full laptop copy is not inherently required.
- Explain where each assessment stage sits. Scoring only the retrieval pool's top 100 may lose good people ranked 101–500. Review those exclusions and score the complete production selection policy, including every stage's misses.
- T8/P2 describe roughly 600 development assessments as top 100 per job **plus** labelled outsiders. Top 100 across six jobs already uses 600 assessments; sampled outside-pool candidates necessarily add more. Generate a deduplicated candidate-job manifest before quoting or subtracting the existing 120 reviews. Existing reviewed people are reusable where they overlap, not automatically all part of the new sample.
- If human labels are used to force outside-pool candidates through a model for diagnosis, keep those diagnostic results separate from the actual pipeline's outputs. They must not rescue production recall artificially.

### Quality gates and evaluation discipline

- Q3/Q4 are substantive open decisions. Until confirmed, use confirmed suitable candidates for the headline LinkedIn suitability figure and show Maybes separately. Do not silently replace suitability with Shortlist-plus-Maybe. The proposed 40% Shortlist floor for database results is a proposal, not an agreed requirement.
- Resolve contradictory floors. T7 calls for 85% per role type but also permits 75%; T9 calls for 90% per job but also permits 85% per role type. Averages must not hide a failing job. Define per-job gates, and distinguish pass, fail and inconclusive.
- Reviewing ten rejected LinkedIn profiles cannot establish that fewer than ten suitable people exist in the market. On an unsuccessful search, report that the system found fewer than ten within the tested scope and budget. A scarcity explanation requires broader evidence; do not count an unproven scarcity claim as a pass.
- The 30 original-file extraction cases and existing JD drafts need a held-out portion if fixes or model choices use their results. Label accuracy before human corrections separately from the performance of a workflow that intentionally requires approval.
- Human review estimates imply roughly 15 seconds per CV even when reasons and CV evidence are required. Time a small representative review pilot and revise the work estimate. Do not rush labels to meet the estimate.
- Report uncertainty for recommendation suitability and ranking too, not only retrieval recall. A handful of top lists provides useful acceptance evidence, not proof of stable population-wide 95% accuracy.

### Implemented versus planned capabilities

- **Correct the prepared-CV inventory fact.** `src/lib/pdf.ts:195` calls `placeholderCv(subject)` and uses `placeholderOccupancy()` for placement. The current function builds a single-page stand-in; it does not accept or annotate an original CV PDF. Mark original-file annotation as an implementation dependency. T3 must run through the actual final export path with the original files after that exists.
- Audio and messaging integrations are also implementation dependencies, not merely test charges. Distinguish component tests using fakes from actual provider delivery tests and reserve live-pilot readiness until the necessary integrations pass.
- Add explicit expected behaviour for callback time zones, partial replies after earlier decisions, withdrawal scope across two jobs, late provider events, and delivery outcomes. A delivery attempt, provider acknowledgement and confirmed delivery are different states; failures must not be reported as successful delivery.
- Research freshness depends on the claim. A current title may be stale well before 24 months. Check whether each source supports the claim as presented and its relevant date.

## Cost corrections

The listed rows do add to **$12.65 expected / $17.95 maximum**. However, that is not the complete successful path. Benchmark acceptance, research acceptance, audio tests and end-to-end model usage appear as conditional rows even though they are needed to validate the corresponding launch workflows.

Adding the listed P11, P9b, P13 and P17 amounts gives an illustrative successful path of **$18.05 expected / $27.25 in listed caps**, before existing test spend, top-up purchase requirements, unknown audio privacy surcharges/environment costs, messaging, optional drafts, OCR fallback, stronger-model replacements or reruns. This is arithmetic using the supplied estimates, not a verified full quote. The $4 audio cap cannot be described as all-inclusive while its required privacy surcharge and environment remain unknown.

There is a concrete avoidable expense to resolve: T9 specifies one fresh development sourcing round per job after reusing existing results, but P3 prices two paid rounds per job. Choose the necessary scope and update the search-credit requirement and cost. Reuse existing outputs for the baseline where that comparison is valid.

The monthly database estimate of $40.80 becomes **$48.96 with the plan's required 20% margin**. It has little headroom within $50. Measure the actual second-look share and prompt size before asserting affordability; do not reduce routing just to fit the budget if doing so fails quality.

Present three separate amounts: incremental service usage, new cash purchases such as a Serper pack, and reviewer/implementation effort. For each paid stage, state the trigger, exact manifest, expected cost, maximum, and what happens on reaching the cap. Clearly distinguish prerequisites to a successful launch from optional experiments after a failure.

## Next handoff

Claude should apply these targeted corrections and return the amended P1 run card with evidence from free mocked checks. The rest of the protocol can be corrected alongside that preparation. No paid run, live copy, production change, credential change or contact is authorized by this review. The user must explicitly approve the final P1 scope and maximum before it runs.
