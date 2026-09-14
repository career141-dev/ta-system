# P1 run-card review

14 September 2026. Review of the current run card, revision 3 plan, runner, ledger, tests and frozen manifest. Only local inspection and synthetic mocked requests were performed. No provider requests, production operations or contact were initiated.

## Decision

The two-model P1 experiment is appropriately small and answers a useful development question. The durable separate ledger, pinned requests, de-identification work and explicit approval requirement are substantial improvements. Three verified implementation gaps remain before paid execution. Fix those directly; a complete plan rewrite or a new round of input preparation is unnecessary unless the prompt or inputs actually change.

## Verified locally

- All 57 checks in `tests/p1run.test.ts` pass when rerun.
- The current manifest hash is `a88ab586d5e2dcbccb159d4221cec023094e62c8cf0907e2ccf83f25407fd2ac`, matching the card.
- All 240 outgoing request hashes match that manifest.
- The manifest estimates $0.1935 provider usage and $0.2844 under its characters/3, 600-output-token assumption. These are estimates using the recorded prices, not an independent price or tokenizer verification.
- The laptop v3 output file held 14 rows at inspection. That is a file count, not a claim that the process is currently running or a prediction of completion time.
- I have not independently repeated the manual de-identification review of all CVs, confirmed provider-account settings, or rechecked endpoint availability.

## 1. Stop on a single-request reservation overrun

**Claim:** the run stops immediately if one request's confirmed charge exceeds its reservation.

**Actual behaviour:** `src/lib/p1Runner.ts` checks `ledger.state().overrun`, which is calculated in `src/lib/runLedger.ts` from the total committed cost versus the total run allowance. A charge can exceed its own reservation while the run continues.

**Free reproduction:** three synthetic requests each reserved $0.001; the mocked provider charged $0.002 per request; run allowance was $0.40. All three calls ran and `stopped` remained null. The existing test with the heading “a charge above the reservation stops the run at once” actually expects two calls and a total-allowance overrun.

**Required correction:** compare each confirmed charge with that attempt's reservation and persist an overrun stop condition before another call. A restart must not bypass the stop. Retain the actual charge rather than capping the recorded number.

**Acceptance test:** the example above must send exactly one request and mark the other two not run. A restart must send no additional requests until the stop is explicitly resolved under the approval policy.

## 2. Validate ledger contents, not just JSON syntax

**Claim:** a damaged record stops the run.

**Actual behaviour:** the ledger validates the opening record and JSON parseability but trusts the structure and values of later records. It does not reject invalid amounts, unknown record types or invalid reservation/settlement relationships.

**Free reproduction:** create a $0.30 reservation, close the ledger, and replace its `maxUsd` with JSON `null`. The ledger reopens successfully with committed spend of $0 instead of refusing to run.

**Required correction:** validate the schema and sequence of every record before accepting any ledger state. Amounts must be finite, nonnegative numbers; record types must be known; reservation keys must be unique; settlements and reconciliations must refer to existing reservations and valid transitions. Validate these same conditions before appending new records. Any invalid record stops execution without rewriting or resetting history.

**Acceptance tests:** malformed-but-parseable records such as null or negative amounts, missing fields, unknown types, duplicate reservations and settlements for unknown keys must be refused before any provider request. Keep the existing syntax-damage, missing-ledger and crash tests.

## 3. Validate answer structure and save complete results

**Claim:** invalid answers are reported, never dropped, and the results file has one final result per request.

**Actual behaviour:** any parsed JSON object is treated as an `ok` answer. A mocked response containing `{}` was marked `ok` for all three requests. Required gate fields, decision values and evidence structure are not checked. Separately, requests skipped after a stop are returned in memory but are not all saved to `results.jsonl`; the paid CLI prints only the stop and ledger summary.

**Required correction:** validate the specified answer schema and allowed values. An empty object, unknown decision or missing required gate is an invalid answer. Separately flag missing or unsupported evidence and contradictory gate/decision combinations in the evaluation; do not silently repair them into a successful result. Apply comparable validation to laptop results.

Write a final report containing every manifest request exactly once, including all `not_run` entries and stop reasons. An append-only attempt history can remain separate. The report should reconcile uncertain retry charges against the ledger rather than presenting only the last attempt's confirmed charge as the total.

**Acceptance tests:** `{}`, an unknown decision and a structurally incomplete answer must not be `ok`. After a failure or allowance stop, the saved final report must still cover all 240 manifest IDs with no duplicates or omissions. The continue-to-P2 rule must explicitly fail or be inconclusive for incomplete model coverage, even if early results happen to retain 15 positive candidates.

## Clarifications to retain in the final card

- Characters divided by three is a token estimate, not a proven upper bound for these model tokenizers. Do not call $0.2844 a guaranteed maximum. Verify a defensible token bound including prompt overhead, or clearly describe the reservation estimate and the provider-limit protection the user is approving. The single-request overrun stop remains necessary. A stop after a charge cannot undo that charge.
- Keep the same-day route check, dedicated limited key, completed comparable laptop baseline, spend reconciliation and explicit final-manifest approval as outstanding prerequisites. I did not complete them in this review.
- Tie the approval record to the reviewed runner version as well as the manifest. Hashes currently protect request contents and model settings; they do not freeze the runner's behaviour. Include candidate/job identifiers in request integrity checks so local result attribution cannot drift independently of the text hash.
- No need to rerun the laptop solely because ledger or reporting code changes. Rerun it if its actual prompt, inputs or generation settings change, and verify that its recorded configuration matches the final hosted comparison.

## Full-programme budget: separate from P1

Revision 3 now screens every person in each retrieval pool, up to 500 per job. The $48.96 monthly projection still assumes only 12,000 cheap assessments in total: 6,000 applicants plus 6,000 database assessments, equivalent to 100 database candidates per job. That may hold if measured pools average 100, but is not established by the revised policy. At 500 per job there would be 36,000 assessments before additional diagnostic work. Recompute the monthly estimate and P2/P5/P7 quotes from the actual pool manifests and measured routing share. This does not require delaying the small P1 comparison once its own safeguards pass.

The overall $17.15 / $26.40 table is explicitly illustrative and excludes unresolved items. Continue to describe it that way, not as an all-inclusive testing maximum.

## Next action

Return the three fixes with their free regression-test results and an amended run card. Then finish the already-listed prerequisites and request the user's specific approval for the final manifest and allowance. No paid execution or additional spending is authorized by this review.
