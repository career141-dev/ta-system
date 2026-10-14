# Background TA alerts

The `ta-background-alerts` cron runs every five minutes on both cron registries,
including deployments with the CV platform crons disabled. It only writes in-app
records. It never sends mail or contacts candidates, directors or TA Leads.

## Release initialization

Deploy through the production release pipeline. Use its `run_function` input to
run `migrations/backgroundTaAlerts:initialize` with `run_args` set to
`{"dryRun":true}` first. Then run the same function through the pipeline with
`{"dryRun":false}`. No laptop commands against live are permitted.

Until initialization, these checks create no alerts. Initialization records one
rollout timestamp; repeated runs preserve it. Existing open jobs get a fresh
inactivity window from that timestamp. Director submissions sent before that
timestamp are excluded. No candidate, assignment, EOD receipt or old timestamp
is rewritten.

## Rules and operations

The window is 24 hours on eligible Colombo calendar days, skipping weekends and
the shared calendar's `HOLIDAYS` list (currently empty). It is not three shifts.
The scheduler may raise an alert shortly after the exact deadline; pagination
continues through all jobs, rounds and unresolved alerts using scheduled pages.

An application's database creation time is its arrival at this job. Source,
screening, candidate edits and stage moves do not affect that time. An assigned
TA's window starts at the latest of rollout, assignment and application arrival.
Legacy `assignedTaIds` seats with no assignment history remain eligible; revoked
assignment rows cannot fall back to a stale legacy list. Disabled users and
closed, on-hold or deleted jobs are excluded.

Successful director rounds with candidates are checked from their original send
time. One shortlist decision for a submitted candidate, including a manual
director shortlist stage entry after the send, satisfies the check. Empty or
held submissions are excluded. Resending the same round does not restart it.
Rejection of everyone still raises an alert telling the TA to contact their
named TA Lead outside the system. There is no automatic lead escalation.

One persisted incident per recipient owns one bell notification, created in the
same transaction. Reading does not resolve it. Resolved conditions disappear
from active views immediately when queried and are marked resolved by the next
sweep. Workday views show them separately from required checks, so they never
block starting, finishing or sending an EOD email.

After release, check cron/scheduled-function failures and verify with a safe
internal test job that due alerts appear in the bell, Alerts and workday panel.
Verify another sweep creates no duplicates and a new application/shortlist
removes the matching reminder. Fix scheduler failures through the release
pipeline; do not run functions directly against live from a laptop.
