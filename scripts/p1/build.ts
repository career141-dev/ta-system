/**
 * C141_DATA_DIR=$PWD/.data-live-test node --import ./tests/alias.mjs scripts/p1/build.ts \
 *   [--cap 0.40] [--max-tokens 600] [--expected-out 300] [--prices <zdr endpoints snapshot.json>]
 *
 * Freezes P1 (14 September). Free and local: no request is sent.
 *   - De-identifies each CV (contact details replaced, dates kept) and checks the
 *     exact outgoing text for leftovers; any leftover stops the build.
 *   - Renders every request (system prompt v3 + job + candidate) per model route.
 *   - Writes runs/P1/manifest.json (hashes, routes and prices, limits, attempt
 *     policy, expected and worst-case charge), runs/P1/requests.jsonl, and
 *     review/screenset-v3.json for the free laptop baseline on the same inputs.
 */
import fs from "node:fs";
import path from "node:path";
if (!(process.env.C141_DATA_DIR ?? "").trim()) { console.error("Set C141_DATA_DIR to the test folder."); process.exit(1); }

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const { repo } = await import("@/data/store");
const { dataDir } = await import("@/data/dataDir");
const { reviewJobs, reviewList } = await import("@/lib/review");
const { deidentify, residualContacts } = await import("@/lib/deid");
const { requestHash, requestMaxUsd, inputTokenBound, sha256, manifestHash } = await import("@/lib/p1Runner");
import type { FrozenRequest, Route } from "@/lib/p1Runner";

const capUsd = Number(arg("cap", "0.40"));
const maxTokens = Number(arg("max-tokens", "600"));
const expectedOut = Number(arg("expected-out", "300"));
const pricesFile = arg("prices", "");

const system = fs.readFileSync(path.join(process.cwd(), "tools/embed/screen_prompt_v3.txt"), "utf8");

// Routes pinned to a named no-retention endpoint at a published standard quantisation.
// GPT-5.6 Luna is excluded: its only no-retention endpoints do not list max_tokens support, so its cost cannot be bounded.
const ROUTES: Route[] = [
  { model: "deepseek/deepseek-v4.1-flash", provider: "deepinfra/fp8", quantization: "fp8", inPerM: 0.2, outPerM: 0.6 },
  { model: "z-ai/glm-5.3-flash", provider: "z-ai/fp8", quantization: "fp8", inPerM: 0.15, outPerM: 0.5 },
];
let priceCheck: Record<string, unknown> = { source: "not checked" };
if (pricesFile) {
  const zdr = JSON.parse(fs.readFileSync(pricesFile, "utf8")).data as { model_id: string; tag: string; quantization: string; pricing: { prompt: string; completion: string }; supported_parameters?: string[] }[];
  priceCheck = { source: path.basename(pricesFile), checkedAt: fs.statSync(pricesFile).mtime.toISOString(), routes: {} as Record<string, unknown> };
  for (const r of ROUTES) {
    const e = zdr.find((x) => x.model_id === r.model && x.tag === r.provider);
    if (!e) { console.error(`No no-retention endpoint ${r.provider} for ${r.model} in the snapshot.`); process.exit(1); }
    const inP = Number(e.pricing.prompt) * 1e6, outP = Number(e.pricing.completion) * 1e6;
    const params = e.supported_parameters ?? [];
    if (inP > r.inPerM + 1e-9 || outP > r.outPerM + 1e-9) { console.error(`${r.model} on ${r.provider} costs more than frozen.`); process.exit(1); }
    if (e.quantization !== r.quantization) { console.error(`${r.model} on ${r.provider} quantisation ${e.quantization}, frozen ${r.quantization}.`); process.exit(1); }
    if (!params.includes("max_tokens")) { console.error(`${r.model} on ${r.provider} does not list max_tokens.`); process.exit(1); }
    (priceCheck.routes as Record<string, unknown>)[r.model] = { provider: r.provider, quantization: e.quantization, inPerM: inP, outPerM: outP, maxTokensSupported: true, reasoningParam: params.includes("reasoning") };
  }
}

