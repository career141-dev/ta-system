# Referee Calls — make the grid work like Excel

Status: planned, 23 Oct 2026. Follows PR #259 (Referee Calls, now live).
Read `AGENTS.md` first. One pull request.

## 1. What is wrong today (desk testing, 23 Oct)

1. **A row locks after the first cell.** A TA types the Company, the row saves
   itself, and the row turns read-only, so Referral, Contact Number and
   Feedback can no longer be typed.
   Cause: `src/components/RefereeCallsGrid.tsx`
   `const mayEdit = mine && (row.draft || calls.some((call) => call.id === row.id));`
   After the first save the row is no longer a draft, but its new id is not in
   the `calls` prop yet, so `mayEdit` is false and the inputs become text.
2. **It saves too early.** A row is saved the moment one cell has text, so
   half-typed rows reach the database and the end-of-day email.
3. **No free editing.** The TA cannot go back and change any cell they want,
   select several cells, or paste a block copied from Excel.
4. **The real error is hidden.** Every failure shows "Could not save — try
   again", even when the server said why (for example "Start your workday
   before continuing recruitment work.").

## 2. What the desk wants

The whole table is one editable sheet, like Excel:

- Click any cell, any row, any time, and type. No row ever locks.
- Move with the keyboard: arrows, Tab / Shift+Tab, Enter (down).
- Select cells: click and drag, or Shift+click / Shift+arrows, to select a
  block. Click a row number to select the row; click a column heading to
  select the column.
- **Copy and paste** like Excel:
  - Ctrl/Cmd+C copies the selected block as tab-separated text (pastes straight
    into Excel or Google Sheets).
  - Ctrl/Cmd+V pastes a block copied from Excel / Google Sheets / their old
    sheet, starting at the active cell. Extra lines add new rows. Columns past
    Feedback are ignored.
- Delete / Backspace clears the selected cells. A row's **Remove** (or
  selecting rows and pressing a "Remove selected rows" button) deletes rows.
- **+ Add row** adds an empty row at the bottom; pasting below the last row
  also adds rows.
- Nothing is sent while typing. A **Save** button saves everything at once.
  - The button shows the number of changes: "Save (3 changes)"; disabled when
    there are none.
  - Rows that are completely empty are not saved (and an empty row that was
    saved before is removed on Save).
  - Ctrl/Cmd+S also saves.
  - Leaving the page with unsaved changes asks first (`beforeunload`).
  - Changed cells have a light highlight until saved.
- After saving, "Saved" next to the button. On failure, the server's own
  message, e.g. "Start your workday before continuing recruitment work." —
  never only "Could not save".

Managers (admin, director, lead, ops, TA Support) keep the same table
read-only, with the TA column, but can still select and **copy** cells.
Only the TA who logged a call edits it — no change to who can edit.

## 3. How to build it

### 3.1 One save action for the whole table

In `src/app/actions.ts`, replace the per-cell use of `addRefereeCall` /
`updateRefereeCall` / `removeRefereeCall` from the grid with one action:

```ts
export async function saveRefereeCalls(formData: FormData): Promise<ActionResult & { calls?: RefereeCall[] }>
```

