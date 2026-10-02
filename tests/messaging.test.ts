/**
 * What may reach a candidate, and how often (2 Oct).
 *
 *   1. Do-not-contact was read by four paths and ignored by the rest — the
 *      stage machine's Day 0 outreach, the Graph emails, the WhatsApp sender,
 *      the Meta templates and the AI's replies to inbound messages.
 *   2. The AI answered inbound email and WhatsApp whatever the stage, chasing
 *      a candidate at interview or offer for their CV again.
 *   3. Two overlapping inbox polls recorded the same email twice and each
 *      scheduled an AI reply.
 *
 * The Convex functions run here against a small in-memory database, the way
 * they run on the server, minus the server.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { doNotContactRefusal } from "../convex/lib/outreachSafety";
import { isFollowUpStage } from "../convex/ta/stages";
import { isOutboundCallTestMode } from "../convex/integrations/livekitSipPolicy";
import { contactRefusal } from "../convex/communications/contactGuard";
import { checkAndRecordEmailReply } from "../convex/communications/emailAgent";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/** Just enough of ctx.db for the functions under test: eq-only indexes. */
function fakeCtx(tables: Record<string, any[]>) {
  let next = 1;
  for (const rows of Object.values(tables)) for (const r of rows) r._id ??= `id${next++}`;
  const scheduled: { args: any }[] = [];
  const db = {
    get: async (id: string) => Object.values(tables).flat().find((r) => r._id === id) ?? null,
    insert: async (table: string, doc: any) => {
      const row = { ...doc, _id: `id${next++}`, _creationTime: Date.now() };
      (tables[table] ??= []).push(row);
      return row._id;
    },
    query: (table: string) => {
      let rows = [...(tables[table] ?? [])];
      const chain: any = {
        withIndex: (_name: string, f?: (q: any) => any) => {
          const eqs: [string, unknown][] = [];
          const q: any = { eq: (field: string, value: unknown) => (eqs.push([field, value]), q) };
          f?.(q);
          rows = rows.filter((r) => eqs.every(([k, v]) => r[k] === v));
          return chain;
        },
        order: (dir: string) => ((rows = dir === "desc" ? rows.reverse() : rows), chain),
        first: async () => rows[0] ?? null,
        collect: async () => rows,
        take: async (n: number) => rows.slice(0, n),
      };
      return chain;
    },
  };
  return { db, scheduler: { runAfter: async (_ms: number, _fn: unknown, args: any) => void scheduled.push({ args }) }, scheduled, tables };
}

const run = (fn: any, ctx: any, args: any) => fn._handler(ctx, args);

// ── 1. Do-not-contact ────────────────────────────────────────────────────────

test("one flagged record is enough to refuse", () => {
  assert.equal(doNotContactRefusal([]), null);
  assert.equal(doNotContactRefusal([null, { doNotContact: false }]), null);
  const r = doNotContactRefusal([{ doNotContact: false }, { doNotContact: true, doNotContactReason: "Asked by phone" }]);
  assert.match(r ?? "", /do-not-contact \(Asked by phone\)/);
});

test("the guard finds the flag by id, by email in any case, and by any spelling of the phone", async () => {
  const ctx = fakeCtx({
    candidates: [
      { _id: "ok", email: "fine@x.lk", phone: "+94770000001" },
      { _id: "stop", email: "Stop@X.lk", phone: "0771234567", phoneClean: "0771234567", doNotContact: true },
    ],
  });
  assert.equal(await run(contactRefusal, ctx, { candidateId: "ok" }), null);
  assert.notEqual(await run(contactRefusal, ctx, { candidateId: "stop" }), null);
  assert.notEqual(await run(contactRefusal, ctx, { email: "Stop@X.lk" }), null);
  // The same person on another record, written to by email: still refused.
  assert.notEqual(await run(contactRefusal, ctx, { candidateId: "ok", email: "Stop@X.lk" }), null);
  // Meta sends the number as 94…, the record holds 077…
  assert.notEqual(await run(contactRefusal, ctx, { phone: "94771234567" }), null);
  assert.equal(await run(contactRefusal, ctx, { phone: "94770000001" }), null);
});

