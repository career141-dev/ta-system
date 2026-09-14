/**
 * The paid-run safeguards, proven with a fake provider (14 September).
 * No network: every request goes to a mocked fetch. Includes the reproductions
 * from CODEX-P1-RUN-CARD-REVIEW-2026-09-14.md as regression tests.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { RunLedger, LedgerError } = await import("@/lib/runLedger");
const { runFrozen, requestHash, requestMaxUsd, inputTokenBound, bodyFor, manifestHash, writeFinalReport } = await import("@/lib/p1Runner");
const { deidentify, residualContacts } = await import("@/lib/deid");
const { answerProblems, answerFlags } = await import("@/lib/screenAnswer");
import type { FrozenRequest, Manifest } from "@/lib/p1Runner";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "c141-p1-"));
const H = "a".repeat(64), R = "b".repeat(64);

const route = { model: "deepseek/deepseek-v4.1-flash", provider: "deepinfra/fp8", quantization: "fp8", inPerM: 0.2, outPerM: 0.6 };
/** Requests with a chosen reservation, or the real byte bound when none is given. */
function frozen(n: number, capUsd: number, opts: { maxUsd?: number; maxTokens?: number } = {}) {
  const maxTokens = opts.maxTokens ?? 600;
  const requests: FrozenRequest[] = Array.from({ length: n }, (_, i) => {
    const system = "screen", user = "x".repeat(15000);
    const maxInputTokens = inputTokenBound(system, user);
    return { id: `r${i + 1}`, job: 4, no: i + 1, candidateId: `c${i + 1}`, route: 0, system, user, maxInputTokens, maxUsd: opts.maxUsd ?? requestMaxUsd(route, maxInputTokens, maxTokens) };
  });
  const manifest: Manifest = { runId: "P1", capUsd, maxTokens, temperature: 0, routes: [route], requestHashes: Object.fromEntries(requests.map((r) => [r.id, requestHash(r)])) };
  return { requests, manifest };
}
const VALID = JSON.stringify({ industry: { result: "pass", quote: "" }, level: { current: "manager", job: "manager", result: "pass", quote: "" }, work: { type: "procurement", result: "fail", quote: "" }, essentials_contradicted: [], essentials_missing: [], move: "step_up", decision: "reject", reason: "x" });
const reply = (cost: number | undefined, content = VALID, finish = "stop", promptTokens = 3700) => async () =>
  new Response(JSON.stringify({ id: "gen-1", choices: [{ finish_reason: finish, message: { content } }], usage: { prompt_tokens: promptTokens, completion_tokens: 200, ...(cost === undefined ? {} : { cost }) } }), { status: 200 });
const counting = (f: () => Promise<Response>) => { const c = { n: 0, fetch: (async () => { c.n++; return f(); }) as unknown as typeof fetch }; return c; };
const openLedger = (d: string, cap: number, m: Manifest) => { const L = new RunLedger(d, "P1", cap, manifestHash(m), R); L.open(); return L; };

console.log("\nthe request is exactly the frozen, pinned route");
{
  const { requests, manifest } = frozen(1, 1);
  const b = bodyFor(manifest, requests[0]) as any;
  eq("one provider, no fallback", [b.provider.order, b.provider.allow_fallbacks], [["deepinfra/fp8"], false]);
  eq("no-retention and no training", [b.provider.zdr, b.provider.data_collection], [true, "deny"]);
  eq("providers that cannot honour the output limit are refused", b.provider.require_parameters, true);
  eq("fixed quantisation", b.provider.quantizations, ["fp8"]);
  eq("output limit and temperature from the manifest", [b.max_tokens, b.temperature], [600, 0]);
  const d = tmp(); const L = openLedger(d, 1, manifest);
  let msg = "";
  try { await runFrozen({ manifest, requests: [{ ...requests[0], user: requests[0].user + "!" }], ledger: L, key: "k", resultsFile: path.join(d, "r.jsonl"), fetchImpl: reply(0.001) as any }); } catch (e) { msg = (e as Error).message; }
  eq("a changed text is refused before any call", /does not match/.test(msg), true);
  msg = "";
  try { await runFrozen({ manifest, requests: [{ ...requests[0], candidateId: "someone-else" }], ledger: L, key: "k", resultsFile: path.join(d, "r.jsonl"), fetchImpl: reply(0.001) as any }); } catch (e) { msg = (e as Error).message; }
  eq("a changed candidate id is refused before any call", /does not match/.test(msg), true);
  L.close();
  eq("the input bound is at least one token per UTF-8 byte plus overhead", inputTokenBound("é", "ab") >= Buffer.byteLength("éab") + 64, true);
}

