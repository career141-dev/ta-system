/**
 * One candidate reply, run through the real handler: what is saved, what is
 * sent back, and what is left scheduled.
 *
 * The bugs these pin down came from a read of the source (Astra review,
 * 29 Oct): a promised time wiped straight after it was set, a long promise that
 * dropped the answers sent with it, "not interested" answered with another
 * request for the CV, short answers ignored, and Colombo/Hybrid told to
 * candidates for openings that said neither.
 *
 * The model is faked by intercepting fetch, the database by a small in-memory
 * context. No request leaves the machine.
 */
import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import { getFunctionName } from "convex/server";
import { extractDetailsFromText } from "../convex/communications/inboundExtraction";
import { isAutomaticReply, latestReplyText } from "../convex/lib/mailParse";

let model: Record<string, unknown> | "fail";
let prompts: string[];
let userTexts: string[];
let savedKey: string | undefined;

beforeEach(() => {
  savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-only-not-a-real-key";
  prompts = [];
  userTexts = [];
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (!url.startsWith("https://openrouter.ai/")) throw new Error(`Unexpected fetch: ${url}`);
    const body = JSON.parse(String(init?.body));
    prompts.push(body.messages[0].content);
    userTexts.push(body.messages[1].content);
    if (model === "fail") return new Response("upstream down", { status: 500 });
    return Response.json({
      id: "x", object: "chat.completion", created: 0, model: "fake",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(model) } }],
    });
  });
});

afterEach(() => {
  mock.restoreAll();
  if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = savedKey;
});

const empty = {
  currentSalary: null, expectedSalary: null, currentSalaryNote: null, expectedSalaryNote: null,
  noticePeriodDays: null, noticePeriod: null, candidateSummary: null, customAnswers: null,
  candidateEtaMinutes: null, nextActionTimeHours: null, nextActionMessage: null, detectedQuestion: null,
};

function world(jobExtra: Record<string, unknown> = {}) {
  const app: Record<string, any> = {
    _id: "app1", candidateId: "cand1", jobId: "job1", currentStage: "follow_up",
    nextFollowUpScheduledAt: 1, nextFollowUpMessage: "old reminder",
  };
  // Has its CV; app1 does not — so reading the wrong one drops "CV" from the reply.
  const otherApp = { _id: "app2", candidateId: "cand1", jobId: "job2", currentStage: "follow_up", followUpCvReceived: true };
  const candidate: Record<string, any> = { _id: "cand1", fullName: "Kamal Perera", phone: "+94770000001" };
  const job = { _id: "job1", title: "Accountant", ...jobExtra };
  const mutations: { name: string; args: any }[] = [];
  const sends: { name: string; args: any }[] = [];
  const ctx = {
    runQuery: async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      if (name.endsWith(":getApplicationForCandidate")) return args.applicationId === "app1" ? app : null;
      // The candidate's other opening: a turn must never read it back.
      if (name.endsWith(":getActiveFollowUpApplication")) return otherApp;
      if (name.endsWith(":getJob")) return job;
      if (name.endsWith(":getCandidate")) return candidate;
      if (name.endsWith(":getRecentHistoryQuery")) return "[outbound] Message: Are you open to relocating?";
      throw new Error(`Unexpected query: ${name}`);
    },
    runMutation: async (ref: any, args: any) => {
      const name = getFunctionName(ref).split(":")[1];
      mutations.push({ name, args });
      const { applicationId: _a, candidateId: _c, ...rest } = args;
      if (name === "updateCandidateDetails") Object.assign(candidate, rest);
      if (name === "setDoNotContact") candidate.doNotContact = true;
      if (name === "clearPendingFollowUp") Object.assign(app, { nextFollowUpScheduledAt: undefined, nextFollowUpMessage: undefined });
      if (name === "scheduleDynamicFollowUp") Object.assign(app, { nextFollowUpScheduledAt: Date.now() + args.nextActionTimeHours * 3600_000, nextFollowUpMessage: args.messageBody });
      if (name === "updateCandidateEta") Object.assign(app, { nextFollowUpScheduledAt: args.candidateEtaMs, nextFollowUpMessage: args.nextFollowUpMessage, waitingForCandidateEta: true });
      if (name === "flagForTaReview") Object.assign(app, { flaggedForTaReview: true, nextFollowUpScheduledAt: undefined, nextFollowUpMessage: undefined });
      if (name === "recordLocalWhatsappOutbound" || name === "createOutboundEmailRecord") return "comm1";
      return null;
    },
    scheduler: { runAfter: async (_ms: number, ref: any, args: any) => { sends.push({ name: getFunctionName(ref), args }); } },
  };
  const email = () => sends.find((s) => s.name.endsWith(":sendGraphEmail"))?.args.bodyHtml as string | undefined;
  const reply = () => sends.find((s) => s.name.endsWith(":sendWhatsApp"))?.args.body as string | undefined;
  const called = (n: string) => mutations.some((m) => m.name === n);
  return { ctx, app, candidate, mutations, sends, reply, email, called };
}

