# Referee Calls — implementation plan

Status: planned, not built. Written 23 Oct 2026 for whoever implements it
(Codex or a developer). Read `AGENTS.md` first — every rule there applies.

## 1. What the desk asked for

When a TA has no phone number for someone they want to headhunt, they look for
people in our database who know that person (referees on CVs, or candidates who
worked at the same company), call them, and ask for the number. Today they keep
these calls in a separate sheet.

The Director wants to see these calls **inside the end-of-day email body** —
not as an attachment, not as an Excel file, and not as new columns in the
existing shortlist or effort tables.

The desk's own example of how it should look in the email:

- a **Positive – contacts available** box (light green) on top
- a **Not successful** box (light red) below
- both with the same columns: `# | Company | Referral | Contact Number | Feedback`

## 2. Decisions already made (owner, 23 Oct)

1. A new page **Referee Calls** in every job, in the left menu directly under
   **Excel Tables** (and its L1, L2… items).
2. The page looks and works like Excel Tables: a grid, type into cells, saves
   as you type, a `+` row at the bottom. No pop-up form.
3. Columns are the same for every job and every TA:
   **Company · Referral · Contact Number · Feedback.** "Company", not
   "Hospital", because jobs are in every industry.
4. The system fills in the date and the TA itself.
5. **The TA never picks a colour or a section.** The system decides Positive or
   Not successful from the Feedback text.
6. In the email, Positive is on top, Not successful below, light colours only,
   designed for the Director to read in Outlook and on a phone.
7. If the TA logged no calls that day, the section does not appear at all.
8. In the email preview the TA can move a row to the other box with one click,
   in case the system sorted it wrong.

## 3. Open questions — confirm with the owner before step 4

- **Person's name column.** The desk's first sheet had the person being
  searched for ("Medihelp – Rangika"); the second picture has only the
  company. Default in this plan: an optional `lookingFor` field stored on the
  row, **not shown** as a column until the owner says so.
- **Phone numbers in the email.** Default: shown in full, as in the desk's
  picture (the email goes only to career141.com addresses).

## 4. How it fits the existing code

| Area | Where it lives today | What to look at |
|---|---|---|
| Left menu of a job | `src/components/ProjectSidebar.tsx` — `hhItems` (~line 167) | add the new item after Excel Tables |
| Excel Tables page (the model to copy) | `src/app/openings/[id]/hh/links/page.tsx` | grid layout, location scoping, who sees whose rows |
| Excel Tables data | `linkVault` table in `convex/schema.ts`; store in `src/data/store.ts`; mapping in `convex/ta/model/tables.ts` | mirror how `linkVault` is wired end to end |
| Server actions | `src/app/actions.ts` (`authorize(formData, "opening.act", …)`) | same auth pattern |
| End-of-day email HTML | `eodEmailHtml` in `src/lib/eod-format.ts` (~line 319) | add a third section |
| Sending the EOD | `sendEod` path in `src/app/actions.ts` (~line 4990) | pass today's calls into the HTML and the snapshot |
| EOD composer / preview | `src/components/EodComposer.tsx`, `src/app/openings/[id]/eod/page.tsx` | show the section, the include tick box, the move button |
| What was sent (history, revisions) | `DailyEmailSnapshot` in `src/lib/dailyEmail.ts`; `eodEmailCopies` in `convex/schema.ts`; `SentEmail` in `eod/page.tsx` (~line 612) | store the calls with the email so a revision and the history show what went |
| Work day date | `workdayDate` in `src/lib/workday` | the "today" of a call |
| Tests | `tests/*.test.ts`, run by `npm test` | add `tests/refereecalls.test.ts` |

Nothing here sends anything to a candidate or referee. The TA phones people
themselves; the system only records what they write. `outreachSafety` /
`outboundGuard` are not involved, and must not be called or bypassed.

## 5. Build steps

Do them in order, one pull request per step if possible. Run the checks in §7
before every push.

### Step 1 — the table

Add `refereeCalls` to `convex/schema.ts`:

