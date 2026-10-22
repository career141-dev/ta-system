/**
 * Excel Tables sheets and filters (22 Oct): a sheet is one person's, the
 * lowest free number is taken again, a deleted sheet's links are in Not in a
 * sheet and can be put back with Undo, links filter by the Sri Lanka day, and
 * times read in Sri Lanka and in the TA's own clock. Uses the same store calls
 * the actions make, on a disposable seed.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-link-sheets-"));
process.chdir(tmp);
const { repo, LINK_LEVEL_UNDO_MS } = await import("@/data/store");
const { NO_SHEET, colomboDay, dayLabel, inDay, inSheet, levelParam, readDay, readLinkFilters, sheetOwner } = await import("@/lib/linkViews");
const { colomboDateTime, clockAt } = await import("@/lib/format");
const { readWorkCountry, workTimeZone } = await import("@/lib/countries");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const [hassan, thushini] = repo.users().filter((u) => u.role === "ta");
const o = repo.openings()[1];
let k = 0;
const add = (who: string, level?: number) => repo.addLink(o.id, `https://www.linkedin.com/in/sheet-test-${k++}`, who, `Person ${k}`, "shortlisted", undefined, level);

console.log("\nA sheet is one person's");
eq("a TA's tabs are their own", sheetOwner(hassan.id, false, ""), hassan.id);
eq("a lead on Everyone has no sheets to show", sheetOwner("lead", true, ""), "");
eq("a lead who picks Hassan sees Hassan's", sheetOwner("lead", true, hassan.id), hassan.id);
eq("Hassan's L1 row is in Hassan's L1", inSheet({ addedBy: hassan.id, level: 1 }, 1, hassan.id), true);
eq("Thushini's L1 row is not in Hassan's L1", inSheet({ addedBy: thushini.id, level: 1 }, 1, hassan.id), false);
eq("a row in no L is in Not in a sheet", inSheet({ addedBy: hassan.id, level: null }, NO_SHEET, hassan.id), true);
eq("a row in L2 is not", inSheet({ addedBy: hassan.id, level: 2 }, NO_SHEET, hassan.id), false);
eq("All holds every row", inSheet({ addedBy: thushini.id, level: 3 }, 0, hassan.id), true);
eq("no owner: an L in the address shows everything, never another person's L mixed in", inSheet({ addedBy: thushini.id, level: 3 }, 1, ""), true);
eq("Not in a sheet is level=none in the address", [levelParam(NO_SHEET), levelParam(2)], ["none", "2"]);
eq("and reads back", readLinkFilters({ level: "none" }).level, NO_SHEET);
eq("a bad level is every L", readLinkFilters({ level: "-5" }).level, 0);

console.log("\nThe lowest free number is taken again");
eq("Hassan's first + is L1", repo.addLinkLevel(o.id, hassan.id), 1);
const a = add(hassan.id);
eq("+ again is L2", repo.addLinkLevel(o.id, hassan.id), 2);
const b = add(hassan.id);
eq("deleting L1 moves its row out", repo.deleteLinkLevel(o.id, hassan.id, 1), 1);
eq("the row is in Not in a sheet", repo.linkEntry(a)!.level ?? null, null);
eq("the next + is L1 again", repo.nextLinkLevel(o.id, hassan.id), 1);
eq("+ makes it", repo.addLinkLevel(o.id, hassan.id), 1);
eq("L2 keeps its number and row", repo.linkEntry(b)!.level, 2);
eq("a link added now goes into the L started last", repo.linkEntry(add(hassan.id))!.level, 1);
eq("Thushini numbers her own from L1", repo.addLinkLevel(o.id, thushini.id), 1);
// A number some row still holds is not taken again.
repo.deleteLinkLevel(o.id, hassan.id, 2);
repo.updateLink(b, { level: 2 });
eq("a deleted L2 still held by a row stays retired", repo.nextLinkLevel(o.id, hassan.id), 3);

console.log("\nUndo a delete");
const l3 = repo.addLinkLevel(o.id, hassan.id);
const c = add(hassan.id, l3);
const d = add(hassan.id, l3);
eq("deleting L3 moves two", repo.deleteLinkLevel(o.id, hassan.id, l3), 2);
eq("it remembers which", repo.allLinkLevels(o.id, hassan.id)[l3 - 1].movedRows, [c, d]);
eq("Undo puts both back", repo.restoreLinkLevel(o.id, hassan.id, l3), 2);
eq("L3 is listed again", repo.linkLevels(o.id, hassan.id).some((l) => l.n === l3), true);
eq("its rows are in it", [repo.linkEntry(c)!.level, repo.linkEntry(d)!.level], [l3, l3]);
eq("Undo twice does nothing", repo.restoreLinkLevel(o.id, hassan.id, l3), null);
repo.deleteLinkLevel(o.id, hassan.id, l3);
const later = Date.now() + LINK_LEVEL_UNDO_MS + 1000;
eq("too late to undo", repo.restoreLinkLevel(o.id, hassan.id, l3, undefined, later), null);
repo.addLinkLevel(o.id, hassan.id);
eq("once its number is taken again it cannot be undone", repo.restoreLinkLevel(o.id, hassan.id, l3), null);
eq("another TA cannot undo it", repo.restoreLinkLevel(o.id, thushini.id, l3), null);

console.log("\nBy the Sri Lanka day");
const now = Date.parse("2026-10-22T06:00:00Z"); // 11:30 AM in Colombo
const lateNight = Date.parse("2026-10-21T19:00:00Z"); // 12:30 AM on 22 Oct in Colombo
eq("half past midnight in Colombo is that day", colomboDay(lateNight), "2026-10-22");
eq("so it is today, not yesterday", [inDay(lateNight, "today", now), inDay(lateNight, "yesterday", now)], [true, false]);
eq("yesterday afternoon is yesterday", inDay(Date.parse("2026-10-21T09:00:00Z"), "yesterday", now), true);
eq("six days ago is in the last 7 days", inDay(now - 6 * 86400000, "week", now), true);
eq("eight days ago is not", inDay(now - 8 * 86400000, "week", now), false);
eq("one date", [inDay(lateNight, "2026-10-22", now), inDay(lateNight, "2026-10-21", now)], [true, false]);
eq("any time", inDay(0, "", now), true);
eq("only known days are read", [readDay("today"), readDay("week"), readDay("2026-10-22"), readDay("soon"), readDay("2026-13-99")], ["today", "week", "2026-10-22", "", ""]);
eq("labels", [dayLabel(""), dayLabel("today"), dayLabel("week"), dayLabel("2026-10-22")], ["Any time", "Today", "Last 7 days", "22 Oct 2026"]);

console.log("\nTimes in Sri Lanka, and in the TA's clock");
eq("Sri Lanka time, whatever the server's zone", colomboDateTime(lateNight), "22 Oct, 12:30 AM");
eq("with the year on rows", colomboDateTime(lateNight, true), "22 Oct 2026, 12:30 AM");
eq("Pakistan is half an hour behind", clockAt(lateNight, workTimeZone("Pakistan").zone), "12:00 AM");
eq("India keeps Sri Lanka's clock", clockAt(lateNight, workTimeZone("India").zone), clockAt(lateNight, "Asia/Colombo"));
eq("unset is Sri Lanka", workTimeZone(null), { zone: "Asia/Colombo", label: "Sri Lanka" });
eq("only the three countries are read", [readWorkCountry("Pakistan"), readWorkCountry("pakistan"), readWorkCountry(null)], ["Pakistan", null, null]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