console.log("\nCodex 1: a charge above its own reservation halts at once, and stays halted");
{
  const { requests, manifest } = frozen(3, 0.4, { maxUsd: 0.001 });
  const d = tmp(); const L = openLedger(d, 0.4, manifest);
  const c = counting(reply(0.002));
  const out = await runFrozen({ manifest, requests, ledger: L, key: "k", resultsFile: path.join(d, "r.jsonl"), fetchImpl: c.fetch });
  eq("exactly one request sent", c.n, 1);
  eq("the other two are not run", out.results.filter((r) => r.status === "not_run").length, 2);
  eq("stopped as halted", /^halted: r1 charged \$0.002 above its reservation \$0.001/.test(out.stopped ?? ""), true);
  eq("the actual charge is kept, not capped", L.state().confirmedUsd, 0.002);
  L.close();
  const L2 = openLedger(d, 0.4, manifest);
  const c2 = counting(reply(0.0005));
  const out2 = await runFrozen({ manifest, requests, ledger: L2, key: "k", resultsFile: path.join(d, "r.jsonl"), fetchImpl: c2.fetch });
  eq("a restart sends nothing while the halt stands", [c2.n, /^halted/.test(out2.stopped ?? "")], [0, true]);
  let e = "";
  try { L2.resolve("", "x"); } catch (x) { e = (x as Error).message; }
  eq("a resolution needs an approval reference", /invalid/.test(e), true);
  L2.resolve("approval 2026-09-14 by Uzmaan: continue P1 with allowance unchanged", "checked provider record for r1");
  L2.close();
  const L3 = openLedger(d, 0.4, manifest);
  const c3 = counting(reply(0.0005));
  const out3 = await runFrozen({ manifest, requests, ledger: L3, key: "k", resultsFile: path.join(d, "r.jsonl"), fetchImpl: c3.fetch });
  eq("after a recorded resolution the remaining two run", [c3.n, out3.stopped], [2, null]);
  L3.close();
}

console.log("\ninput tokens above the bound halt the run");
{
  const { requests, manifest } = frozen(3, 1);
  const d = tmp(); const L = openLedger(d, 1, manifest);
  const c = counting(reply(0.0001, VALID, "stop", requests[0].maxInputTokens + 1));
  const out = await runFrozen({ manifest, requests, ledger: L, key: "k", resultsFile: path.join(d, "r.jsonl"), fetchImpl: c.fetch });
  eq("one request, then halted on the token bound", [c.n, /input tokens above the bound/.test(out.stopped ?? "")], [1, true]);
  L.close();
}

console.log("\nthe allowance stops the run and leaves the rest not run");
{
  const { requests, manifest } = frozen(10, 0.0045, { maxUsd: 0.00136 });
  const d = tmp(); const L = openLedger(d, 0.0045, manifest);
  const c = counting(reply(0.0011));
  const out = await runFrozen({ manifest, requests, ledger: L, key: "k", resultsFile: path.join(d, "r.jsonl"), fetchImpl: c.fetch });
  eq("stopped for the allowance", /^allowance/.test(out.stopped ?? ""), true);
  eq("no call once the next could pass the allowance", c.n, 3);
  eq("committed never exceeds the allowance", L.state().committedUsd <= 0.0045, true);
  L.close();
}

