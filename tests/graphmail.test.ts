import { followUpCancelledReason, GRAPH_BASE, sendFollowUpMail, sendMailPayload } from "../convex/lib/graphMail";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const env = (vars: Record<string, string | undefined>) => {
  for (const k of ["OUTREACH_LIVE", "OUTREACH_TEST_EMAIL", "OUTREACH_TEST_PHONE", "C141_OUTBOUND_LOCK", "C141_OUTBOUND_ALLOW_EMAILS"]) {
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(vars)) if (v !== undefined) process.env[k] = v;
};

/** A fake Microsoft Graph: records each call and answers with `status`. */
function fakeGraph(status = 202, body = "") {
  const calls: { url: string; auth: string; payload: any }[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, auth: init.headers.Authorization, payload: JSON.parse(init.body) });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  return { calls, fetchImpl };
}
const token = async () => "tok-123";

const mail = {
  from: "job@career141.com",
  to: "Candidate@Example.com",
  subject: "Head of Finance — 2 things still needed",
  html: "<p>Hi Nimal</p>",
  replyTo: "job@career141.com",
  candidateJobId: "app_42",
};

async function main() {
  // ── Live: the candidate gets it, through Graph sendMail ───────────────────
  env({ OUTREACH_LIVE: "true" });
  let g = fakeGraph();
  let r = await sendFollowUpMail(mail, token, g.fetchImpl);
  eq("live send succeeds", r.ok, true);
  eq("one Graph call", g.calls.length, 1);
  eq("posted to the sender's sendMail", g.calls[0].url, `${GRAPH_BASE}/users/job%40career141.com/sendMail`);
  eq("bearer token used", g.calls[0].auth, "Bearer tok-123");
  eq("to the candidate (normalised)", g.calls[0].payload.message.toRecipients, [{ emailAddress: { address: "candidate@example.com" } }]);
  eq("HTML body", g.calls[0].payload.message.body, { contentType: "HTML", content: "<p>Hi Nimal</p>" });
  eq("replies come back to job@", g.calls[0].payload.message.replyTo, [{ emailAddress: { address: "job@career141.com" } }]);
  eq("application header carried", g.calls[0].payload.message.internetMessageHeaders, [{ name: "x-c141-candidatejobid", value: "app_42" }]);
  eq("kept in Sent Items", g.calls[0].payload.saveToSentItems, true);
  eq("subject", g.calls[0].payload.message.subject, mail.subject);

  // ── Plain-text reminder ───────────────────────────────────────────────────
  eq("text body when there is no HTML", sendMailPayload({ ...mail, html: undefined, text: "Hi" }, "a@b.c").message.body, { contentType: "Text", content: "Hi" });

  // ── Test mode: redirected to the test mailbox, never the candidate ────────
  env({ OUTREACH_TEST_EMAIL: "qa@career141.com" });
  g = fakeGraph();
  r = await sendFollowUpMail(mail, token, g.fetchImpl);
  eq("test mode sends", r.ok, true);
  eq("test mode goes to the test mailbox", g.calls[0]?.payload.message.toRecipients[0].emailAddress.address, "qa@career141.com");
  eq("and says it was redirected", r.ok && r.note.includes("redirected"), true);

  // ── Test mode with no test mailbox: nothing reaches Graph ─────────────────
  env({});
  g = fakeGraph();
  r = await sendFollowUpMail(mail, token, g.fetchImpl);
  eq("blocked with no test recipient", !r.ok && r.blocked, true);
  eq("Graph never called", g.calls.length, 0);

  // ── Outbound lock (staging): only allow-listed addresses ──────────────────
  env({ OUTREACH_LIVE: "true", C141_OUTBOUND_LOCK: "true", C141_OUTBOUND_ALLOW_EMAILS: "qa@career141.com" });
  g = fakeGraph();
  r = await sendFollowUpMail(mail, token, g.fetchImpl);
  eq("lock suppresses a real candidate", !r.ok && r.blocked, true);
  eq("lock: Graph never called", g.calls.length, 0);
  r = await sendFollowUpMail({ ...mail, to: "qa@career141.com" }, token, g.fetchImpl);
  eq("lock allows the allow-listed mailbox", r.ok, true);

  // ── Failures are reported, never left pending ─────────────────────────────
  env({ OUTREACH_LIVE: "true" });
  r = await sendFollowUpMail({ ...mail, from: undefined }, token, fakeGraph().fetchImpl);
  eq("no sending mailbox → reason", !r.ok && r.error.includes("MS_SENDER_EMAIL"), true);
  r = await sendFollowUpMail(mail, async () => null, fakeGraph().fetchImpl);
  eq("no credentials → reason", !r.ok && r.error.includes("credentials"), true);
  r = await sendFollowUpMail(mail, async () => { throw new Error("AADSTS7000215 invalid secret"); }, fakeGraph().fetchImpl);
  eq("sign-in failure → reason", !r.ok && r.error.includes("AADSTS7000215"), true);
  r = await sendFollowUpMail(mail, token, fakeGraph(403, "ErrorAccessDenied").fetchImpl);
  eq("Graph 403 → status and body", !r.ok && r.error, "Microsoft Graph sendMail returned 403: ErrorAccessDenied");
  r = await sendFollowUpMail(mail, token, async () => { throw new Error("ECONNRESET"); });
  eq("network failure → reason", !r.ok && r.error.includes("ECONNRESET"), true);

  // ── A queued message that should no longer go ─────────────────────────────
  eq("pending, in Follow-up → send", followUpCancelledReason({ deliveryStatus: "pending" }, { currentStage: "follow_up" }), null);
  eq("no application → send", followUpCancelledReason({ deliveryStatus: "pending" }, null), null);
  eq("stopped → not sent", followUpCancelledReason({ stoppedSequence: true }, { currentStage: "follow_up" }) !== null, true);
  eq("moved on → not sent", followUpCancelledReason({}, { currentStage: "second_shortlist" }), "Cancelled: the candidate is no longer in Follow-up (second_shortlist).");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main();