```ts
refereeCalls: defineTable({
  openingId: v.id("jobs"),
  workLocationId: v.optional(v.string()),
  addedBy: v.id("users"),
  /** The work day (YYYY-MM-DD, lib/workday workdayDate) the call belongs to. */
  date: v.string(),
  company: v.string(),
  referral: v.string(),
  contactNumber: v.optional(v.string()),
  feedback: v.string(),
  /** Who they were trying to reach; stored, not shown yet (§3). */
  lookingFor: v.optional(v.union(v.string(), v.null())),
  /** Set only when the TA moved the row in the preview; otherwise the
   *  feedback decides (lib/refereeCalls classifyFeedback). */
  result: v.optional(v.union(v.literal("positive"), v.literal("negative"), v.null())),
  /** The database person called, when picked from a suggestion. */
  refereeId: v.optional(v.union(v.id("referees"), v.null())),
  candidateId: v.optional(v.union(v.id("candidates"), v.null())),
  createdAt: v.number(),
  updatedAt: v.number(),
})
  .index("by_opening", ["openingId"])
  .index("by_opening_user_date", ["openingId", "addedBy", "date"]),
```

Then wire it everywhere `linkVault` / `eodEmailCopies` are wired, so the app
can read and write it. Grep for `eodEmailCopies` and follow each hit:

- `convex/ta/model/tables.ts` — add to `TABLES`
- `convex/ta/tables.ts` — add to `WHOLE`
- `convex/ta/commit.ts` — add to the work tables if `linkVault` is there for the same reason
- `src/data/types.ts` — a `RefereeCall` type
- `src/data/store.ts` — empty array in the initial db, the per-opening filter
  used when an opening is deleted (~line 611), and repo methods:
  `refereeCalls(openingId, { userId?, date?, workLocationId? })`,
  `addRefereeCall`, `updateRefereeCall`, `removeRefereeCall`
- `convex/ta/openingDelete.ts` — delete its rows with the opening
- `convex/ta/testSweep.ts` — include it in the test sweep list

This is a new table with no existing rows, so no data migration is needed.

### Step 2 — sorting Positive / Not successful

New file `src/lib/refereeCalls.ts`, pure functions, no I/O:

```ts
export type CallResult = "positive" | "negative";
export function classifyFeedback(feedback: string): CallResult;
export function resultOf(call: { feedback: string; result?: CallResult | null }): CallResult;
```

Rules (deterministic — no AI call, so the same words always land in the same box):

1. **Check negatives first.** If the feedback matches any of these, it is
   *negative*: no contact(s), no number, no answer, not responding / not
   answering, wrong number, overseas / abroad, not available, cannot / can't
   give, refused / declined, switched off, not reachable.
   This keeps "At the moment I have no contacts, if I have any will share"
   negative even though it contains "will share".
2. Otherwise *positive* if it matches: have a contact, will share, will
   send, will WhatsApp, will call back, will pass (the number / my number),
   number received / given / shared, interested.
3. Anything else → **negative** (it is not a contact yet). The TA can move it in
   the preview.
4. `resultOf` returns `call.result` when the TA moved the row, otherwise
   `classifyFeedback(call.feedback)`.

Case-insensitive. Use the desk's real examples (§8) as the test cases.

### Step 3 — the Referee Calls page

- **Menu:** in `ProjectSidebar.tsx`, add
  `{ href: \`${base}/hh/referees\`, label: "Referee Calls" }` after the Excel
  Tables item in `hhItems`. It must sit below Excel Tables' L-items.
- **Page:** `src/app/openings/[id]/hh/referees/page.tsx`, modelled on
  `hh/links/page.tsx` (same access rules, same work-location scoping).
- **Grid:** columns `# | Company | Referral | Contact Number | Feedback`, plus a
  small grey "TA" column only when the viewer can see more than their own rows.
  - The `+` row at the bottom adds a row; typing saves (debounced) through
    server actions in `src/app/actions.ts`: `addRefereeCall`,
    `updateRefereeCall`, `removeRefereeCall`, all behind
    `authorize(formData, "opening.act", { opening: "openingId" })`.
  - Company: if left empty on a new row, copy the company from the row above
    (the desk types many referees for the same company).
  - Feedback: free text, with a dropdown of common answers to speed typing:
    No answer · Not responding · No contacts available · Wrong number ·
    Currently overseas · Will call back · Will send on WhatsApp ·
    Has a contact, will check and share · Number received.
  - No colour picker, no Positive/Negative control on this page.
- **Who sees what:** a TA sees and edits their own rows. A lead / director /
  admin sees every TA's rows on the job, read-only, with the TA's name. Follow
  the same role checks Excel Tables uses (`src/lib/auth.ts`).
- **Day picker:** "Today" by default; a select for earlier days.
- Copy is plain and active: "Saved", "Could not save — try again".

### Step 4 — the section in the end-of-day email

In `src/lib/eod-format.ts`:

- Add an optional input to `eodEmailHtml`:
  `refereeCalls?: { company: string; referral: string; contactNumber: string; feedback: string; result: "positive" | "negative" }[] | null`