console.log("\nCodex 2: ledger contents are validated, not just parsed");
{
  const { requests, manifest } = frozen(1, 1);
  const h = manifestHash(manifest);
  const damaged = async (edit: (lines: any[]) => any[]) => {
    const d = tmp();
    const L = new RunLedger(d, "P1", 1, h, R); L.open(); L.reserve("r1", 0.3); L.close();
    const f = path.join(d, "ledger.jsonl");
    const lines = fs.readFileSync(f, "utf8").trim().split("\n").map((x) => JSON.parse(x));
    fs.writeFileSync(f, edit(lines).map((x) => JSON.stringify(x)).join("\n") + "\n");
    const c = counting(reply(0.001));
    let msg = "";
    try {
      const L2 = new RunLedger(d, "P1", 1, h, R); L2.open();
      await runFrozen({ manifest, requests, ledger: L2, key: "k", resultsFile: path.join(d, "r.jsonl"), fetchImpl: c.fetch });
      L2.close();
    } catch (e) { msg = (e as Error).message; }
    return { refused: /invalid|unreadable|partial/.test(msg), sent: c.n };
  };
  eq("a null reservation amount is refused before any request", await damaged((ls) => { ls[1].maxUsd = null; return ls; }), { refused: true, sent: 0 });
  eq("a negative amount is refused", await damaged((ls) => { ls[1].maxUsd = -0.3; return ls; }), { refused: true, sent: 0 });
  eq("a missing field is refused", await damaged((ls) => { delete ls[1].key; return ls; }), { refused: true, sent: 0 });
  eq("an unknown record type is refused", await damaged((ls) => [...ls, { type: "refund", usd: 1, at: 1 }]), { refused: true, sent: 0 });
  eq("a duplicate reservation is refused", await damaged((ls) => [...ls, ls[1]]), { refused: true, sent: 0 });
  eq("a settlement for an unknown key is refused", await damaged((ls) => [...ls, { type: "settle", key: "ghost", status: "confirmed", usd: 0, at: 1 }]), { refused: true, sent: 0 });
  eq("a second settlement is refused", await damaged((ls) => [...ls, { type: "settle", key: "r1", status: "confirmed", usd: 0, at: 1 }, { type: "settle", key: "r1", status: "confirmed", usd: 0, at: 2 }]), { refused: true, sent: 0 });
  eq("a resolution with no halt is refused", await damaged((ls) => [...ls, { type: "resolve", approval: "x", note: "y", at: 1 }]), { refused: true, sent: 0 });
  eq("a second opening record is refused", await damaged((ls) => [...ls, ls[0]]), { refused: true, sent: 0 });
  eq("an extra unexpected field is refused", await damaged((ls) => { ls[1].maxUsd = 0.3; ls[1].note = "edited"; return ls; }), { refused: true, sent: 0 });
  eq("a truncated last line is refused", await (async () => { const d = tmp(); const L = new RunLedger(d, "P1", 1, h, R); L.open(); L.close(); fs.appendFileSync(path.join(d, "ledger.jsonl"), '{"type":"reserve"'); try { new RunLedger(d, "P1", 1, h, R).open(); return false; } catch (e) { return /partial/.test((e as Error).message); } })(), true);
  const d = tmp(); const L = new RunLedger(d, "P1", 1, h, R); L.open();
  let e1 = ""; try { L.confirm("never-reserved", 0.1); } catch (e) { e1 = (e as Error).message; }
  let e2 = ""; try { L.reserve("r9", Number.NaN); } catch (e) { e2 = (e as Error).message; }
  eq("invalid entries are refused before appending, too", [/invalid/.test(e1), /invalid/.test(e2)], [true, true]);
  L.close();
  let e3 = ""; try { new RunLedger(d, "P1", 1, h, "c".repeat(64)).open(); } catch (e) { e3 = (e as Error).message; }
  eq("a different runner version cannot reuse the ledger", /runner version/.test(e3), true);
}

console.log("\nCodex 3: answers are validated against the v3 schema");
{
  eq("{} is invalid", answerProblems({}).length > 0, true);
  eq("an unknown decision is invalid", answerProblems({ ...JSON.parse(VALID), decision: "hire" }).includes("decision not allowed"), true);
  const noGate = JSON.parse(VALID); delete noGate.level;
  eq("a missing gate is invalid", answerProblems(noGate).includes("level missing"), true);
  eq("a complete answer is valid", answerProblems(JSON.parse(VALID)), []);
  const { requests, manifest } = frozen(3, 1);
  const d = tmp(); const L = openLedger(d, 1, manifest);
  let n = 0;
  const bodies = ["{}", JSON.stringify({ ...JSON.parse(VALID), decision: "hire" }), JSON.stringify(noGate)];
  const f = (async () => reply(0.0001, bodies[n++])()) as unknown as typeof fetch;
  const out = await runFrozen({ manifest, requests, ledger: L, key: "k", resultsFile: path.join(d, "r.jsonl"), fetchImpl: f });
  eq("none of the three is ok", out.results.map((r) => r.status), ["invalid_output", "invalid_output", "invalid_output"]);
  L.close();
  const a = { ...JSON.parse(VALID), work: { type: "procurement", result: "fail", quote: "" }, decision: "shortlist", industry: { result: "pass", quote: "Bank of Nowhere" } };
  const flags = answerFlags(a, "the CV mentions Hayleys");
  eq("unsupported evidence and contradictions are flagged, not repaired", [flags.some((x) => /quote not found/.test(x)), flags.some((x) => /failed without a quote/.test(x)), flags.some((x) => /shortlist despite a failed gate/.test(x))], [true, true, true]);
}