interface Item { job: number; no: number; id: string; profile: Record<string, unknown> }
const jobs: Record<number, string> = {};
const items: Item[] = [];
const deidTotals: Record<string, number> = {};
const residual: Record<string, number> = {};

for (const job of reviewJobs()) {
  const o = repo.openings()[job - 1];
  const jd = deidentify(o.jdMarkdown.split("## Requirements (from the job record)")[0].trim(), null).text.slice(0, 6000);
  jobs[job] = jd;
  reviewList(job).forEach((id, i) => {
    const c = repo.candidate(id)!;
    const d = deidentify(repo.cvTextFor(id) ?? "", c.fullName);
    for (const [k, n] of Object.entries(d.replaced)) deidTotals[k] = (deidTotals[k] ?? 0) + n;
    const clean = (s: string | null | undefined) => deidentify(s ?? "", c.fullName).text;
    items.push({
      job, no: i + 1, id,
      profile: {
        currentTitle: clean(c.currentTitle), employer: clean(c.currentEmployer), years: c.totalExperienceYears, location: clean(c.location),
        history: c.workHistory.slice(0, 8).map((h) => clean(`${h.title} — ${h.employer} (${h.fromYear || "?"}–${h.toYear ?? "now"})`)),
        education: clean([c.educationDegree, c.educationInstitution].filter(Boolean).join(", ")),
        cv: d.text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000),
      },
    });
  });
}

const userFor = (it: Item) => {
  const p = it.profile as { currentTitle: string; employer: string; years: number | null; location: string; history: string[]; education: string; cv: string };
  return `JOB DESCRIPTION\n${jobs[it.job]}\n\nCANDIDATE\nCurrent designation: ${p.currentTitle}\nCurrent employer: ${p.employer}\nTotal years of experience: ${p.years}\nLocation: ${p.location}\nCareer (most recent first): ${p.history.join(" | ")}\nEducation: ${p.education}\n\nCV TEXT\n${p.cv}`;
};

// Models take turns person by person, so a stop part-way leaves both models with comparable coverage.
const requests: FrozenRequest[] = [];
for (const it of items) {
  for (const [ri, route] of ROUTES.entries()) {
    const user = userFor(it);
    const fullName = repo.candidate(it.id)?.fullName;
    for (const f of [...residualContacts(user, fullName), ...residualContacts(system, null)]) residual[f.type] = (residual[f.type] ?? 0) + 1;
    const maxInputTokens = inputTokenBound(system, user);
    requests.push({ id: `${route.model.split("/")[1]}:${it.job}:${it.no}`, job: it.job, no: it.no, candidateId: it.id, route: ri, system, user, maxInputTokens, maxUsd: requestMaxUsd(route, maxInputTokens, maxTokens) });
  }
}

if (Object.keys(residual).length) {
  console.error(`Build stopped: contact details still present in outgoing text (${JSON.stringify(residual)}). Nothing written.`);
  process.exit(1);
}

const chars = requests.map((r) => r.system.length + r.user.length);
const expectedUsd = requests.reduce((s, r) => { const rt = ROUTES[r.route]; return s + ((r.system.length + r.user.length) / 4 * rt.inPerM + expectedOut * rt.outPerM) / 1e6; }, 0);
const worstUsd = requests.reduce((s, r) => s + r.maxUsd, 0); // sum of reservations under the byte bound
const perModel = ROUTES.map((rt, ri) => {
  const rs = requests.filter((r) => r.route === ri);
  return { model: rt.model, requests: rs.length, expectedUsd: +rs.reduce((s, r) => s + ((r.system.length + r.user.length) / 4 * rt.inPerM + expectedOut * rt.outPerM) / 1e6, 0).toFixed(4), worstUsd: +rs.reduce((s, r) => s + r.maxUsd, 0).toFixed(4) };
});

const dir = path.join(dataDir(), "runs", "P1");
if (fs.existsSync(path.join(dir, "started"))) { console.error("P1 has already started; a started run is never re-frozen."); process.exit(1); }
fs.mkdirSync(dir, { recursive: true });

