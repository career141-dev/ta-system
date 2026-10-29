import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import { getFunctionName } from "convex/server";
import { sendDemoEmail, sendDemoWhatsApp } from "../convex/communications/demoSend";
import { countBillableTemplatesToday, logDemoTemplateSent } from "../convex/communications/metaTemplateSender";

const envNames = [
  "OUTREACH_LIVE", "OUTREACH_TEST_PHONE", "OUTREACH_TEST_EMAIL", "OUTREACH_DEFAULT_COUNTRY_CODE",
  "C141_OUTBOUND_LOCK", "C141_OUTBOUND_ALLOW_PHONES", "C141_OUTBOUND_ALLOW_EMAILS",
  "C141_WHATSAPP_TEMPLATE_DAILY_CAP", "META_ACCESS_TOKEN", "META_PHONE_NUMBER_ID",
  "MS_GRAPH_TENANT_ID", "MS_GRAPH_CLIENT_ID", "MS_GRAPH_CLIENT_SECRET", "OUTBOUND_EMAIL_SENDER", "MS_SENDER_EMAIL",
];
let previous: Record<string, string | undefined>;
let calls: { url: string; body: any }[];
let respond: (url: string, body: any) => Response;

beforeEach(() => {
  previous = Object.fromEntries(envNames.map((key) => [key, process.env[key]]));
  for (const key of envNames) delete process.env[key];
  Object.assign(process.env, {
    OUTREACH_TEST_PHONE: "+94770000001", OUTREACH_TEST_EMAIL: "qa@example.invalid",
    META_ACCESS_TOKEN: "test-only", META_PHONE_NUMBER_ID: "test-phone-id",
    MS_GRAPH_TENANT_ID: "test-tenant", MS_GRAPH_CLIENT_ID: "test-client", MS_GRAPH_CLIENT_SECRET: "test-only",
    OUTBOUND_EMAIL_SENDER: "system@example.invalid",
  });
  calls = [];
  respond = (url) => {
    if (url.startsWith("https://login.microsoftonline.com/test-tenant/")) {
      return Response.json({ access_token: "fake-token", expires_in: 3600 });
    }
    if (url.startsWith("https://graph.facebook.com/")) return Response.json({ messages: [{ id: "fake-message" }] });
    if (url.startsWith("https://graph.microsoft.com/")) return new Response(null, { status: 202 });
    throw new Error(`Unexpected fetch: ${url}`);
  };
  // Every HTTP request is intercepted, including authentication; these tests
  // cannot deliver a message or use a developer's actual provider credentials.
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ url, body });
    return respond(url, body);
  });
});

afterEach(() => {
  mock.restoreAll();
  for (const key of envNames) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

function context(refusal: string | null = null, sentToday = 0) {
  const writes: string[] = [];
  return {
    writes,
    runQuery: async (ref: any) => {
      const name = getFunctionName(ref);
      if (name.endsWith(":contactRefusal")) return refusal;
      if (name.endsWith(":countBillableTemplatesToday")) return sentToday;
      throw new Error(`Unexpected query: ${name}`);
    },
    runMutation: async (ref: any) => {
      const name = getFunctionName(ref);
      assert.equal(name, "communications/metaTemplateSender:logDemoTemplateSent");
      writes.push(name);
    },
  };
}
const sample = { candidateName: "Demo <Candidate>", jobTitle: "Accountant" };
const wa = (ctx: any, template = "initial_outreach") => (sendDemoWhatsApp as any)._handler(ctx, { ...sample, to: "0771234567", template });
const email = (ctx: any, kind = "initial") => (sendDemoEmail as any)._handler(ctx, {
  ...sample, to: "requested@example.invalid", kind,
});

test("both WhatsApp demos redirect, send approved parameters and record only the budget event", async () => {
  const ctx = context();
  for (const template of ["initial_outreach", "reengagement"]) {
    const result = await wa(ctx, template);
    assert.equal(result.ok, true);
    assert.match(result.message, /TEST MODE/);
    assert.match(result.message, /94770000001/);
  }
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.body.template.name), ["career141_initial_outreach", "career141_followup_reminder"]);
  assert.deepEqual(calls.map((c) => c.body.template.components[0].parameters.length), [4, 2]);
  assert.ok(calls.every((c) => c.body.to === "94770000001" && c.url.includes("/test-phone-id/messages")));
  assert.equal(ctx.writes.length, 2);
});