- Form fields: `openingId`, `workLocationId`, `day` (must be today's work day),
  and `changes` = JSON:
  `{ add: {key, company, referral, contactNumber, feedback}[],
     update: {id, company, referral, contactNumber, feedback}[],
     remove: string[] }`
- Same checks as the current actions: `primeStore`, `authorize(…, "opening.act",
  { opening: "openingId" })`, `isTa(user)`, `requireWorkLocation`, each
  updated/removed row must belong to this opening and `addedBy === user.id`,
  the same length limits (company/referral 200, contact 100, feedback 2000),
  JSON size cap (e.g. 200 KB) and at most 300 rows per save.
- Skip rows whose four fields are all blank.
- Do all of it inside **one** `mutate` so it is one Convex commit — all saved or
  none (add a `repo.saveRefereeCalls(openingId, userId, changes)` in
  `src/data/store.ts` that does the adds, updates and removes in one
  `mutate`).
- Return the opening's calls for that user/day/location after the save, with
  real ids, so the grid replaces its rows (and drafts get their ids).
- Keep `updateRefereeCall` for the end-of-day preview's "Move to …" button
  (`RefereeCallsEmailSection.tsx`); the old add/remove actions can go if
  nothing else uses them.

### 3.2 The grid

Rewrite `src/components/RefereeCallsGrid.tsx` as a client-side sheet. No new
npm dependency is needed; a `<table>` with one `<input>` per cell (or
contentEditable-free inputs) plus a selection model is enough.

State:
- `rows: { key, id?, company, referral, contactNumber, feedback }[]` — `key`
  is stable (`id` or a local draft key).
- `saved: Map<id, row>` — what the server holds, to work out what changed.
- `active: {r, c}` and `selection: {r1, c1, r2, c2}`.

Editing rule (the fix for the lock): a row is editable when the viewer is a TA
and (`!row.id` or the row's `addedBy === actorId`). Never look the row up in
the `calls` prop.

Paste handler (on the table, `onPaste`): read `text/plain`, split lines on
`\r?\n` (drop one trailing empty line), cells on `\t`; write into the grid from
the active cell, adding rows as needed; cap at 300 rows; trim each value.
A single value with no tab/newline pastes into the active cell as normal
typing would.

Copy handler (`onCopy`): if a block is selected, put the block as TSV on the
clipboard and `preventDefault()`.

Changes for Save:
- `add` = rows without an id that have any text
- `update` = rows with an id whose text differs from `saved`
- `remove` = ids in `saved` that were removed from the grid, or now fully blank

Feedback cell keeps the dropdown suggestions (`<datalist>` with the current
`ANSWERS`).

Show "Save" only for the TA and only on today's work day; earlier days stay
read-only (as now).

### 3.3 Page

`src/app/openings/[id]/hh/referees/page.tsx` — pass the day and keep the
existing access rules. Change the help text to:
"Type or paste the calls, then click Save. The end-of-day email sorts them
into Positive and Not successful from the Feedback."

## 4. Tests

- A pure helper `src/lib/refereeGrid.ts` with:
  - `parsePastedBlock(text)` → string[][] (tabs, CRLF, trailing newline,
    quoted cells from Excel with a tab or newline inside are kept whole)
  - `applyPaste(rows, at, block)` → rows (adds rows, ignores columns past 4)
  - `diffRows(saved, rows)` → `{add, update, remove}` (blank rows skipped or
    removed)
- `tests/refereegrid.test.ts` for those, including: paste 3×4 block from row 2;
  paste 6 columns (extra ignored); paste past the last row adds rows; a row
  edited back to its saved text is not an update; a saved row cleared to blank
  is a remove.
- Existing `tests/refereecalls.test.ts` still passes.

## 5. Checks before pushing

```bash
npm test
npx tsc --noEmit -p .
npx tsc --noEmit -p convex
```

By hand on a local run (`deploy/local/start-app.sh`), as a TA with the
workday started and the job added:
1. Type Company in row 1, then Referral, Contact, Feedback — nothing locks.
2. Add three rows, go back and change row 1 — works.
3. Copy 4 rows × 4 columns from Excel, paste in row 1 — fills and adds rows.
4. Select a block, Ctrl+C, paste into Excel — same cells.
5. Click Save — "Saved"; reload — same rows.
6. With the workday not started, Save shows "Start your workday before
   continuing recruitment work."
7. Open End of day — the saved calls are in Positive / Not successful.
8. As a lead: table read-only, copy works, no Save.

## 6. Do not change

The end-of-day email section, the classifier, who can see or edit calls, the
`refereeCalls` table, Excel Tables.