test("every candidate sender asks the guard", () => {
  // Read from source: the senders are actions that call Graph and Meta, and a
  // dropped call is what regressed.
  for (const [file, count] of [
    ["convex/communications/graphEmail.ts", 2], // sendGraphEmail, replyToMessage
    ["convex/communications/emailAgent.ts", 1], // sendFollowUpEmail
    ["convex/communications/metaDirectSender.ts", 1], // every free-text WhatsApp
    ["convex/communications/metaTemplateSender.ts", 1],
  ] as const) {
    const calls = read(file).split("refuseIfDoNotContact(ctx").length - 1;
    assert.equal(calls, count, `${file} should call refuseIfDoNotContact ${count}×`);
  }
  assert.match(read("convex/pipeline/followUpHelper.ts"), /if \(candidate\.doNotContact\) \{/);
  assert.match(read("convex/communications/inboundExtraction.ts"), /if \(candidate\?\.doNotContact\) \{/);
});

test("a real call needs outreach to be live", () => {
  const off = { callTestMode: "false", outreachTestMode: undefined, globalTestMode: undefined, settingsTestMode: false };
  assert.equal(isOutboundCallTestMode({ ...off, outreachLive: false }), true);
  assert.equal(isOutboundCallTestMode({ ...off, outreachLive: true }), false);
  const eleven = read("convex/integrations/elevenlabs.ts");
  assert.equal(eleven.split("!outreachLive() ||").length - 1, 2, "both ElevenLabs calls need OUTREACH_LIVE");
});

// ── 2. Follow-up stages only ─────────────────────────────────────────────────

test("only AI and TA Follow-up count as Follow-up", () => {
  for (const s of ["follow_up", "ta_shortlist", "ai_call"]) assert.equal(isFollowUpStage(s), true, s);
  for (const s of ["interview", "offer", "placed", "rejected", "second_shortlist", "matched_candidates", "new_cvs", "", undefined]) {
    assert.equal(isFollowUpStage(s), false, String(s));
  }
});

const emailCtx = (stages: string[]) =>
  fakeCtx({
    candidates: [{ _id: "c1", email: "nimal@x.lk" }],
    applications: stages.map((s, i) => ({ _id: `a${i}`, candidateId: "c1", jobId: `j${i}`, currentStage: s })),
    communications: [],
  });
const email = (messageId: string) => ({ senderEmail: "nimal@x.lk", subject: "Re: role", body: "Here you go", messageId, inboxEmail: "job@career141.com" });

test("an email from a candidate at interview is recorded but not answered", async () => {
  delete process.env.OUTREACH_TEST_EMAIL;
  const ctx = emailCtx(["interview"]);
  await run(checkAndRecordEmailReply, ctx, email("m1"));
  assert.equal(ctx.tables.communications.length, 1);
  assert.equal(ctx.tables.communications[0].applicationId, "a0");
  assert.equal(ctx.scheduled.length, 0, "no AI reply scheduled");
});

test("an email is answered for the application in Follow-up, not the newest one", async () => {
  // a0 is older and in Follow-up; a1 is newer and at offer.
  const ctx = emailCtx(["follow_up", "offer"]);
  await run(checkAndRecordEmailReply, ctx, email("m2"));
  assert.equal(ctx.scheduled.length, 1);
  assert.equal(ctx.scheduled[0].args.applicationId, "a0");
});

test("the WhatsApp reply path uses the same rule", () => {
  const src = read("convex/communications/whatsappOutbound.ts");
  assert.match(src, /if \(!isFollowUpStage\(activeApp\.currentStage\)\)/);
});

// ── 3. One email, one answer ─────────────────────────────────────────────────

test("the same Graph message seen by two polls is recorded and answered once", async () => {
  const ctx = emailCtx(["follow_up"]);
  await run(checkAndRecordEmailReply, ctx, email("same"));
  const again = await run(checkAndRecordEmailReply, ctx, email("same"));
  assert.equal(again.duplicate, true);
  assert.equal(ctx.tables.communications.length, 1);
  assert.equal(ctx.scheduled.length, 1);
  // A different message from the same person is still recorded.
  await run(checkAndRecordEmailReply, ctx, email("other"));
  assert.equal(ctx.tables.communications.length, 2);
});

// ── 4, 5. Contracts on the source ────────────────────────────────────────────

test("the reply just sent is not stored as the next follow-up", () => {
  const src = read("convex/communications/inboundExtraction.ts");
  assert.doesNotMatch(src, /messageBody: replyMessage/);
});

test("a template never falls back to another job", () => {
  const src = read("convex/communications/metaTemplateSender.ts");
  assert.doesNotMatch(src, /getFirstActiveJob/);
  assert.match(src, /followUpCancelledReason\(queued, app\)/);
});
