import crypto from "node:crypto";
import {
  acceptAnswer, applyPlan, freshTimestamp, modeState, nextStep, questionsFor,
  readEvent, verifySignature, writePolicy,
} from "@/lib/voice";
import type { AiCall, Candidate } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const threw = (l: string, fn: () => unknown) => {
  try { fn(); fail++; console.log(`  FAIL ${l}  (no error thrown)`); }
  catch { pass++; console.log(`  ok   ${l}`); }
};

const c: Candidate = {
  id: "c1", fullName: "Nimal Perera", email: "n@x.invalid", phone: "0771234567",
  linkedinUrl: null, location: "Colombo", nationality: null, age: null, gender: null,
  currentEmployer: "X", currentTitle: "Y", totalExperienceYears: 5, educationDegree: null,
  educationInstitution: null, qualifications: null, englishLevel: null, languages: [],
  skills: [], industries: [], noticePeriodDays: null, currentSalary: null,
  expectedSalary: null, cvFileName: "cv.pdf", workHistory: [], createdAt: 0,
};
const call = (over: Partial<AiCall> = {}): AiCall => ({
  id: "ac1", applicationId: "a1", candidateId: "c1", openingId: "o1",
  mode: "assisted", status: "in_progress", stateVersion: 3,
  consent: "granted", consentAt: 1, consentText: "…", answers: [],
  transcript: null, durationSeconds: null, applied: [], conflicts: [],
  startedBy: "u1", startedAt: 0, endedAt: null, failureReason: null, ...over,
});

console.log("\nmodes");
eq("dry run writes nothing", writePolicy("simulation").candidateFields, false);
eq("assisted writes", writePolicy("assisted").candidateFields, true);
eq("live agent is off in this build", modeState("live").available, false);
eq("and says why", /not registered|not switched on/.test(modeState("live").why), true);

console.log("\nconsent is a precondition, not an event");
eq("first step is consent", nextStep(call({ consent: null }), c).do, "ask_consent");
eq("no answer before consent",
  acceptAnswer({ call: call({ consent: null }), field: "currentSalary", heard: "150k" }),
  { ok: false, message: "Nothing is recorded until consent has been given." });
eq("declined stops everything", nextStep(call({ status: "declined", consent: "declined" }), c).do, "stop");
eq("declined says nothing was kept",
  /nothing was kept/i.test((nextStep(call({ status: "declined" }), c) as { because: string }).because), true);

console.log("\nthe script");
eq("asks only what is missing", questionsFor(c).map((q) => q.field),
  ["currentSalary", "expectedSalary", "noticePeriodDays", "availability"]);
eq("skips what we already hold",
  questionsFor({ ...c, currentSalary: "500K", noticePeriodDays: 30 }).map((q) => q.field),
  ["expectedSalary", "availability"]);
const step = nextStep(call(), c);
eq("first question is the current salary", step.do === "ask" && step.question.field, "currentSalary");
eq("progress is counted", step.do === "ask" && [step.index, step.total], [1, 4]);
eq("all answered → finish",
  nextStep(call({ answers: questionsFor(c).map((q) => ({ field: q.field, value: "x", heard: "x", at: 0 })) }), c).do,
  "finish");

console.log("\nwhat a caller types");
const A = (field: Parameters<typeof acceptAnswer>[0]["field"], heard: string) =>
  acceptAnswer({ call: call(), field, heard });
eq("a sentence", A("currentSalary", "I'm on about 150,000 at the moment"), { ok: true, value: "150K" });
eq("a bare number, as people actually answer", A("currentSalary", "150k"), { ok: true, value: "150K" });
eq("notice in months", A("noticePeriodDays", "2 months"), { ok: true, value: 60 });
eq("bare notice number is days", A("noticePeriodDays", "45"), { ok: true, value: 45 });
eq("availability is kept in their words",
  A("availability", "afternoons, not Tuesdays"), { ok: true, value: "afternoons, not Tuesdays" });
