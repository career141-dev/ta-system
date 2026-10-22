# Work locations, L-sheets and daily emails

One job can have several work locations. For example, Mumbai needs two people
and Delhi needs one: the job has three vacancies, two location workspaces and
two EOD emails. The existing job team and TA permissions still apply.

## Setting up a job

On New opening, enter the cities and vacancy counts under Work locations &
vacancies, after Gender and before Assign to. Add as many rows as needed. The
total is calculated. Edit the same rows through Edit the details on the job.

Existing jobs keep their original workflow until someone explicitly uses
Set up location L-sheets and EOD emails in Edit the details. Existing headcount
is never divided between cities automatically. Location IDs survive renaming
and reordering; archive saved locations instead of removing them. Finish active
workdays before archiving their locations.

## Working candidates

Select a location above Excel Tables or the pipeline. Each location has its own
TA-specific L1, L2 and subsequent sheets. Adding a profile within a selected L
uses that L. Rename/delete applies only to that TA and location; deleting a
sheet preserves its rows under All.

The extension (0.3.0) also offers a location picker. Reload the updated extension
files to use it. CV uploads retain their chosen location throughout extraction.
Other sources and old extension copies that cannot identify a location keep
their records visibly under Location not assigned. Review those records, then
use Save location or select up to 25 rows and Assign selected to location.
Production assignment updates the application and its linked sourcing rows in
one transaction, preserves source batches as imported L-sheets, and logs the
change. A candidate already sent for review cannot be moved through this control.
Bulk assignment reports any refused records; successful candidates remain saved.

## Sending daily emails

Choose the location on Midday email or End of day. The subject, candidates,
activity counts, workbook and CVs follow that selection. The four-column
workbook layout, TA/level tabs, status sections and colors are unchanged.
Browser drafts are separate by TA, job, location and date. Each location also
has independent server-side midday drafts, send status and duplicate protection.
History retains the location name used when the email was sent.

Configured locations may send an activity-only EOD when there are no new CVs.
Existing job setup/research checks still apply. If midday is required, each
location needs its own midday email. All required locations must finish EOD
before the job is marked submitted or its attendance clock can close.
Required locations are recorded when the job joins the workday; a location
added afterwards begins its daily submissions the next day. Older open
workdays without a location snapshot adopt the active locations on first send.

Sending/uncertain email results prevent retries within that location. A legacy
unknown-location result must be reconciled before any location can send. No
production data is backfilled by this release. Deployment and any later data
migration must use the existing release pipeline.