const turn = (w: ReturnType<typeof world>, textBody: string) =>
  (extractDetailsFromText as any)._handler(w.ctx, { candidateId: "cand1", applicationId: "app1", textBody, channel: "whatsapp" });

test("a promised time is kept, with a reminder to send at it", async () => {
  const w = world();
  model = { ...empty, intent: "promised_eta", candidateEtaMinutes: 240, nextActionTimeHours: 4, nextActionMessage: "No problem, we'll check in tonight 😊" };
  const before = Date.now();
  await turn(w, "I'll send my CV tonight");
  assert.equal(w.reply(), "No problem, we'll check in tonight 😊");
  assert.ok(w.app.nextFollowUpScheduledAt >= before + 4 * 3600_000 - 1000, "the promised time was wiped");
  assert.equal(w.app.waitingForCandidateEta, true);
  assert.match(w.app.nextFollowUpMessage, /CV Document/);
  assert.ok(!w.called("clearPendingFollowUp"), "the clear ran after the promise and erased it");
});

test("a promise past 72 hours saves the answers, replies, and goes to a TA", async () => {
  const w = world();
  model = { ...empty, intent: "promised_eta", currentSalary: 150000, candidateEtaMinutes: 7 * 24 * 60, nextActionTimeHours: 168, nextActionMessage: "Thanks — noted your salary. Next week is fine." };
  await turn(w, "current 150k, will send CV next week");
  assert.equal(w.candidate.currentSalary, 150000, "the salary sent with the promise was dropped");
  assert.equal(w.reply(), "Thanks — noted your salary. Next week is fine.");
  assert.equal(w.app.flaggedForTaReview, true);
  assert.equal(w.app.nextFollowUpScheduledAt, undefined);
});

test("not interested in the role: thanked once, chase stopped, TA told", async () => {
  const w = world();
  model = { ...empty, intent: "not_interested", nextActionMessage: null };
  await turn(w, "Not interested, I took another offer");
  assert.match(w.reply() ?? "", /keep you in mind/);
  assert.doesNotMatch(w.reply() ?? "", /CV|salary|notice/i);
  assert.equal(w.app.flaggedForTaReview, true);
  assert.equal(w.app.nextFollowUpScheduledAt, undefined, "another reminder was left scheduled");
  assert.ok(!w.candidate.doNotContact, "declining one role is not an opt-out");
});

test("stop contacting me: do-not-contact set, nothing sent, nothing scheduled", async () => {
  const w = world();
  model = { ...empty, intent: "opt_out" };
  await turn(w, "Please stop messaging me");
  assert.equal(w.candidate.doNotContact, true);
  assert.equal(w.reply(), undefined);
  assert.equal(w.app.nextFollowUpScheduledAt, undefined);
});

test("a two-letter answer is read, not dropped", async () => {
  const w = world();
  model = { ...empty, intent: "provided_partial", customAnswers: { "Open to relocating?": "No" }, nextActionMessage: "Noted! Could you share your CV?" };
  await turn(w, "no");
  assert.equal(prompts.length, 1, "the model was never asked");
  assert.equal(w.reply(), "Noted! Could you share your CV?");
});

test("the turn reads back its own application, not the candidate's other one", async () => {
  const w = world();
  model = { ...empty, intent: "provided_partial", expectedSalary: 200000, nextActionMessage: null };
  await turn(w, "expected 200k");
  for (const m of w.mutations) if ("applicationId" in m.args) assert.equal(m.args.applicationId, "app1", `${m.name} wrote to another opening`);
  assert.match(w.reply() ?? "", /CV Document/);
});

test("a salary in words counts as answered in the reply's missing list", async () => {
  const w = world();
  model = { ...empty, intent: "provided_partial", expectedSalaryNote: "negotiable", nextActionMessage: null };
  await turn(w, "expected is negotiable");
  assert.doesNotMatch(w.app.nextFollowUpMessage, /Expected Salary/);
});

