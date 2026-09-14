# Career141 TA Platform — stage one

Standalone build. **Not connected to the live system.** Runs entirely on synthetic
data, so nothing here can affect real candidates, clients or the production database.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:3100

## What "standalone" means

- **No Convex, no Clerk, no credentials.** Data lives in `.data/db.json`, generated
  from `src/data/seed.ts` on first run.
- **Dev auth** is the user switcher in the top right. Pick any TA, the TA Lead, the
  Director or Ops to see how the app looks to them.
- **Reset the data** by deleting `.data/` and reloading.

## Synthetic data

Client names (Delmo, CKDL, Apex, Lanka Hospitals), position titles and TA first names
come from the real workbooks so the app is recognisable.

**Every candidate is invented** — names, emails (`@example.invalid`), phone numbers and
LinkedIn URLs. No real candidate's data appears anywhere, and none should ever be added.
This dataset exists so the platform can be tested without touching real people's data.

## Built so far (spec phase 1)

| Area | State |
| --- | --- |
| Client → Opening → Job Post | Working — many posts under one Opening, one candidate pool |
| Pipeline board | Working — Follow-up → … → Placed, plus Rejected and Dropped out |
| Shortlist collision lock | Working — first to shortlist owns; other TAs see it, locked |
| Sets | Working — five or more closes a set, per Opening |
| Alias keywords + routing aliases | Visible on the Jobs tab |
| Priority tiers P1–P5 | Driving the "day N of target" counters |
| Link vault | Working — eye-marks and yield |
| Alerts | Urgent vs routine split |
| Intake, snippets, prepared CVs, EOD email | Not yet — phases 2–5 |

## Where the connection happens later

Everything reads through `src/data/store.ts`. Phase 8c swaps that file's internals for
the live Convex deployment; nothing above it changes. See `../docs/BUILD-SPEC.md` §15.
