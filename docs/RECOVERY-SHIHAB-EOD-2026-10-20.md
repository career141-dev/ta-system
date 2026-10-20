# Shihab's early EOD on 20 October 2026

This release includes `admin/reopenShihabEarlyEod:run`, scoped to
`shihab@career141.com` and opening `m17bhyypymgftktd7cv3w7sjfh8gkyst`.
It does not send email. It keeps the accepted EOD, receipt, review round,
attachments and actual send time. It marks that first send as reopened for
today's submission checks and reopens the workday. The original remains in
the email history. Its Director Review candidates become available again.

Use the production release pipeline's `run_function` and `run_args` inputs:

1. Release the code, then run `admin/reopenShihabEarlyEod:run` with
   `{"dryRun":true}`. Check the user, opening, workday, email, receipt, round,
   candidate IDs and accepted time against the reported incident.
2. If those records match, run the same function through the pipeline with
   `{"dryRun":false}`. A second write refuses to run.
3. Refresh Shihab's workday and opening. Confirm Midday can be started and the
   Director Review candidates appear in the EOD list. Shihab must send the
   midday email and then the new EOD manually.

The function refuses to run after the Colombo calendar day changes, if the
original received a Director decision, or if any of its candidates changed
owner or stage. The dry-run summary lists other accepted EODs on the same
workday; those records are preserved and do not stop this opening's repair.
A failed dry run needs a new review; do not bypass its guards.