const manifest = {
  runId: "P1",
  capUsd,
  maxTokens,
  temperature: 0,
  routes: ROUTES,
  requestHashes: Object.fromEntries(requests.map((r) => [r.id, requestHash(r)])),
  frozenAt: new Date().toISOString(),
  question: "Does a cheap hosted model with the evidence-quote screen beat the free laptop baseline on the same frozen inputs (120 development decisions, jobs 4, 9, 12)?",
  promptSha256: sha256(system),
  inputsSha256: sha256(JSON.stringify(items.map((it) => ({ job: it.job, no: it.no, id: it.id, user: userFor(it) })))),
  people: items.length,
  requests: requests.length,
  reasoning: "requested off ({enabled:false}); any reasoning tokens still fall inside max_tokens",
  attemptPolicy: "one attempt; one retry only when no HTTP response arrived; HTTP errors not retried; no fallback provider",
  chargePolicy: "reserve worst case per request before sending; provider-reported cost confirms; anything else stays uncertain at the reservation until reconciled",
  deidentification: { replaced: deidTotals, residualFound: 0, note: "de-identified, not anonymous: employers and careers can still identify a person" },
  priceCheck,
  inputChars: { min: Math.min(...chars), max: Math.max(...chars), mean: Math.round(chars.reduce((a, b) => a + b, 0) / chars.length) },
  inputTokenBound: { min: Math.min(...requests.map((r) => r.maxInputTokens)), max: Math.max(...requests.map((r) => r.maxInputTokens)) },
  cost: {
    expectedUsd: +expectedUsd.toFixed(4),
    worstCaseUsd: +worstUsd.toFixed(4),
    expectedAssumptions: `input tokens = characters/4 (estimate); ${expectedOut} output tokens per answer`,
    worstCaseAssumptions: `reservation bound: input tokens ≤ UTF-8 bytes + ${64} chat overhead (holds for byte-level BPE tokenizers; a provider reporting more halts the run); every answer uses all ${maxTokens} output tokens; no retries. Not a guaranteed maximum: provider-side charges outside tokens, retries, and the one request that triggers a halt can add to it; the dedicated key limit is the outer bound`,
    perModel,
    capBehaviour: `the run stops before any request whose worst case would take committed spend past $${capUsd}; everything after is reported as not run`,
    feeNote: "amounts are provider usage; OpenRouter's ~5.5% fee applies when credits are bought",
  },
};
// The laptop baseline must see exactly the same inputs. Write the set once; afterwards only verify it.
const laptopFile = path.join(dataDir(), "review", "screenset-v3.json");
const laptopItems = items.map((it) => ({ job: it.job, no: it.no, id: it.id, profile: it.profile }));
if (fs.existsSync(laptopFile)) {
  const existing = JSON.parse(fs.readFileSync(laptopFile, "utf8")) as { jobs: { n: number; jd: string }[]; items: { job: number; no: number; id: string; profile: unknown }[] };
  const same = JSON.stringify(existing.items.map((it) => ({ job: it.job, no: it.no, id: it.id, profile: it.profile }))) === JSON.stringify(laptopItems)
    && JSON.stringify(existing.jobs.map((j) => [j.n, j.jd])) === JSON.stringify(Object.entries(jobs).map(([n, jd]) => [Number(n), jd]));
  if (!same) { console.error("The laptop baseline's inputs differ from these requests; the comparison would not be like for like. Nothing written."); process.exit(1); }
} else {
  fs.writeFileSync(laptopFile, JSON.stringify({ jobs: Object.entries(jobs).map(([n, jd]) => ({ n: Number(n), jd })), items: laptopItems.map((it) => ({ ...it, decisions: {} })) }));
}
fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 1));
fs.writeFileSync(path.join(dir, "requests.jsonl"), requests.map((r) => JSON.stringify(r)).join("\n") + "\n");

console.log(JSON.stringify({ manifestSha256: manifestHash(manifest as never), people: items.length, requests: requests.length, deid: deidTotals, inputChars: manifest.inputChars, cost: manifest.cost }, null, 1));
process.exit(0);
