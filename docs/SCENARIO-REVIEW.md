# Scenario review — what can go wrong for a TA (draft for owner approval)

Status: **nothing tested yet, nothing changed, nothing published.** Every "suspected"
line below comes from reading the code (file:line), not from reproducing it.
Order = proposed testing order. Each scenario has: what the TA does, what *should*
happen (please confirm or correct this), what I suspect happens, how I will test it.

Test approach: Convex-level tests against the local Docker backend (127.0.0.1 only,
never api.career141.com). Today every test in `tests/` runs on the JSON store, so none
of the Convex paths below has any test.

---

## A. Excel Tables ⇄ TA shortlist ⇄ Database CVs

**A1. Two TAs press "Add to pipeline" / Shortlist on the same candidate**
- Should: first TA owns it; second gets "X already owns this", no second application.
- Suspected: `claimForTa` is atomic, but the row insert has no (job, candidate) uniqueness
  and dedupe reads a cache up to 30 s old → two applications, two owners, two follow-up streams
  (`store.ts:2151`, `commit.ts:99`).
- Test: fire two `commit.apply` inserts + two `shortlist` calls for one candidate/job.

**A2. TA moves a candidate Excel → pipeline → "Back to Excel Tables" → pipeline again**
- Should: lands back as Pending in Excel, then re-enters; same owner, same set, one application.
- Suspected: owner/set/`shortlistedAt` survive the move-back, so a *different* TA is blocked
  ("owns this"), moved-back people still count toward the 5-per-set rule, and an open
  interview is not cancelled (`actions.ts:1869-1885`).
- Test: run the cycle in Convex; assert owner, set, stage, stageCounts, interviews.

**A3. "Add to pipeline" half-fails (shortlist or move step errors)**
- Should: all-or-nothing, message matches state.
- Suspected: 3 separate commits; failure leaves an unowned TA Follow-up application while the
  row shows "Interested" and the toast says "Failed" (`actions.ts:1628-1735`).

**A4. Someone shortlists a person who is already at Director Review / Interview / Offer**
- Should: refused or no-op; stage never goes backwards.
- Suspected: Convex `claimForTa` yanks any unowned non-Follow-up stage back to Follow-up
  (`ta/applications.ts:171`); happens after `unshortlist` or an HH upload.

**A5. Stage moves from a stale page (new_cv → placed, interview with no interview)**
- Should: illegal moves and missing prerequisites refused.
- Suspected: backend `moveStage` bypasses the transition graph and prerequisites
  (`applications.ts:269`, `bypassRoleCheck:true`); only the JSON store/menu enforce them.

**A6. Reject / "Not interested" reason shows blank**
- Suspected: Convex path never writes `rejectReason`/`rejectedBy`; Rejected column and
  reports read those fields (`pipelineStateMachine.ts:161-168`).

**A7. Counters drift (stage counts, totals) after Excel→pipeline inserts and store moves**
- Suspected: Path-A inserts skip `adjustJobStageStat`; later moves decrement other people's
  counts. Moves via interview/offer/placement/assistant skip `stopFollowUpSequenceForApp`,
  so a dropped candidate can still get follow-ups.

**A8. Delete an Excel row whose person is on the pipeline** — loses the "Back to Excel" path.

**A9. Cron / re-upload overrides a TA's stage**
- Suspected: cron moves follow-ups to "unresponsive" with no reason (row then shows
  "Not interested", no Add button); `createApplication` resets Director Review+ to Matched
  (`applications.ts:395`) — see B1.

## B. CV intake / candidate falls back into "database CVs"

**B1. Same CV (or same person) uploaded again for the same job** — *highest impact*
- Should: existing application untouched.
- Suspected: manual/folder/database uploads force `currentStage="matched_candidates"`,
  silently demoting interview/offer/rejected people and un-rejecting; owner stays, so the
  card looks unclaimed but is locked (`applications.ts:395`). Mail intake already guards this
  (`mailIntake/process.ts:89`, 196 people hit on 17 Sep); manual path does not.

**B2. Same upload extracted twice at once** — upload flow + 2-minute cron both claim it;
  no lock (`cvExtraction.ts:1012`); double LLM spend, referees wiped and re-inserted.

**B3. Excel row (headhunted, no CV) vs the real CV arriving later** — two candidate records,
  Director Review blocked "needs a CV"; weak LinkedIn normaliser; a failed DB-match lookup is
  swallowed as "no match" (`cvMatch.ts`).

**B4. Same person, different phone/email format** — WhatsApp stub has no `phoneClean`; `0094…`
  and mixed-case emails are not matched; merge only when exactly one holder exists, so
  duplicates multiply.

**B5. Stuck uploads** — `pending/queued/paused` never recovered; retry loop unbounded
  (`extractionAttempts` never incremented); Cancel doesn't cancel; batch hangs on `needs_review`;
  HH/Scoop panel spins forever on `needs_review`.

**B6. Garbled-text CV dropped as "not a CV"** — real applicant silently vanishes; for an
  existing candidate an invoice/photo becomes a pipeline "candidate" (`cvExtraction.ts:919, 1550`).

**B7. Merge overwrites desk-confirmed data with an older CV** (`candidates.ts:497-556`).

**B8. Deleted candidate re-sent** — dangling `cvUploads` swallow the re-send or create an
  application pointing at nothing; `restoreAllCandidatesFromUploads` resurrects deleted people.

**B9. Totals and day boundaries** — `totalCandidates` never decremented (documented drift
  47k vs 77k); daily stats bucket on UTC (flips at 05:30 Colombo); `calendar.ts` uses host TZ
  and none is pinned in Docker.

## C. Several TAs on the same job

**C1. Two TAs press Send follow-up together** — candidate gets Day-0 template then an instant
  "reminder", burns attempt 2 of 3; no cooldown/expected-attempt check
  (`ta/followUp.ts:34`). *High: reaches real candidates.*

**C2. Non-owner acts on a colleague's candidate** — move/send/stop/recordCall check job access
  only, never owner; the lock lives in the app layer on a ≤30 s-old snapshot; email goes out in
  the owner's name.

**C3. Edit-form overwrite** — Review-details save replaces the whole notes array and writes
  salary/notice (even blank→null) from a stale form; on conflict it retries with the same stale
  values (`actions.ts:4047-4118`). A colleague's note is lost.

**C4. Note save conflict** — non-inline actions throw to the error page and the typed text is
  lost; cache not reset so "reload and retry" conflicts again.

**C5. EOD sent twice / by the wrong TA** — "already sent" check happens before the email,
  recorded after; two TAs or a double click email the Director twice; TA B can send TA A's list.

**C6. Same candidate on two openings by two TAs** — chased twice on one number; reply only
  attributed to the latest outbound.

**C7. Opening binned/closed while others work** — shortlist/move/send don't check bin status.

**C8. TA removed/deactivated** — their candidates stay locked to them.

**C9. HH upload by the losing TA** rewrites the winner's sourcing channel and adds a row.

**C10. Matching triggered twice**; one save blocks all TAs up to 30 s (single event loop).

---

## Proposed order
1. B1, C1, A4 (data/candidate-facing harm) → 2. A1, A2, A3, B2, C2, C5 → 3. the rest.

## What I need from you
For each scenario: **OK / not OK / change the expected behaviour**. Shortcut: "approve
all as written", or list the IDs to drop or change. After approval I will, per scenario,
write a failing test against the local Docker Convex, report the result, and only then
propose the fix — fixes stay local, on `hdbinath/opening-notes-visible`, nothing pushed.
