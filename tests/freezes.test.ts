/**
 * The 29 Oct freezes: reads that repeated on a timer and grew with the data.
 *
 *   - "too many system operations" is a budget refusal, not a blip to retry.
 *   - The bell does not re-prime 30 whole tables on every poll.
 *   - Notifications read the newest rows from the index, not every row ever.
 *   - A closed workday drawer does not poll.
 *   - A failed keyword search is reported, and an incomplete answer is not cached.
 *   - Graph notifications schedule one mailbox read, not one per message.
 */
import fs from "node:fs";
import path from "node:path";
import { failureCategory } from "../src/lib/convexResilience";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

eq("system-operations refusal is not retried",
  failureCategory("Your request timed out performing too many system operations.", false, 500), "budget");
eq("a gateway timeout still is", failureCategory("Convex refused x: HTTP 504", false, 504), "transient");

const bell = read("src/app/api/notifications/route.ts");
eq("the bell primes only a cold store", /if \(!primed\(\)\) await primeStore/.test(bell) && !/^\s*await primeStore\(\{\}\);/m.test(bell), true);

const notes = read("convex/ta/notifications.ts");
const list = notes.slice(notes.indexOf("export const listForUser"), notes.indexOf("export const markRead"));
eq("notifications are read newest-first and capped", list.includes(".order(\"desc\")") && list.includes(".take("), true);
eq("notifications are not collected whole", list.includes(".collect()"), false);

const workday = read("src/components/Workday.tsx");
eq("the lead drawer polls only when open", workday.includes("<WorkdayDashboard active={open} />"), true);
eq("the TA rail polls only when shown", workday.includes("<WorkdayDashboard active={open || wide} />"), true);
eq("the dashboard passes active to the poll", /useWorkday\(true, active,/.test(workday), true);

const backend = read("src/data/convex/backend.ts");
const many = backend.slice(backend.indexOf("export async function keywordSearchMany"));
eq("a failed keyword term is not turned into no matches", /\.catch\(\(\) => \[\]/.test(many.slice(0, 900)), false);
const engine = read("src/lib/engineSearch.ts");
eq("an incomplete answer is not kept in the cache", engine.includes("if (r.incomplete?.length)"), true);
eq("the results page says part of the search failed", read("src/app/database/results/page.tsx").includes("engine.incomplete?.length"), true);

const http = read("convex/http.ts");
eq("the Graph webhook schedules one read per mailbox", http.includes("scheduleWebhookPoll") && !http.includes("internal.communications.emailAgent.pollEmailInbox,"), true);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
