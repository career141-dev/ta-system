# Midday emails

Each TA/TA Support user has numbered midday drafts per opening and Colombo
calendar day. Midday needs a confirmed ChatGPT share link but no completed
tasks. Each send contains the remaining unsent Director Review candidates and
the cumulative daily effort table. Empty sends are activity summaries.

One original EOD closes new submissions for that sender/opening/day. Corrections
reuse its candidate roster and review round, including after the workday ends.
Changing work mode does not require another original EOD. Sent midday emails
are read-only. Draft edits use optimistic revisions; conflicting tabs must reload.

## Release

Deploy the backend and app together using the production release pipeline.
The additive `dailyEmails` and `dailyEmailPolicy` tables need no historic-data
backfill. Existing mail receipts without a submission type count as EOD.

Use the pipeline's `run_function` input for
`ta/dailyEmails:enableRequirement`, first with `run_args` `{"dryRun":true}`.
After reviewing its output, run through the same pipeline with
`{"dryRun":false}`. This saves the next Colombo calendar day as the first day
that requires midday before EOD and Finish. Repeating the function preserves
the saved date. Before activation, midday is available but not compulsory.
Never run this function from a laptop against production.

## Recovery and retention

The backend reserves sends before calling Microsoft Graph. Accepted mail is
recorded with its exact HTML, recipient result, attachment names, and candidate
IDs in one transaction. A second acknowledgement cannot create another round.
No PDF attachment bytes are retained in the history.

If the provider outcome is uncertain, do not retry. The opening's TA Lead or an
admin verifies the sending mailbox, records a message reference/reason, and
reconciles from Today's Checks or the saved email. A verified send finalizes the
original snapshot without sending again; verified failure permits a retry.

The existing copy-cleanup cron also clears daily email content after 31 days.
Corrections share the original's expiry. Basic submission records remain for
numbering, duplicate prevention, and audit. Unresolved sends retain their
recovery payload until reconciled.

## Local validation

`npm test`, `npx tsc --noEmit -p .`, and `npx tsc --noEmit -p convex`.
`tests/dailyEmails.test.ts` exercises real Convex handlers with a synthetic
database and no email transport. Browser verification uses the local backend
and `deploy/local/start-app.sh`; do not point the app at production.
