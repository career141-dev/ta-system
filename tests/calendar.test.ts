import { HOLIDAYS, hasWorkingHours, isWorkingDay, workingHoursBetween } from "@/lib/calendar";

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
};

/** The original, hour by hour — the definition the fast version must match. */
function reference(from: number, to: number): number {
  if (to <= from) return 0;
  let hours = 0;
  const cursor = new Date(from);
  while (cursor.getTime() < to) {
    const next = Math.min(cursor.getTime() + 3_600_000, to);
    if (isWorkingDay(cursor)) hours += (next - cursor.getTime()) / 3_600_000;
    cursor.setTime(next);
  }
  return hours;
}

// Deterministic pseudo-random, so a failure reproduces.
let seed = 141;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const base = Date.UTC(2026, 0, 1);
const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

function sweep(label: string, n: number, maxDays: number) {
  let mismatches = 0;
  let example = "";
  for (let i = 0; i < n; i++) {
    const from = base + Math.floor(rand() * 400 * 86_400_000) + Math.floor(rand() * 3_600_000);
    const to = from + Math.floor(rand() * maxDays * 86_400_000) + Math.floor(rand() * 3_600_000);
    const want = reference(from, to);
    const got = workingHoursBetween(from, to);
    if (!close(want, got)) {
      mismatches++;
      example ||= `${new Date(from).toISOString()} → ${new Date(to).toISOString()}: want ${want}, got ${got}`;
    }
  }
  ok(`${label}: matches the hour-by-hour original on ${n} ranges`, mismatches === 0, example);
}

console.log("working hours");
ok("empty and reversed ranges", workingHoursBetween(10, 10) === 0 && workingHoursBetween(20, 10) === 0);
sweep("short ranges", 2000, 3);
sweep("long ranges", 400, 240);

HOLIDAYS.push("2026-03-10", "2026-04-14", "2026-06-01");
sweep("with holidays", 600, 120);
HOLIDAYS.length = 0;

const from = base;
const to = base + 200 * 86_400_000;
const t = performance.now();
for (let i = 0; i < 7000; i++) workingHoursBetween(from + i * 60_000, to);
const ms = performance.now() - t;
ok(`7,000 ranges of 200 days in well under a second (${Math.round(ms)}ms)`, ms < 1000);

console.log("the 24-hour question");
let disagree = 0;
for (let i = 0; i < 3000; i++) {
  const f = base + Math.floor(rand() * 300 * 86_400_000);
  const tt = f + Math.floor(rand() * 6 * 86_400_000);
  for (const n of [0, 1, 24, 48]) if (hasWorkingHours(f, tt, n) !== (reference(f, tt) >= n)) disagree++;
}
ok("hasWorkingHours agrees with counting in full", disagree === 0, `${disagree} disagreements`);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
