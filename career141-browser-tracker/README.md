# Career141 TA Browser Tracker

TAs sign in using their Career141 email. Admins and TA leads view activity in
**TA Track**, with a TA selector, date filter, activity table and CSV export.
There is no pairing key to create, copy or paste.

## Setup

The app and Convex tracking functions/schema must be released together through the
repository release pipeline. Never deploy a live backend from a laptop.
For local testing use the local backend and local app only.

1. Load this folder using Load unpacked in chrome://extensions or edge://extensions.
2. Open the tracker and enter your Career141 email (you@career141.com).
3. For local testing expand TA system address and enter http://localhost:3100
   (or your local app's actual port). The default address is the deployed app.
4. Keep your TA website open in a tab, signed in with that same email.
5. Accept the sharing notice and choose Start tracking in the extension.
6. Tracking connects using that existing signed-in tab. No extra window opens.
7. Refresh already-open website tabs. Admins and TA leads can select your name
   in TA Track after the first uploads arrive.

The email must match the verified, active account in the TA system. Entering
someone else's email does not let a browser upload activity as that person.
The existing signed-in TA website tab verifies account ownership. If no matching
tab is open or the account differs, an error appears inside the extension. The extension never reads
or stores the email password. A private upload credential is generated and stored
automatically in the extension; only its hash is registered with the backend.
Only the credential hash is sent through the TA website tab; the private credential
stays in extension storage. No sign-in window or redirect callback is used. Browser
connections expire after 90 days and can be revoked at /ta-track/connect.

Pause stops collection. Starting again with the same account resumes without a
new sign-in until the browser connection expires or is disconnected. To change
accounts, pause first and sign in with the other Career141 email. Historical local
pilot data is not relabelled or uploaded under the new verified account. A previous
local snapshot is kept for recovery and pruned with the 30-day local retention.

## Timing and reports

Activity counts are batched every 15 seconds; timing checkpoints run on browser
events and every 30 seconds. Uploads retry about every 30 seconds while the browser
runs. The app refreshes every 30 seconds. Keep the website focused for 20 seconds
after clicking/scrolling before checking its report; switching away before the
content-script batch may lose counts.

Failed uploads remain locally for retry within the 30-day retention. Cumulative
snapshots replace earlier totals per browser/date/domain, so retries do not
duplicate counts. Previously collected data may still upload after pausing.
Reports combine independent browsers/devices; simultaneous usage can overlap.
Dates use Asia/Colombo. A scheduled server sweep removes activity older than
30 days. Reports and report APIs are restricted to admins and TA leads.

## Collection limits

Only HTTP(S) website domains, foreground/idle durations, click counts, scroll
bursts and seconds with mouse movement are collected. No messages, typed text,
screenshots, page titles, full URLs or cursor coordinates are collected. Tracking
excludes private windows, background tabs and time outside the browser. Restricted
pages and pages without permission may lack counts. The idle threshold is 60
seconds; reading/video may count as idle. Closed/disabled browsers cannot report.
Checkpoint gaps over 75 seconds are uncredited. This is not a productivity score.

## Local verification (Node 22+)

    node tests/run.mjs taTracking
    node node_modules/typescript/bin/tsc --noEmit -p .
    node node_modules/typescript/bin/tsc --noEmit -p convex

On a local backend, verify email sign-in, account mismatch rejection, Start/Pause,
offline retry, revocation and reports as both admin and TA lead. The TA website must already be signed in using the app's configured sign-in provider. No live credentials
are included in this folder.
