import { addressList, followUpCancelledReason, GRAPH_BASE, sendFollowUpMail, sendMailPayload } from "../convex/lib/graphMail";
import { eodEmailHtml, DEFAULT_EOD_CC, EOD_CC_DEFAULTS, EOD_TO, parseAddressList } from "../src/lib/eod-format";

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

/** A fake Microsoft Graph: records each call and answers with `status` (or per sender). */
function fakeGraph(status: number | ((url: string) => number) = 202, body = "") {
  const calls: { url: string; auth: string; payload: any }[] = [];
  const fetchImpl = async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, auth: init.headers.Authorization, payload: JSON.parse(init.body) });
    const s = typeof status === "function" ? status(url) : status;
    return { ok: s >= 200 && s < 300, status: s, text: async () => body };
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
  eq("Graph 403 → status and body", !r.ok && r.error, "Microsoft Graph sendMail from job@career141.com returned 403: ErrorAccessDenied");
  r = await sendFollowUpMail(mail, token, async () => { throw new Error("ECONNRESET"); });
  eq("network failure → reason", !r.ok && r.error.includes("ECONNRESET"), true);

  // ── From the assigned TA's mailbox, falling back to the system inbox ─────
  env({ OUTREACH_LIVE: "true" });
  g = fakeGraph();
  r = await sendFollowUpMail({ ...mail, from: "Nimali@Career141.com", fallbackFrom: "job@career141.com", replyTo: ["nimali@career141.com", "job@career141.com"] }, token, g.fetchImpl);
  eq("sent from the TA's mailbox", r.ok && r.from, "nimali@career141.com");
  eq("posted to the TA's sendMail", g.calls[0].url, `${GRAPH_BASE}/users/nimali%40career141.com/sendMail`);
  eq("replies go to the TA and job@", g.calls[0].payload.message.replyTo.map((x: any) => x.emailAddress.address), ["nimali@career141.com", "job@career141.com"]);
  g = fakeGraph((url) => (url.includes("nimali") ? 403 : 202), "ErrorAccessDenied");
  r = await sendFollowUpMail({ ...mail, from: "nimali@career141.com", fallbackFrom: "job@career141.com" }, token, g.fetchImpl);
  eq("TA mailbox refused → sent from job@", r.ok && r.from, "job@career141.com");
  eq("and says so", r.ok && r.note.includes("could not send"), true);
  eq("two attempts", g.calls.length, 2);
  g = fakeGraph((url) => (url.includes("nimali") ? 500 : 202), "boom");
  r = await sendFollowUpMail({ ...mail, from: "nimali@career141.com", fallbackFrom: "job@career141.com" }, token, g.fetchImpl);
  eq("a Graph outage is not retried from another mailbox", [r.ok, g.calls.length], [false, 1]);

  // ── End of day: copies and attachments ───────────────────────────────────
  const eod = {
    from: "nimali@career141.com",
    to: "director@career141.com",
    cc: ["lead@career141.com", DEFAULT_EOD_CC, "shortlists@career141.com", "Director@career141.com", "not an address"],
    subject: "HAYLEYS - CFO - 16 SEPTEMBER 2026",
    html: "<p>x</p>",
    attachments: [{ name: "Nimal Perera - Career141.pdf", contentType: "application/pdf", base64: "JVBERi0=" }],
  };
  g = fakeGraph();
  r = await sendFollowUpMail(eod, token, g.fetchImpl);
  eq("azim@career141.com is the default end-of-day copy", DEFAULT_EOD_CC, "azim@career141.com");
  eq("live: copies kept, the recipient and junk removed", g.calls[0].payload.message.ccRecipients.map((x: any) => x.emailAddress.address), ["lead@career141.com", "azim@career141.com", "shortlists@career141.com"]);
  eq("CV attached as a file", g.calls[0].payload.message.attachments[0], { "@odata.type": "#microsoft.graph.fileAttachment", name: "Nimal Perera - Career141.pdf", contentType: "application/pdf", contentBytes: "JVBERi0=" });
  env({ OUTREACH_TEST_EMAIL: "qa@career141.com" });
  g = fakeGraph();
  r = await sendFollowUpMail(eod, token, g.fetchImpl);
  eq("test mode: no copies go out", g.calls[0].payload.message.ccRecipients, undefined);
  env({ OUTREACH_LIVE: "true", C141_OUTBOUND_LOCK: "true", C141_OUTBOUND_ALLOW_EMAILS: "director@career141.com,azim@career141.com" });
  g = fakeGraph();
  r = await sendFollowUpMail(eod, token, g.fetchImpl);
  eq("lock: only allow-listed copies", g.calls[0].payload.message.ccRecipients.map((x: any) => x.emailAddress.address), ["azim@career141.com"]);
  eq("address list de-duplicates", addressList(["A@b.co", "a@b.co", "", "x"]), ["a@b.co"]);

  // ── End of day, 29 Sep: the desk's To and Cc, and what the TA adds ───────
  eq("the desk's To", EOD_TO, "joborders@career141.com");
  eq("the desk's fixed Cc", [...EOD_CC_DEFAULTS], ["shamra@career141.com", "asma@career141.com", "opsteam@career141.com", "cv@career141.com"]);
  eq("typed addresses: split, lower-cased, once each", parseAddressList("A@b.co; c@d.lk,\n a@b.co"), { ok: ["a@b.co", "c@d.lk"], bad: [] });
  eq("a typo is reported, not dropped", parseAddressList("good@x.com, oops"), { ok: ["good@x.com"], bad: ["oops"] });
  eq("empty box adds nobody", parseAddressList("  "), { ok: [], bad: [] });
  const desk = {
    ...eod,
    to: EOD_TO,
    alsoTo: ["Boss@career141.com", EOD_TO, "bad"],
    cc: [...EOD_CC_DEFAULTS, "extra@career141.com", "boss@career141.com", "shortlists@career141.com"],
  };
  env({ OUTREACH_LIVE: "true" });
  g = fakeGraph();
  r = await sendFollowUpMail(desk, token, g.fetchImpl);
  eq("live: To is the job-orders box then the added address, once each", g.calls[0].payload.message.toRecipients.map((x: any) => x.emailAddress.address), ["joborders@career141.com", "boss@career141.com"]);
  eq("live: the desk's Cc, the TA's, and the reply inbox — nobody twice", g.calls[0].payload.message.ccRecipients.map((x: any) => x.emailAddress.address), ["shamra@career141.com", "asma@career141.com", "opsteam@career141.com", "cv@career141.com", "extra@career141.com", "shortlists@career141.com"]);
  eq("the result says who was on To", r.ok && r.alsoTo, ["boss@career141.com"]);
  env({ OUTREACH_TEST_EMAIL: "qa@career141.com" });
  g = fakeGraph();
  r = await sendFollowUpMail(desk, token, g.fetchImpl);
  eq("test mode: only the test mailbox, no added To or Cc", [g.calls[0].payload.message.toRecipients.length, g.calls[0].payload.message.ccRecipients], [1, undefined]);
  // ── End of day, 30 Sep: a test send still reaches the desk ─────────────────
  env({ OUTREACH_TEST_EMAIL: "tester@gmail.com" });
  g = fakeGraph();
  r = await sendFollowUpMail({ ...desk, alsoTo: [...desk.alsoTo, "friend@gmail.com"], keepInternalInTest: "career141.com" }, token, g.fetchImpl);
  eq("test mode, internal kept: the test inbox first, then the job-orders box and the added To", g.calls[0].payload.message.toRecipients.map((x: any) => x.emailAddress.address), ["tester@gmail.com", "joborders@career141.com", "boss@career141.com"]);
  eq("test mode, internal kept: the desk's Cc still go", g.calls[0].payload.message.ccRecipients.map((x: any) => x.emailAddress.address), ["shamra@career141.com", "asma@career141.com", "opsteam@career141.com", "cv@career141.com", "extra@career141.com", "shortlists@career141.com"]);
  eq("test mode, internal kept: an outside address is still dropped, and it says so", r.ok && r.note.includes("1 extra recipient dropped"), true);
  g = fakeGraph();
  r = await sendFollowUpMail({ ...mail, cc: ["lead@career141.com"] }, token, g.fetchImpl);
  eq("a candidate email in test mode still copies nobody", [g.calls[0].payload.message.toRecipients.length, g.calls[0].payload.message.ccRecipients], [1, undefined]);

  env({ OUTREACH_LIVE: "true", C141_OUTBOUND_LOCK: "true", C141_OUTBOUND_ALLOW_EMAILS: "joborders@career141.com,boss@career141.com,cv@career141.com" });
  g = fakeGraph();
  r = await sendFollowUpMail(desk, token, g.fetchImpl);
  eq("lock: only allow-listed To and Cc", [g.calls[0].payload.message.toRecipients.map((x: any) => x.emailAddress.address), g.calls[0].payload.message.ccRecipients.map((x: any) => x.emailAddress.address)], [["joborders@career141.com", "boss@career141.com"], ["cv@career141.com"]]);

  const body = eodEmailHtml({
    rows: [{ no: 1, name: "Nimal <Perera>", age: "34", notice: "30 days", notes: [">Currently at Hayleys"], currentCompany: "Hayleys", currentDesignation: "CFO", currentRemuneration: "LKR 450,000", expectedRemuneration: "LKR 600,000", applicationId: "a1" }],
    effort: { date: "16 Sept", assignee: "Nimali", hundredOrFollowUp: "", lEffort: 12, sets: 2, da: 1, scoop: 0, l: 3, post: null, addOns: null, backUp: null },
    senderName: "Nimali",
  });
  eq("email body escapes names", body.includes("Nimal &lt;Perera&gt;"), true);
  eq("email body carries the shortlist", body.includes("LKR 600,000") && body.includes("CURRENT REMUNERATION"), true);
  eq("email body carries today's progress", body.includes("NO.OF L EFFORT") && body.includes(">12<"), true);
  eq("email body signs off as the TA", body.includes("Best Regards,<br><br>Nimali"), true);
  eq("email body leaves out the candidate's address", body.includes("LOCATION"), false);
  const followUpDay = eodEmailHtml({
    rows: [],
    effort: { date: "21 Sept", assignee: "Nimali", hundredOrFollowUp: "Follow-up", lEffort: 4, sets: 1, da: 0, scoop: 0, l: 0, post: 0, addOns: 1, backUp: 0, targets: { lEffort: 5 } },
    senderName: "Nimali",
  });
  eq("a follow-up day counts CVs in the fourth column", followUpDay.includes("NO. OF CVs") && !followUpDay.includes("NO.OF L EFFORT"), true);
  eq("targets go out as a row", followUpDay.includes("<i>Target</i>") && followUpDay.includes(">5<"), true);
  eq("add-ons are a figure, not a blank", followUpDay.includes(">1<"), true);
  // SETS carries the day's total beside the set: the day's CVs, each once (28 Sep).
  eq("the SETS cell carries the set and the day's total", body.includes(">2 · 4 CVs<"), true);

  // ── A queued message that should no longer go ─────────────────────────────
  eq("pending, in Follow-up → send", followUpCancelledReason({ deliveryStatus: "pending" }, { currentStage: "follow_up" }), null);
  eq("no application → send", followUpCancelledReason({ deliveryStatus: "pending" }, null), null);
  eq("stopped → not sent", followUpCancelledReason({ stoppedSequence: true }, { currentStage: "follow_up" }) !== null, true);
  eq("moved on → not sent", followUpCancelledReason({}, { currentStage: "second_shortlist" }), "Cancelled: the candidate is no longer in Follow-up (second_shortlist).");
  // Completing the checklist advances the candidate in the same run, so the
  // assistant's own "we have everything" note must not be cancelled by it.
  eq("an answer to the candidate still goes after they advance", followUpCancelledReason({}, { currentStage: "second_shortlist" }, true), null);
  eq("a stopped sequence still wins over that", followUpCancelledReason({ stoppedSequence: true }, { currentStage: "second_shortlist" }, true) !== null, true);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main();