eq("unreadable is refused rather than invented",
  (A("currentSalary", "rather not say") as { ok: false; message: string }).ok, false);
eq("a hedge in front of it — how people answer a direct question",
  A("expectedSalary", "around 950k"), { ok: true, value: "950K" });
eq("\"roughly 200,000\"", A("expectedSalary", "roughly 200,000"), { ok: true, value: "200K" });
eq("\"somewhere about 1.2 million\"", A("currentSalary", "somewhere about 1.2 million"), { ok: true, value: "1.2M" });
eq("\"I'd want 700k ideally\"", A("expectedSalary", "I'd want 700k ideally"), { ok: true, value: "700K" });
eq("\"a month, maybe six weeks\" → ambiguous, handed back",
  (A("noticePeriodDays", "a month, maybe six weeks") as { ok: false }).ok, false);
eq("the words still win where they are there",
  A("expectedSalary", "I'm on 500k now, looking for 700k"), { ok: true, value: "700K" });
eq("immediate", A("noticePeriodDays", "I can start immediately"), { ok: true, value: 0 });

console.log("\nversion check — a webhook delivered twice");
eq("right version accepted",
  acceptAnswer({ call: call(), field: "currentSalary", heard: "150k", expectedVersion: 3 }).ok, true);
eq("stale version refused",
  acceptAnswer({ call: call(), field: "currentSalary", heard: "150k", expectedVersion: 2 }).ok, false);

console.log("\nwriting back");
const answered = call({ answers: [
  { field: "currentSalary", value: "150K", heard: "150k", at: 0 },
  { field: "noticePeriodDays", value: 60, heard: "2 months", at: 0 },
]});
eq("blanks filled", applyPlan(answered, c).fill, { currentSalary: "150K", noticePeriodDays: 60 });
eq("a checked figure is not overwritten",
  applyPlan(answered, { ...c, currentSalary: "500K" }).fill.currentSalary, undefined);
eq("it is raised instead",
  applyPlan(answered, { ...c, currentSalary: "500K" }).conflicts.map((x) => x.field), ["current salary"]);
eq("a dry run writes nothing at all",
  applyPlan({ ...answered, mode: "simulation" }, c).fill, {});

console.log("\nthe webhook, for when the agent is switched on");
eq("a good consent event reads",
  readEvent({ type: "consent", callId: "ac1", decision: "granted", expectedVersion: 3 }).type, "consent");
threw("an unexpected field is refused", () =>
  readEvent({ type: "consent", callId: "ac1", decision: "granted", expectedVersion: 3, extra: 1 }));
threw("a missing field is refused", () => readEvent({ type: "consent", callId: "ac1", decision: "granted" }));
threw("an unknown field name is refused", () =>
  readEvent({ type: "answer", callId: "a", field: "salaryLol", heard: "x", expectedVersion: 1 }));
threw("a negative version is refused", () =>
  readEvent({ type: "consent", callId: "a", decision: "granted", expectedVersion: -1 }));
threw("an unknown event type is refused", () => readEvent({ type: "whatever" }));

console.log("\nsignature");
const secret = "s3cret", ts = String(Date.now()), nonce = "n1", body = '{"type":"consent"}';
const sig = crypto.createHmac("sha256", secret).update(`${ts}.${nonce}.${body}`).digest("hex");
eq("a real signature verifies", verifySignature({ rawBody: body, timestamp: ts, nonce, signature: sig, secret }), true);
eq("a tampered body does not",
  verifySignature({ rawBody: body + " ", timestamp: ts, nonce, signature: sig, secret }), false);
eq("a replayed nonce does not",
  verifySignature({ rawBody: body, timestamp: ts, nonce: "n2", signature: sig, secret }), false);
eq("no signature does not", verifySignature({ rawBody: body, timestamp: ts, nonce, signature: null, secret }), false);
eq("a fresh timestamp passes", freshTimestamp(ts), true);
eq("an hour-old one does not", freshTimestamp(String(Date.now() - 3_600_000)), false);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
