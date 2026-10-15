/**
 * The TA's ChatGPT research link on the end-of-day email (src/lib/eod-format):
 * which links are accepted, who must give one, and how it is written into the
 * email. The rule under test: only a ChatGPT *share* link ever becomes an address.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkResearchSubmission,
  eodEmailHtml,
  needsResearchLink,
  validateResearchLink,
  type EffortRow,
  type ShortlistRow,
} from "@/lib/eod-format";

// The round is recorded in the in-memory JSON store, in a scratch directory.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "c141-research-")));
const { repo } = await import("@/data/store");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const url = (s: string) => { const r = validateResearchLink(s); return r.ok ? r.url : r.reason; };
const bad = (s: string) => !validateResearchLink(s).ok;

const ID = "68f1a2b3-4c5d-8e9f-a0b1-c2d3e4f5a6b7";

console.log("\nWhich links are accepted");
eq("a share link on chatgpt.com", url(`https://chatgpt.com/share/${ID}`), `https://chatgpt.com/share/${ID}`);
eq("the older host chat.openai.com", url(`https://chat.openai.com/share/${ID}`), `https://chat.openai.com/share/${ID}`);
eq("www. is dropped", url(`https://www.chatgpt.com/share/${ID}`), `https://chatgpt.com/share/${ID}`);
eq("no scheme is fine", url(`chatgpt.com/share/${ID}`), `https://chatgpt.com/share/${ID}`);
eq("http becomes https", url(`http://chatgpt.com/share/${ID}`), `https://chatgpt.com/share/${ID}`);
eq("a query and a fragment are removed", url(`https://chatgpt.com/share/${ID}?utm_source=x#top`), `https://chatgpt.com/share/${ID}`);
eq("a trailing slash is removed", url(`https://chatgpt.com/share/${ID}/`), `https://chatgpt.com/share/${ID}`);
eq("capital letters in the host", url(`https://ChatGPT.com/share/${ID}`), `https://chatgpt.com/share/${ID}`);
eq("surrounding spaces are trimmed", url(`  https://chatgpt.com/share/${ID}\n`), `https://chatgpt.com/share/${ID}`);
eq("the /share/e/ form", url(`https://chatgpt.com/share/e/${ID}`), `https://chatgpt.com/share/e/${ID}`);

console.log("\nWhich are refused");
eq("empty", bad(""), true);
eq("only spaces", bad("   "), true);
eq("nothing at all", bad(null as unknown as string), true);
eq("a private chat link says why", url(`https://chatgpt.com/c/${ID}`).includes("private chat link"), true);
eq("a custom GPT page", bad(`https://chatgpt.com/g/g-abc123def`), true);
eq("the chatgpt home page", bad("https://chatgpt.com/"), true);
eq("another site", bad(`https://example.com/share/${ID}`), true);
eq("a look-alike host (suffix)", bad(`https://chatgpt.com.evil.example/share/${ID}`), true);
eq("a look-alike host (prefix)", bad(`https://evilchatgpt.com/share/${ID}`), true);
eq("a look-alike host (userinfo)", bad(`https://chatgpt.com@evil.example/share/${ID}`), true);
eq("javascript:", bad("javascript:alert(1)"), true);
eq("data:", bad("data:text/html,<script>alert(1)</script>"), true);
eq("two links in one box", bad(`https://chatgpt.com/share/${ID} https://chatgpt.com/share/${ID}`), true);
eq("a link inside a sentence", bad(`here it is https://chatgpt.com/share/${ID}`), true);
eq("a share path with no id", bad("https://chatgpt.com/share/"), true);
eq("a too-short id", bad("https://chatgpt.com/share/abc"), true);
eq("over 300 characters", bad(`https://chatgpt.com/share/${"a".repeat(300)}`), true);

console.log("\nWho must give one");
eq("a TA, the email to the directors", needsResearchLink("ta", "director"), true);
for (const workType of ["Follow-up", "Add-on"]) {
  eq(`${workType} needs no research link`, needsResearchLink("ta", "director", workType), false);
  for (const role of ["ta", "ta_support"] as const) {
    eq(`${role} can send ${workType} without research or confirmation`, checkResearchSubmission({ role, kind: "director", workType, link: "", confirmed: false }), { ok: true, url: null });
  }
}
eq("a TA, the client copy (no email)", needsResearchLink("ta", "client"), false);
for (const r of ["ta_lead", "director", "admin", "ops"] as const) eq(`${r} is exempt`, needsResearchLink(r, "director"), false);

console.log("\nWhat the send does");
const good = `https://chatgpt.com/share/${ID}`;
eq("a TA with a good link and the box ticked is let through", checkResearchSubmission({ role: "ta", kind: "director", link: good, confirmed: true }), { ok: true, url: good });
eq("a TA with no link is stopped", checkResearchSubmission({ role: "ta", kind: "director", link: "", confirmed: true }).ok, false);
eq("a TA with a private link is stopped", checkResearchSubmission({ role: "ta", kind: "director", link: `https://chatgpt.com/c/${ID}`, confirmed: true }).ok, false);
{
  const r = checkResearchSubmission({ role: "ta", kind: "director", link: good, confirmed: false });
  eq("a TA who has not ticked the box is stopped, and told why", [r.ok, !r.ok && r.reason.includes("Tick the box")], [false, true]);
}
eq("a lead is not stopped without a link", checkResearchSubmission({ role: "ta_lead", kind: "director", link: "", confirmed: false }), { ok: true, url: null });
eq("a lead's good link is still used", checkResearchSubmission({ role: "ta_lead", kind: "director", link: good, confirmed: false }), { ok: true, url: good });
eq("a lead's bad link is ignored, not sent", checkResearchSubmission({ role: "director", kind: "director", link: "nonsense", confirmed: false }), { ok: true, url: null });
eq("the client copy carries no link", checkResearchSubmission({ role: "ta", kind: "client", link: good, confirmed: true }), { ok: true, url: null });

console.log("\nIn the email");
const row: ShortlistRow = {
  no: 1, name: "Nimal Perera", age: "30", notice: "1 month", notes: [], currentCompany: "Dialog", currentDesignation: "Accountant",
  currentRemuneration: "100k", expectedRemuneration: "150k", applicationId: "a1",
};
const effort = { date: "2026-10-08", assignee: "Binath", hundredOrFollowUp: "100%", lEffort: 1, sets: 1 } as unknown as EffortRow;
const base = { rows: [row], effort, senderName: "Binath" };
for (const workType of ["Follow-up", "Add-on"]) {
  const html = eodEmailHtml({ ...base, rows: [], effort: { ...effort, hundredOrFollowUp: workType } });
  eq(`${workType} activity email contains only the effort table`, (html.match(/<table /g) ?? []).length, 1);
  eq(`${workType} activity email does not claim CVs are attached`, html.includes("attached Shortlisted CV"), false);
  eq(`${workType} activity email needs no research block`, html.includes("View ChatGPT Research"), false);
}
{
  const html = eodEmailHtml({ ...base, researchLink: good });
  eq("a clickable anchor", html.includes(`<a href="${good}"`), true);
  eq("the words on the link", html.includes(">View ChatGPT Research</a>"), true);
  eq("the address is also written out", html.split(good).length - 1, 2);
  eq("a Research label", html.includes("<b>Research:</b>"), true);
  eq("it comes after the tables and before the sign-off", html.indexOf("Research:") > html.lastIndexOf("</table>") && html.indexOf("Research:") < html.indexOf("Best Regards"), true);
}
{
  const html = eodEmailHtml(base);
  eq("no link, no Research block: old callers are unchanged", html.includes("Research"), false);
}
{
  const html = eodEmailHtml({ ...base, researchLink: `https://evil.example/"><script>alert(1)</script>` });
  eq("a link that fails the check is never written as an address", [html.includes("evil.example"), html.includes("<script>")], [false, false]);
}
{
  const html = eodEmailHtml({ ...base, researchLink: `javascript:alert(1)` });
  eq("javascript: never reaches an href", html.includes("javascript:"), false);
}

console.log("\nOn the sent round");
{
  const o = repo.openings()[0];
  const apps = repo.applications(o.id).slice(0, 1).map((a) => a.id);
  const round = (researchLink?: string | null) =>
    repo.openReviewRound({ openingId: o.id, kind: "director", applicationIds: apps, setNumber: null, sentBy: "u_nuha", sentTo: "director@example.com", subject: "test", researchLink });
  const r1 = round(good);
  eq("the link is kept as sent", repo.reviewRounds(o.id).find((r) => r.id === r1.id)?.researchLink, good);
  eq("no link is null, not undefined", round().researchLink, null);
  eq("an explicit null stays null", round(null).researchLink, null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
