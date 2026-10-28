# Sameera's early EOD on 28 October 2026

Opening: Q COLLECTION (SL), Executive - Industrial Engineering,
`m17cw4va2wvhvc80bm9md3mbj98gc3c0`. Two TAs work on this opening.
This repair targets only Sameera's accepted original EOD and her workday.
It does not send email or alter the other TA's records. It preserves the
actual send time, retained email, receipt, attachments and review history.

After the pull request is reviewed, merged and released, use **Deploy
Production** workflow inputs `run_function` and `run_args`:

1. Run `admin/reopenSameeraEarlyEod:run` with `{"dryRun":true}`. Compare
   the returned user, opening, email, accepted time, receipt, review round,
   candidate IDs and other TA email list with the reported incident.
2. Only if every record matches, run the same function through the pipeline
   with `{"dryRun":false}`. A second write refuses to run.
3. Refresh Sameera's workday and opening. She can then use the normal
   Midday and EOD flow herself. The morning email remains in sent history.

The function expires at midnight Colombo time on 28 October. It refuses
if a candidate changed owner or stage, the Director responded, the email
was revised or unresolved sends exist. A failed dry run requires a new
review; do not bypass its checks.
