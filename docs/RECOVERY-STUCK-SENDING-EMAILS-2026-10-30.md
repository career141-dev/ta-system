# Two EOD emails stuck in "sending" (30 October 2026)

Priya's 23 Oct email on Q COLLECTION (SL) Industrial Engineering and Sameera's
29 Oct email on PGP Head of Manufacturing Excellence never got a result and sat
in `sending`, so each sender was refused with "still sending or needs
reconciliation". The owner confirmed neither reached the Director.

After the pull request is merged and released, use **Deploy Production**
inputs `run_function` and `run_args`:

1. `admin/failStuckSendingEmails:run` with `{"dryRun":true}`. Check the two
   emails, senders, openings and candidate counts.
2. Only if they match, run it again with `{"dryRun":false}`. It marks both
   emails and their receipts failed. It sends nothing and refuses if either
   email is no longer in `sending`.
3. The senders can then send their EOD again.

The cron change in the same release (`flagStuckSends`) flags any future send
stuck over 15 minutes as `uncertain` for the TA Lead to reconcile.