test("both email demos use the configured sender, redirect and escape the sample name", async () => {
  const ctx = context();
  for (const kind of ["initial", "reminder"]) {
    const result = await email(ctx, kind);
    assert.equal(result.ok, true);
    assert.match(result.message, /TEST MODE/);
    assert.match(result.message, /system@example.invalid/);
  }
  const messages = calls.filter((c) => c.url.endsWith("/sendMail"));
  assert.equal(messages.length, 2);
  for (const call of messages) {
    assert.match(call.url, /users\/system%40example.invalid\/sendMail$/);
    assert.deepEqual(call.body.message.toRecipients, [{ emailAddress: { address: "qa@example.invalid" } }]);
    assert.deepEqual(call.body.message.replyTo, [{ emailAddress: { address: "system@example.invalid" } }]);
    assert.match(call.body.message.body.content, /Demo &lt;Candidate&gt;/);
    assert.match(call.body.message.subject, /Accountant/);
  }
  assert.match(messages[1].body.message.subject, /Missing info/);
  assert.deepEqual(ctx.writes, []);
});

test("missing test recipients, do-not-contact and outbound locks stop both providers", async () => {
  delete process.env.OUTREACH_TEST_PHONE;
  delete process.env.OUTREACH_TEST_EMAIL;
  assert.equal((await wa(context())).ok, false);
  assert.equal((await email(context())).ok, false);
  process.env.OUTREACH_TEST_PHONE = "94770000001";
  process.env.OUTREACH_TEST_EMAIL = "qa@example.invalid";
  assert.match((await wa(context("do-not-contact"))).message, /do-not-contact/);
  assert.match((await email(context("do-not-contact"))).message, /do-not-contact/);
  process.env.C141_OUTBOUND_LOCK = "true";
  assert.equal((await wa(context())).ok, false);
  assert.equal((await email(context())).ok, false);
  assert.equal(calls.length, 0);
});

test("the shared daily cap stops demo templates before Meta is called", async () => {
  process.env.C141_WHATSAPP_TEMPLATE_DAILY_CAP = "1";
  const ctx = context(null, 1);
  assert.match((await wa(ctx)).message, /daily WhatsApp template limit/);
  assert.equal(calls.length, 0);
  assert.deepEqual(ctx.writes, []);
});

test("only a missing template retries the alternate language; provider failures are not counted", async () => {
  respond = () => new Response('{"error":{"code":132001}}', { status: 400 });
  const ctx = context();
  assert.equal((await wa(ctx)).ok, false);
  assert.deepEqual(calls.map((c) => c.body.template.language.code), ["en", "en_US"]);
  assert.deepEqual(ctx.writes, []);
  calls = [];
  respond = () => new Response("provider unavailable", { status: 503 });
  assert.match((await wa(ctx)).message, /Meta answered 503/);
  assert.equal(calls.length, 1);
  assert.deepEqual(ctx.writes, []);
});

test("email uses MS_SENDER_EMAIL when the primary sender is unset, and reports provider refusal", async () => {
  delete process.env.OUTBOUND_EMAIL_SENDER;
  process.env.MS_SENDER_EMAIL = "backend@example.invalid";
  assert.equal((await email(context())).ok, true);
  assert.match(calls.find((c) => c.url.endsWith("/sendMail"))!.url, /users\/backend%40example.invalid\/sendMail$/);
  calls = [];
  const normalResponse = respond;
  respond = (url, body) => url.endsWith("/sendMail")
    ? new Response("ErrorAccessDenied", { status: 403 }) : normalResponse(url, body);
  const result = await email(context());
  assert.equal(result.ok, false);
  assert.match(result.message, /403/);
  assert.equal(calls.filter((c) => c.url.endsWith("/sendMail")).length, 1);
});

test("accepted WhatsApp with failed budget recording is reported as sent, never retried", async () => {
  const ctx = { ...context(), runMutation: async () => { throw new Error("database unavailable"); } };
  const result = await wa(ctx);
  assert.equal(result.ok, true);
  assert.match(result.message, /WARNING:.*Do not resend/);
  assert.equal(calls.length, 1);
});

test("budget query includes demos and the demo log contains no candidate or contact data", async () => {
  const rows: Record<string, any[]> = {
    communications: [
      { sentAt: 200, direction: "outbound", billableTemplate: true },
      { sentAt: 200, direction: "outbound", billableTemplate: false },
      { sentAt: 200, direction: "inbound", billableTemplate: true },
      { sentAt: 50, direction: "outbound", billableTemplate: true },
    ],
    demoTemplateSends: [{ sentAt: 200 }, { sentAt: 50 }],
  };
  const db = {
    query: (table: string) => ({ withIndex: (_index: string, filter: any) => {
      let since = 0;
      const q: any = { eq: () => q, gte: (_field: string, value: number) => { since = value; return q; } };
      filter(q);
      return { collect: async () => rows[table].filter((r) => r.sentAt >= since) };
    } }),
    insert: async (table: string, doc: any) => {
      assert.equal(table, "demoTemplateSends");
      assert.deepEqual(Object.keys(doc), ["sentAt"]);
      rows[table].push(doc);
    },
  };
  assert.equal(await (countBillableTemplatesToday as any)._handler({ db }, { since: 100 }), 2);
  await (logDemoTemplateSent as any)._handler({ db }, {});
  assert.equal(await (countBillableTemplatesToday as any)._handler({ db }, { since: 100 }), 3);
});