- Render it **after the effort table and before the research link**, only
  when the array is non-empty:
  - heading `Referee calls` (13px, bold)
  - box 1 **Positive – contacts available**, then box 2 **Not successful**;
    a box with no rows is left out
  - each box: a header bar with a light background, then a table with
    `# | Company | Referral | Contact Number | Feedback`, numbered from 1 in each box
  - inline styles only (mail clients drop `<style>`), reuse the `th` / `td`
    styles already in the function. Suggested light colours:
    - Positive: header `background:#e8f5ec;color:#1b5e36;border:1px solid #b7dcc4`
    - Not successful: header `background:#fcebea;color:#8a1f1b;border:1px solid #f0c4c1`
    - row cells stay white
  - escape every value with the existing `esc`

In the send path (`src/app/actions.ts`, the EOD send ~line 4990):

- Load the sender's calls for this opening, this work location and today's
  work day (`workdayDate(Date.now())`), unless the TA unticked the section.
- Pass them to `eodEmailHtml`, already resolved to `result` (`resultOf`), with
  any preview moves applied.
- Save them on the email so revisions and the sent-email view show exactly what
  went: add `refereeCalls?` to `DailyEmailSnapshot` (`src/lib/dailyEmail.ts`)
  and an optional `refereeCalls: v.optional(v.any())` to `eodEmailCopies`
  (`convex/schema.ts`), and pass it in `SentEmail` (`eod/page.tsx`).
- A revised email (`parentId` set) reuses the parent's saved calls unless the
  TA changes them — the same way it reuses `rows` today.

In the composer (`src/components/EodComposer.tsx`):

- Show the section in the live preview exactly as it will be sent.
- A tick box **Include referee calls (N)**, ticked by default when N > 0,
  hidden when N = 0.
- On each row in the preview, a small "Move to Not successful" /
  "Move to Positive" link. A move saves `result` on that call, so the page and
  the next email agree.
- Midday email: not in scope — do not add the section there.

### Step 5 (later, not now)

- Suggest people to call: on the page, a "Find people at <company>" button that
  uses the existing Referral Search (`convex/ta/referenceSearch.ts`) and fills
  Referral and Contact Number when the TA picks one (sets `refereeId` /
  `candidateId`).
- Show "Called today by <TA> — No answer" next to a referee another TA already
  called.
- When feedback is "Number received" and `lookingFor` matches an Excel Tables
  row, offer to put the number on that row.

## 6. Out of scope / must not change

- The shortlist table, the effort table and their columns.
- Excel Tables rows and columns.
- Attachments (CVs stay the only attachments; no Excel file).
- Any outbound message to a referee or candidate.
- No running anything against the live backend; it ships through the normal
  pull request and release pipeline.

## 7. Checks before every push

```bash
npm test
npx tsc --noEmit -p .
npx tsc --noEmit -p convex
```

Run locally with `deploy/local/start-app.sh` and try it by hand:
add calls on the Referee Calls page, open End of day, check the preview,
untick and re-tick the section, move a row, send to the test inbox.

Before writing any page code, read the relevant guide in
`node_modules/next/dist/docs/` — this Next.js version differs from older ones.

## 8. Tests to add (`tests/refereecalls.test.ts`)

Classifier, using the desk's own words:

| Feedback | Expected |
|---|---|
| Have a contact, first i have to check if the person is interested and if yes will share you the contact. | positive |
| He said he cannot give his number, but he will pass this number to him and if he is okay then he will call back | positive |
| will find the number and whatsapp me | positive |
| No contacts available | negative |
| At the moment i have no contacts, if i have any contacts will share. | negative |
| No answer | negative |
| Not responding | negative |
| Wrong number in the database, could not find his linkedin. | negative |
| Currently overseas | negative |
| Previously worked in nawaloka, no contact available | negative |
| (anything unrecognised, e.g. "spoke to him") | negative |

`resultOf` returns the TA's move when `result` is set.

Email HTML:

- no calls → the output has no "Referee calls" text (today's emails unchanged)
- only negatives → no Positive box
- both → Positive appears before Not successful; each box numbered from 1
- a value with `<script>` is escaped
- existing `eodEmailHtml` tests still pass unchanged

## 9. Done when

- Every job shows **Referee Calls** under Excel Tables, with the same four columns.
- A TA can type calls like in Excel and they are saved.
- The end-of-day email shows Positive on top and Not successful below, light
  colours, in the body — and nothing at all on a day with no calls.
- The TA can untick the section or move a row in the preview.
- The sent-email history and a revised email show the same calls that went.
- All checks in §7 pass.