console.log("\nCodex 3: the final report covers every manifest request exactly once");
{
  const { requests, manifest } = frozen(10, 1);
  const d = tmp(); const L = openLedger(d, 1, manifest);
  let n = 0;
  const f = (async () => { n++; if (n === 1) throw new TypeError("fetch failed"); return new Response("down", { status: 503 }); }) as unknown as typeof fetch;
  const resultsFile = path.join(d, "r.jsonl");
  const out = await runFrozen({ manifest, requests, ledger: L, key: "k", resultsFile, fetchImpl: f });
  const summary = writeFinalReport({ manifest, requests, ledger: L, resultsFile, stopped: out.stopped, outFile: path.join(d, "final.json") });
  const rows = JSON.parse(fs.readFileSync(path.join(d, "final.json"), "utf8")).rows as { id: string; status: string; stopReason?: string; ledgerUsd: number; ledgerAttempts: unknown[] }[];
  eq("stopped after three failures", /^failures: 3/.test(out.stopped ?? ""), true);
  eq("all 10 ids, once each, in manifest order", rows.map((r) => r.id), requests.map((r) => r.id));
  eq("the not-run rows carry the stop reason", rows.filter((r) => r.status === "not_run").every((r) => /^failures/.test(r.stopReason ?? "")), true);
  eq("a retried request counts both attempts from the ledger", [rows[0].ledgerAttempts.length, rows[0].ledgerUsd], [2, Math.round(2 * requests[0].maxUsd * 1e6) / 1e6]);
  eq("summary ledger matches", summary.ledger.uncertainUsd, Math.round(4 * requests[0].maxUsd * 1e6) / 1e6);
  L.close();
}

console.log("\nCodex 3: the continue rule never passes on incomplete coverage");
{
  const { evaluateP1 } = await import("@/lib/p1Evaluate");
  const answer = (d: string) => ({ decision: d });
  // 18 recruiter positives among 120; the model keeps 15 of the first 100 people it answered.
  const truth: Record<string, string> = {};
  const rows = Array.from({ length: 120 }, (_, i) => {
    truth[`4|c${i}`] = i < 18 ? "maybe" : "reject";
    return { id: `m:4:${i}`, job: 4, candidateId: `c${i}`, model: "m", status: i < 100 ? "ok" : "not_run", parsed: i < 100 ? answer(i < 15 ? "maybe" : "reject") : null };
  });
  const partial = evaluateP1({ rows, truth, peoplePerModel: 120 })[0];
  eq("15 kept but 20 people not run is inconclusive, not continue", [partial.kept, partial.verdict], [15, "inconclusive"]);
  const full = evaluateP1({ rows: rows.map((r, i) => (i < 100 ? r : { ...r, status: "ok", parsed: answer("reject") })), truth, peoplePerModel: 120 })[0];
  eq("the same answers with full coverage continue", full.verdict, "continue");
  const hopeless = evaluateP1({ rows: rows.map((r, i) => (i < 100 ? { ...r, parsed: answer("reject") } : r)), truth, peoplePerModel: 120 })[0];
  eq("incomplete but unable to reach 15 even in the best case is stop", hopeless.verdict, "stop");
  const invalid = evaluateP1({ rows: rows.map((r, i) => (i >= 100 ? { ...r, status: "invalid_output" } : r)), truth, peoplePerModel: 120 })[0];
  eq("more than 5 invalid answers is stop", invalid.verdict, "stop");
}

console.log("\nuncertain charges keep their reservation");
{
  const { requests, manifest } = frozen(2, 1);
  const d = tmp(); const L = openLedger(d, 1, manifest);
  const out = await runFrozen({ manifest, requests, ledger: L, key: "k", resultsFile: path.join(d, "r.jsonl"), fetchImpl: reply(undefined) as any });
  eq("a response with no reported cost is uncertain, not free", [out.results[0].costStatus, L.state().confirmedUsd], ["uncertain", 0]);
  L.reconcile("r1", 0.0009, "provider generation record");
  eq("reconciling replaces the reservation with the provider's figure", L.state().confirmedUsd, 0.0009);
  let e = ""; try { L.reconcile("r1", 0.0009, "again"); } catch (x) { e = (x as Error).message; }
  eq("a second reconciliation is refused", /invalid/.test(e), true);
  L.close();
}

