import {
  followUpFor, nextContactMoment, questionsInForce, readReply, STANDARD_QUESTIONS,
  type Contact, type FollowUpQuestion,
} from "@/lib/followup";
import { colomboHour } from "@/lib/calendar";
import type { Candidate } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const H = 3_600_000;
/** An instant at a Colombo wall-clock time. */
const colombo = (y: number, mo: number, d: number, h: number, mi = 0) => Date.UTC(y, mo - 1, d, h, mi) - 5.5 * H;

const cand = (over: Partial<Candidate> = {}): Candidate =>
  ({ id: "c", fullName: "Nimal Perera", phone: "0771234567", email: "nimal@example.com",
     currentSalary: null, expectedSalary: null, noticePeriodDays: null, ...over } as Candidate);

const Q = STANDARD_QUESTIONS;
const F = (contacts: Contact[], now: number, c = cand(), questions: FollowUpQuestion[] = Q, enteredAt = colombo(2026, 9, 12, 10)) =>
  followUpFor({ candidate: c, questions, enteredAt, contacts, now });

const t0 = colombo(2026, 9, 12, 10); // Saturday 10:00 Colombo
const call = (at: number, outcome: Contact["outcome"], promisedAt: number | null = null): Contact =>
  ({ at, channel: "ai_call", direction: "out", outcome, promisedAt });
const msg = (at: number, channel: "whatsapp" | "email" = "whatsapp"): Contact => ({ at, channel, direction: "out" });
const reply = (at: number): Contact => ({ at, channel: "whatsapp", direction: "in" });

console.log("\nthe contact window: 07:00 to 21:00, every day, weekends included");
eq("Saturday 10:00 is inside", nextContactMoment(t0), t0);
eq("22:30 moves to 07:00 next morning", colomboHour(nextContactMoment(colombo(2026, 9, 12, 22, 30))), 7);
eq("05:00 moves to 07:00 same morning", nextContactMoment(colombo(2026, 9, 13, 5)), colombo(2026, 9, 13, 7));
eq("Sunday is a contact day", nextContactMoment(colombo(2026, 9, 13, 15)), colombo(2026, 9, 13, 15));

console.log("\nthe call goes first");
let f = F([], t0);
eq("owed now", f.state, "due");
eq("an AI call", f.next?.channels, ["ai_call"]);
eq("the day is 24 hours", (f.deadline - f.startedAt) / H, 24);
eq("no phone: email instead", F([], t0, cand({ phone: null })).next?.channels, ["email"]);

console.log("\nno answer → WhatsApp and email straight away");
f = F([call(t0, "no_answer")], t0 + 60_000);
eq("both channels", f.next?.channels, ["whatsapp", "email"]);
eq("due now", f.state, "due");
eq("no_answer wording", f.next?.purpose, "no_answer");

console.log("\nmessages unanswered → one more call three hours on, then one reminder");
f = F([call(t0, "no_answer"), msg(t0 + 60_000), msg(t0 + 60_000, "email")], t0 + 2 * H);
eq("waiting for the retry", f.state, "waiting");
eq("the retry is a call", f.next?.channels, ["ai_call"]);
f = F([call(t0, "no_answer"), msg(t0), msg(t0, "email"), call(t0 + 3 * H, "no_answer")], t0 + 3 * H + 60_000);
eq("second no answer → messages again", f.next?.channels, ["whatsapp", "email"]);
f = F([call(t0, "no_answer"), msg(t0), call(t0 + 3 * H, "no_answer"), msg(t0 + 3 * H), msg(t0 + 6 * H)], t0 + 7 * H);
eq("after the reminder nothing more is automatic", f.next, null);

console.log("\nanswered, but not everything → the rest on WhatsApp");
f = F([call(t0, "answered")], t0 + 60_000, cand({ currentSalary: "300K" }));
eq("WhatsApp only", f.next?.channels, ["whatsapp"]);
eq("asks only what is left", f.missing.map((q) => q.id), ["expected_salary", "notice_period"]);

