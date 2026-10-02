import { colomboDayLabel, colomboDaysBetween, colomboDayStart, groupByColomboDay } from "@/lib/calendar";
import { relDays } from "@/lib/format";

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
};

const H = 3_600_000;
/** An instant given as Colombo wall-clock time (UTC+05:30). */
const colombo = (y: number, m: number, d: number, h = 12, min = 0) => Date.UTC(y, m - 1, d, h, min) - 5.5 * H;
const now = colombo(2026, 9, 30, 15);

// Five sent today, three yesterday — the case the Director asked about.
type Item = { id: string; at: number };
const items: Item[] = [
  ...[9, 10, 11, 12, 13].map((h) => ({ id: `t${h}`, at: colombo(2026, 9, 30, h) })),
  ...[9, 10, 11].map((h) => ({ id: `y${h}`, at: colombo(2026, 9, 29, h) })),
];
const groups = groupByColomboDay(items, (i) => i.at);
ok("two days", groups.length === 2, `got ${groups.length}`);
ok("today first", colomboDayLabel(groups[0].dayStart, now) === "Today");
ok("today has five", groups[0].items.length === 5);
ok("yesterday second", colomboDayLabel(groups[1].dayStart, now) === "Yesterday");
ok("yesterday has three", groups[1].items.length === 3);
ok("newest first inside a day", groups[0].items.map((i) => i.id).join() === "t13,t12,t11,t10,t9");
ok("input order does not matter", groupByColomboDay([...items].reverse(), (i) => i.at)[0].items[0].id === "t13");

// Colombo midnight, not UTC midnight: 23:50 and 00:10 Colombo share a UTC date.
const late = colombo(2026, 9, 29, 23, 50);
const early = colombo(2026, 9, 30, 0, 10);
ok("same UTC date", new Date(late).toISOString().slice(0, 10) === new Date(early).toISOString().slice(0, 10));
ok("different Colombo days", colomboDayStart(late) !== colomboDayStart(early));
ok("00:10 is today", colomboDayLabel(early, now) === "Today");
ok("23:50 the night before is yesterday", colomboDayLabel(late, now) === "Yesterday");

// And the other way: 04:00 and 06:00 Colombo straddle UTC midnight but are one day.
ok(
  "one Colombo day across UTC midnight",
  colomboDayStart(colombo(2026, 9, 30, 4)) === colomboDayStart(colombo(2026, 9, 30, 6)),
);

// Older days are dated.
const older = colomboDayLabel(colombo(2026, 9, 28), now);
// en-GB writes "Sept" in newer ICU builds, "Sep" in older ones.
ok("older day is dated", /^Mon 28 Sept?$/.test(older), `got "${older}"`);
const lastYear = colomboDayLabel(colombo(2025, 12, 31), now);
ok("last year shows the year", lastYear === "Wed 31 Dec 2025", `got "${lastYear}"`);

ok("empty list", groupByColomboDay([], () => 0).length === 0);

// Calendar days difference & relDays
const todayMorning = colombo(2026, 9, 30, 9);
const yesterdayAfternoon = colombo(2026, 9, 29, 16);
const twoDaysAgo = colombo(2026, 9, 28, 11);

ok("colomboDaysBetween: today is 0", colomboDaysBetween(todayMorning, now) === 0);
ok("colomboDaysBetween: yesterday is 1", colomboDaysBetween(yesterdayAfternoon, now) === 1);
ok("colomboDaysBetween: 2 days ago is 2", colomboDaysBetween(twoDaysAgo, now) === 2);

ok("relDays: today is 'today'", relDays(todayMorning, now) === "today");
ok("relDays: yesterday afternoon is 'yesterday' even if < 24h ago", relDays(yesterdayAfternoon, now) === "yesterday");
ok("relDays: 2 days ago is '2d ago'", relDays(twoDaysAgo, now) === "2d ago");
ok("relDays: null is '—'", relDays(null, now) === "—");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