console.log("\ntruncated answers stay in the results");
{
  const { requests, manifest } = frozen(1, 1);
  const d = tmp(); const L = openLedger(d, 1, manifest);
  const out = await runFrozen({ manifest, requests, ledger: L, key: "k", resultsFile: path.join(d, "r.jsonl"), fetchImpl: reply(0.001, '{"decision":', "length") as any });
  eq("a capped answer is marked truncated", out.results[0].status, "truncated");
  L.close();
}

console.log("\nrestart, crash and damage");
{
  const { requests, manifest } = frozen(4, 1);
  const h = manifestHash(manifest);
  const d2 = tmp();
  const Lc = new RunLedger(d2, "P1", 1, h, R); Lc.open(); Lc.reserve("r1", requests[0].maxUsd); Lc.close();
  const Lr = new RunLedger(d2, "P1", 1, h, R); Lr.open();
  eq("an open reservation from a crash counts at its maximum", Lr.state().openUsd, Math.round(requests[0].maxUsd * 1e6) / 1e6);
  const c = counting(reply(0.001));
  const out = await runFrozen({ manifest, requests, ledger: Lr, key: "k", resultsFile: path.join(d2, "r.jsonl"), fetchImpl: c.fetch });
  eq("the interrupted request is not resent", [out.results[0].status, c.n], ["no_response", 3]);
  Lr.close();
  const d3 = tmp(); const L3 = new RunLedger(d3, "P1", 1, h, R); L3.open(); L3.close();
  fs.appendFileSync(path.join(d3, "ledger.jsonl"), "{not json\n");
  let e3 = ""; try { new RunLedger(d3, "P1", 1, h, R).open(); } catch (e) { e3 = (e as Error).message; }
  eq("an unreadable ledger stops the run", /unreadable/.test(e3), true);
  const d4 = tmp(); const L4 = new RunLedger(d4, "P1", 1, h, R); L4.open(); L4.close();
  fs.rmSync(path.join(d4, "ledger.jsonl"));
  let e4 = ""; try { new RunLedger(d4, "P1", 1, h, R).open(); } catch (e) { e4 = (e as Error).message; }
  eq("a started run with its ledger missing stops", /missing/.test(e4), true);
  const d5 = tmp(); const L5 = new RunLedger(d5, "P1", 1, h, R); L5.open(); L5.close();
  let e5 = ""; try { new RunLedger(d5, "P1", 2, h, R).open(); } catch (e) { e5 = (e as Error).message; }
  eq("a different allowance cannot reuse a ledger", /different run, allowance/.test(e5), true);
  const d6 = tmp(); const A = new RunLedger(d6, "P1", 1, h, R); A.open();
  let e6 = ""; try { new RunLedger(d6, "P1", 1, h, R).open(); } catch (e) { e6 = (e as Error).message; }
  eq("a second runner cannot start while one holds the lock", /holds/.test(e6), true);
  A.close();
  eq("LedgerError is the error type", new LedgerError("x") instanceof Error, true);
}

console.log("\nrepeated failures stop the run");
{
  const { requests, manifest } = frozen(10, 1);
  const d = tmp(); const L = openLedger(d, 1, manifest);
  const c = counting(async () => new Response("down", { status: 503 }));
  const out = await runFrozen({ manifest, requests, ledger: L, key: "k", resultsFile: path.join(d, "r.jsonl"), fetchImpl: c.fetch });
  eq("three failures in a row stop it", [/^failures: 3/.test(out.stopped ?? ""), c.n], [true, 3]);
  L.close();
}