console.log("\n\"call me at 4\" → called at 4");
const four = colombo(2026, 9, 12, 16);
f = F([call(t0, "callback", four)], t0 + H);
eq("waiting", f.state, "waiting");
eq("a call at four", [f.next?.channels, f.next?.at], [["ai_call"], four]);
eq("due at four", F([call(t0, "callback", four)], four).state, "due");

console.log("\n\"I'll WhatsApp it by 1\" → chased if it has not come");
const one = colombo(2026, 9, 12, 13);
f = F([call(t0, "will_send", one)], t0 + H);
eq("waits until the promise", [f.state, f.next?.at], ["waiting", one]);
f = F([call(t0, "will_send", one)], one + 60_000);
eq("then a WhatsApp chase", [f.state, f.next?.channels, f.next?.purpose], ["due", ["whatsapp"], "promised"]);
f = F([call(t0, "will_send", one), reply(t0 + 2 * H)], t0 + 2 * H + 60_000, cand({ currentSalary: "250K" }));
eq("a partial reply gets the rest asked", [f.next?.channels, f.next?.purpose], [["whatsapp"], "the_rest"]);

console.log("\none day, then the TA");
f = F([call(t0, "no_answer"), msg(t0)], t0 + 25 * H);
eq("overdue after a day", f.state, "overdue");
eq("says what is still missing", /still missing/.test(f.handBack ?? ""), true);
f = F([], colombo(2026, 9, 12, 23), cand(), Q, colombo(2026, 9, 12, 22));
eq("a 22:00 entry starts the day at 07:00", colomboHour(f.startedAt), 7);

console.log("\nended");
eq("everything in → complete", F([], t0, cand({ currentSalary: "1", expectedSalary: "2", noticePeriodDays: 30 })).state, "complete");
eq("not interested → declined", F([call(t0, "not_interested")], t0 + H).state, "declined");
eq("no phone, no email → unreachable", F([], t0, cand({ phone: null, email: null })).state, "unreachable");

console.log("\nthe questions are the desk's to set");
const noNotice = STANDARD_QUESTIONS.map((q) => (q.id === "notice_period" ? { ...q, enabled: false } : q));
const qs = questionsInForce(noNotice, [{ id: "lic", label: "Driving licence held" }]);
eq("a switched-off standard question is not asked", qs.map((q) => q.id), ["current_salary", "expected_salary", "lic"]);
f = followUpFor({ candidate: cand({ currentSalary: "1", expectedSalary: "2" }), questions: qs, answers: {}, enteredAt: t0, contacts: [], now: t0 });
eq("the TA's own question keeps it open", f.missing.map((q) => q.id), ["lic"]);
f = followUpFor({ candidate: cand({ currentSalary: "1", expectedSalary: "2" }), questions: qs, answers: { lic: "Yes" }, enteredAt: t0, contacts: [], now: t0 });
eq("answering it finishes the day", f.state, "complete");

console.log("\nreading a reply");
const cases: [string, Partial<ReturnType<typeof readReply>>][] = [
  ["Currently on 150k, expecting 200k, 1 month notice", { currentSalary: "150K", expectedSalary: "200K", noticePeriodDays: 30 }],
  ["current: 185,000 expected: 250,000 notice 2 weeks", { currentSalary: "185K", expectedSalary: "250K", noticePeriodDays: 14 }],
  ["I am looking for 300k and can join immediately", { expectedSalary: "300K", noticePeriodDays: 0 }],
  ["My notice period is 3 months", { noticePeriodDays: 90 }],
  ["Rs. 1.2M currently", { currentSalary: "1.2M" }],
  ["Thanks, will send soon", { empty: true }],
];
for (const [text, want] of cases) {
  const got = readReply(text);
  const sub: Record<string, unknown> = {};
  for (const k of Object.keys(want)) sub[k] = (got as unknown as Record<string, unknown>)[k];
  eq(`"${text.slice(0, 44)}"`, sub, want);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