test("job facts that are not set are never told to the candidate", async () => {
  const w = world();
  model = { ...empty, intent: "asked_question", nextActionMessage: null };
  await turn(w, "Is it remote?");
  assert.doesNotMatch(prompts[0], /Colombo|Hybrid/);
  assert.doesNotMatch(w.reply() ?? "", /Colombo|hybrid/i);
  assert.match(w.reply() ?? "", /consultant will confirm/);
});

test("a model that keeps failing still leaves the candidate a follow-up", async () => {
  const w = world();
  model = "fail";
  await turn(w, "hello");
  assert.ok(prompts.length <= 2, "more than two model attempts");
  assert.ok(w.called("scheduleDynamicFollowUp"), "the failure escaped the fail-open path");
});

// ── Email replies: the same handler, reached from the mailbox readers ────────

const emailTurn = (w: ReturnType<typeof world>, textBody: string, subject = "Re: Accountant role") =>
  (extractDetailsFromText as any)._handler(w.ctx, { candidateId: "cand1", applicationId: "app1", textBody, subject, channel: "email" });

const quotedHtml = `<div>Expected is 200k, notice one month</div><br>
<div>On Tue, 28 Oct 2026 at 10:02, Career141 &lt;job@career141.com&gt; wrote:</div>
<blockquote>Please share: Current Salary, Expected Salary, Notice Period. Can you reply?</blockquote>`;

test("an email is read for the new words only, not our quoted email under it", async () => {
  const w = world();
  model = { ...empty, intent: "provided_partial", expectedSalary: 200000, noticePeriodDays: 30, nextActionMessage: null };
  await emailTurn(w, quotedHtml);
  assert.equal(userTexts[0], "Expected is 200k, notice one month");
});

test("an email 'not interested' is not answered with the missing list", async () => {
  const w = world();
  model = { ...empty, intent: "not_interested", nextActionMessage: null };
  await emailTurn(w, "Thanks, but I am not interested any more.");
  const html = w.email() ?? "";
  assert.match(html, /keep you in mind/);
  assert.doesNotMatch(html, /still waiting|CV Document|these details/i);
  assert.equal(w.app.flaggedForTaReview, true);
});

test("an email promise gets the promise answered, not the missing list", async () => {
  const w = world();
  model = { ...empty, intent: "promised_eta", candidateEtaMinutes: 240, nextActionTimeHours: 4, nextActionMessage: "No problem — we'll check in this evening." };
  await emailTurn(w, "I'll send the CV this evening");
  const html = w.email() ?? "";
  assert.match(html, /check in this evening/);
  assert.doesNotMatch(html, /still waiting/);
  assert.equal(w.app.waitingForCandidateEta, true);
});

test("an email that still needs details asks for exactly what is missing", async () => {
  const w = world();
  model = { ...empty, intent: "provided_partial", expectedSalary: 200000, nextActionMessage: null };
  await emailTurn(w, "Expected 200k");
  const html = w.email() ?? "";
  assert.match(html, /Expected Salary: 200000/);
  assert.match(html, /CV Document/);
  assert.equal(html.split("Expected Salary").length - 1, 1, "expected salary was asked for again");
});

test("an out-of-office is not answered", async () => {
  const w = world();
  model = { ...empty, intent: "promised_eta", candidateEtaMinutes: 6000 };
  await emailTurn(w, "I am away until 3 November.", "Automatic reply: Accountant role");
  assert.equal(prompts.length, 0);
  assert.equal(w.sends.length, 0);
});

test("quoted-thread cutting and auto-reply spotting", () => {
  assert.equal(latestReplyText("Notice is 2 months\r\n\r\nFrom: Career141 <job@career141.com>\r\nSent: Tuesday\r\nTo: me\r\nSubject: x\r\n\r\nPlease share"), "Notice is 2 months");
  assert.equal(latestReplyText("Yes\n________________________________\nFrom: Career141"), "Yes");
  assert.equal(latestReplyText("ok\n> old line"), "ok");
  assert.equal(latestReplyText("<p>Hi,</p><p>CV attached</p>"), "Hi,\nCV attached");
  assert.ok(isAutomaticReply("Out of Office: Accountant", "x"));
  assert.ok(isAutomaticReply("Re: role", "This is an automatic reply. I am away."));
  assert.ok(!isAutomaticReply("Re: role", "I'm on leave until Monday, will send my CV then"));
});