console.log("\ncontact details come out, dates stay in");
{
  const cv = "Jane Perera\njane.perera@gmail.com | +94 77 123 4567 | 0771234567\nlinkedin.com/in/janeperera\nNIC 912345678V\nProcurement Manager 2015 - 2019\n01/2020 - 12/2023 Head of Sourcing\nBudget LKR 400,000,000";
  const d = deidentify(cv, "Jane Perera");
  eq("email, phones, link, NIC and name replaced", [d.replaced.email, d.replaced.url, d.replaced.nic + d.replaced.id, d.replaced.phone, d.replaced.header], [1, 1, 1, 2, 1]);
  eq("year ranges kept", d.text.includes("2015 - 2019") && d.text.includes("01/2020 - 12/2023"), true);
  eq("money kept", d.text.includes("LKR 400,000,000"), true);
  eq("nothing left for the residual check", residualContacts(d.text, "Jane Perera"), []);
  eq("the residual check finds what was missed", residualContacts("call 0771234567", null).map((x) => x.type), ["phone"]);
  const hard = "S. CHANDRAKUMAR\nthanuj.silva@ gmail.com\nAddress: No. 12/3, Temple Road, Kotte Mobile 0771234567\nDOB : 12/04/1985\nDate of Birth - 4th November 1990\nPassport No. N1234567\nGender: Male Marital status: Married\nAddressed customer complaints and born leader in teams\nManager 2015 - 2019";
  const h = deidentify(hard, "Thanuj Silva");
  eq("a name-only header line is removed", h.text.split("\n")[0], "[name]");
  eq("an email with spaces around @ is removed", /gmail/.test(h.text), false);
  eq("an email with a space inside the domain is removed", deidentify("mail kasun85@ gm ail.com now", null).text, "mail [email] now");
  eq("labels with no colon at a line start are removed", deidentify("Address Hanwella , Sri Lanka\nMarital Status Married, with 2 Kids.\naddress customer needs", null).text, "Address: [removed]\nMarital Status: [removed]\naddress customer needs");
  const loose = deidentify("No. 9, Victoria Estate, Munagama,\n120/A , Temple Road, Paththalagedara, Veyangoda\nNo. 450, Siyabalape Road, Handling all marketing services\n12/03/2024, Viewed by Nuha Iqbar\n14th June 1985\nMarried\nJan 2015 - Mar 2019 Manager, Hayleys\nReduced costs 12% on 3,400 SKUs", null).text;
  eq("standalone street addresses are removed", /Victoria|Temple Road|Siyabalape/.test(loose), false);
  eq("the rest of a merged two-column line is kept", /Handling all marketing services/.test(loose), true);
  eq("staff names in 'Viewed by' footers are removed", /Nuha/.test(loose), false);
  eq("a birth date and marital status alone on a line are removed", /1985|^Married$/m.test(loose), false);
  eq("employment dates and figures are kept", /Jan 2015 - Mar 2019 Manager, Hayleys/.test(loose) && /12% on 3,400 SKUs/.test(loose), true);
  const more = deidentify("CONTACT PROFILE No 45/2,Gaminipura, Hatton, SriLanka\n12/03/2024, Azeem Ansar updated candidate from Finance\nmobile-771234567\nREFEREES\nMrs. Dilhani Perera\nGeneral Manager, ABC\n0771234567\nDECLARATION\nI certify the above.\nLed a team of Mr. and Ms. roles", null).text;
  eq("house addresses with no street word are removed", /Gaminipura|Hatton/.test(more), false);
  eq("'<staff> updated candidate' footers lose the name", /Azeem|Ansar/.test(more), false);
  eq("a 9-digit mobile without the 0 is removed", /771234567/.test(more), false);
  eq("the referee section is dropped until the next section", /Dilhani|ABC/.test(more) || !/DECLARATION/.test(more), false);
  const last = deidentify("No 123/4 Kohalwila Road, \nHome: No: 540/D Ramahera Road, Hewagama, Kaduwela\n(0112) 234567890/0771234567 Plan weekly packing\nTP: -0112 23 4567\nMr. U.A.I.M. Udage Arachchi and Dr. H.M. Wijekoon\nMr T A K Viraj De Saa", null).text;
  eq("house numbers with no comma, slash-joined phones, TP labels and initialled names are removed", /Kohalwila|Ramahera|Hewagama|0771234567|4567|Udage|Wijekoon|Viraj/.test(last), false);
  eq("and the work text next to them is kept", /Plan weekly packing/.test(last), true);
  eq("a phone typed digit by digit is removed", deidentify("call 0 7 7 1 2 3 4 5 6 7 today", null).text, "call [phone] today");
  eq("'Manager @ Hayleys' reads as 'at'", deidentify("Manager @ Hayleys", null).text, "Manager at Hayleys");
  eq("address, birth date, passport, gender and marital status values are removed", /Temple|1985|November 1990|N1234567|Male|Married/.test(h.text), false);
  eq("the verbs 'addressed' and 'born leader' are kept", /Addressed customer complaints and born leader/.test(h.text), true);
  eq("dates of employment are kept", /2015 - 2019/.test(h.text), true);
  eq("nothing identifying left by the checks", residualContacts(h.text, "Thanuj Silva"), []);
  eq("the check flags a leftover address and birth date", residualContacts("Address: 12 Temple Road\nDOB: 12/04/1985", null).map((x) => x.type), ["address", "dob"]);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
