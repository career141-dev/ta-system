/**
 * Runner for a frozen, approved paid screening experiment (P1, 14 September).
 *
 * Deliberately does not use `lib/ai.ts`. Every request follows one policy:
 *
 *   - The request (text, route, candidate, job, reservation) is exactly what
 *     the manifest froze (hash-checked).
 *   - One pinned provider route per model: no fallback, no-retention only, a
 *     fixed quantisation, and `require_parameters`.
 *   - Reserve the request's bound in the run ledger first. The bound assumes at
 *     most one token per UTF-8 byte of input (true for byte-level BPE
 *     tokenizers) plus fixed chat overhead, and the full output allowance.
 *     If the provider reports more input tokens than that, the assumption is
 *     broken and the run halts.
 *   - A confirmed charge above the attempt's own reservation halts the run
 *     before any further request, and the halt persists across restarts.
 *   - At most one retry, and only when no response arrived at all. HTTP errors
 *     are not retried. Three failed requests in a row stop the run.
 *   - A charge counts at its real figure only when the provider reports it;
 *     otherwise the full reservation stays uncertain.
 *   - An answer that does not match the v3 schema is `invalid_output`, never ok.
 *   - `writeFinalReport` covers every manifest request exactly once, including
 *     those not run, with the ledger's figure for all attempts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import type { RunLedger } from "./runLedger";
import { answerFlags, answerProblems, type ScreenAnswer } from "./screenAnswer";

export interface Route {
  model: string;
  provider: string;
  quantization: string;
  inPerM: number;
  outPerM: number;
}

export interface FrozenRequest {
  id: string;
  job: number;
  no: number;
  candidateId: string;
  route: number;
  system: string;
  user: string;
  maxUsd: number;
  /** The input token bound the reservation was built on. */
  maxInputTokens: number;
}

export interface Manifest {
  runId: string;
  capUsd: number;
  maxTokens: number;
  temperature: number;
  routes: Route[];
  requestHashes: Record<string, string>;
}

export type ResultStatus = "ok" | "truncated" | "invalid_output" | "http_error" | "no_response" | "not_run";

export interface RequestResult {
  id: string;
  job: number;
  no: number;
  candidateId: string;
  model: string;
  status: ResultStatus;
  attempts: number;
  httpStatus: number | null;
  generationId: string | null;
  finishReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  costStatus: "confirmed" | "uncertain" | "none";
  parsed: unknown;
  problems: string[];
  flags: string[];
  raw: string | null;
  stopReason?: string;
}

/** Chat-template overhead allowance per request, in tokens. */
export const CHAT_OVERHEAD_TOKENS = 64;

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const requestHash = (r: FrozenRequest) =>
  sha256(JSON.stringify({ id: r.id, job: r.job, no: r.no, candidateId: r.candidateId, route: r.route, system: r.system, user: r.user, maxUsd: r.maxUsd, maxInputTokens: r.maxInputTokens }));
export const manifestHash = (m: Manifest) => sha256(JSON.stringify(m));

/** Input token bound: one token per UTF-8 byte at most, plus chat overhead. */
export const inputTokenBound = (system: string, user: string) => Buffer.byteLength(system, "utf8") + Buffer.byteLength(user, "utf8") + CHAT_OVERHEAD_TOKENS;

/** The most one request can cost under that bound and the full output allowance. */
export function requestMaxUsd(route: Route, inputTokens: number, maxTokens: number): number {
  return (inputTokens * route.inPerM + maxTokens * route.outPerM) / 1e6;
}

export function bodyFor(m: Manifest, r: FrozenRequest) {
  const route = m.routes[r.route];
  return {
    model: route.model,
    messages: [{ role: "system", content: r.system }, { role: "user", content: r.user }],
    max_tokens: m.maxTokens,
    temperature: m.temperature,
    usage: { include: true },
    reasoning: { enabled: false },
    provider: {
      order: [route.provider],
      allow_fallbacks: false,
      require_parameters: true,
      zdr: true,
      data_collection: "deny",
      quantizations: [route.quantization],
    },
  };
}

function firstJsonObject(text: string): unknown {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

export async function runFrozen(opts: {
  manifest: Manifest;
  requests: FrozenRequest[];
  ledger: RunLedger;
  key: string;
  resultsFile: string;
  fetchImpl?: typeof fetch;
  log?: (s: string) => void;
}): Promise<{ results: RequestResult[]; stopped: string | null }> {
  const { manifest, requests, ledger, key, resultsFile } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const log = opts.log ?? (() => {});

  for (const r of requests) {
    if (manifest.requestHashes[r.id] !== requestHash(r)) throw new Error(`Request ${r.id} does not match the frozen manifest.`);
  }
  if (Object.keys(manifest.requestHashes).length !== requests.length || new Set(requests.map((r) => r.id)).size !== requests.length) {
    throw new Error("Requests do not match the manifest one-to-one.");
  }

  const done = new Map<string, RequestResult>();
  if (fs.existsSync(resultsFile)) {
    for (const line of fs.readFileSync(resultsFile, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(line) as RequestResult;
      if (r.status !== "not_run") done.set(r.id, r);
    }
  }
  const ledgerKeys = new Set(ledger.keys().map((k) => k.key.split("#")[0]));
  const write = (r: RequestResult) => fs.appendFileSync(resultsFile, JSON.stringify(r) + "\n");

  let stopped: string | null = ledger.state().halted ? `halted: ${ledger.state().halted}` : null;
  let failuresInARow = 0;
  const results: RequestResult[] = [];
  for (const r of requests) {
    if (done.has(r.id)) { results.push(done.get(r.id)!); continue; }
    const route = manifest.routes[r.route];
    const base: RequestResult = {
      id: r.id, job: r.job, no: r.no, candidateId: r.candidateId, model: route.model, status: "not_run", attempts: 0, httpStatus: null,
      generationId: null, finishReason: null, inputTokens: null, outputTokens: null, costUsd: null, costStatus: "none", parsed: null,
      problems: [], flags: [], raw: null,
    };
    if (stopped) { results.push({ ...base, stopReason: stopped }); continue; }
    if (ledgerKeys.has(r.id)) {
      const res: RequestResult = { ...base, status: "no_response", costStatus: "uncertain", stopReason: "interrupted in an earlier process; not resent" };
      write(res); results.push(res); continue;
    }

    let res: RequestResult = base;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const ledgerKey = attempt === 1 ? r.id : `${r.id}#${attempt}`;
      if (!ledger.reserve(ledgerKey, r.maxUsd)) {
        const st = ledger.state();
        stopped = st.halted ? `halted: ${st.halted}` : `allowance: $${st.committedUsd.toFixed(4)} committed, next request could cost $${r.maxUsd.toFixed(4)}, allowance $${manifest.capUsd}`;
        res = { ...res, stopReason: stopped };
        break;
      }
      res = { ...res, attempts: attempt };
      let response: Response;
      try {
        response = await doFetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "X-Title": `Career141 ${manifest.runId}` },
          body: JSON.stringify(bodyFor(manifest, r)),
        });
      } catch (e) {
        ledger.uncertain(ledgerKey, `no response: ${(e as Error).name}`);
        res = { ...res, status: "no_response", costStatus: "uncertain" };
        log(`${r.id} no response (attempt ${attempt})`);
        if (attempt < 2) continue;
        break;
      }
      res = { ...res, httpStatus: response.status };
      if (!response.ok) {
        ledger.uncertain(ledgerKey, `http ${response.status}`);
        res = { ...res, status: "http_error", costStatus: "uncertain", raw: (await response.text().catch(() => "")).slice(0, 500) };
        break;
      }
      const json = (await response.json().catch(() => null)) as {
        id?: string;
        choices?: { finish_reason?: string; message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      } | null;
      const cost = json?.usage?.cost;
      const confirmed = typeof cost === "number" && Number.isFinite(cost) && cost >= 0;
      if (confirmed) ledger.confirm(ledgerKey, cost);
      else ledger.uncertain(ledgerKey, "provider reported no cost");

      // Halts, persisted before anything else is sent.
      const reserved = ledger.reservation(ledgerKey) ?? r.maxUsd;
      if (confirmed && cost > reserved + 1e-9) ledger.halt(`${ledgerKey} charged $${cost} above its reservation $${reserved}`);
      const promptTokens = json?.usage?.prompt_tokens;
      if (typeof promptTokens === "number" && promptTokens > r.maxInputTokens) ledger.halt(`${ledgerKey} used ${promptTokens} input tokens above the bound ${r.maxInputTokens}`);

      const text = json?.choices?.[0]?.message?.content ?? "";
      const finish = json?.choices?.[0]?.finish_reason ?? null;
      const parsed = firstJsonObject(text);
      const problems = parsed === null ? ["no JSON object"] : answerProblems(parsed);
      res = {
        ...res,
        generationId: json?.id ?? null,
        finishReason: finish,
        inputTokens: json?.usage?.prompt_tokens ?? null,
        outputTokens: json?.usage?.completion_tokens ?? null,
        costUsd: confirmed ? cost : null,
        costStatus: confirmed ? "confirmed" : "uncertain",
        raw: text.slice(0, 4000),
        parsed,
        problems,
        flags: problems.length === 0 ? answerFlags(parsed as ScreenAnswer, `${r.system}\n${r.user}`) : [],
        status: finish === "length" ? "truncated" : problems.length === 0 ? "ok" : "invalid_output",
      };
      break;
    }

    if (res.attempts > 0) write(res);
    results.push(res);
    const st = ledger.state();
    if (!stopped && st.halted) stopped = `halted: ${st.halted}`;
    failuresInARow = res.status === "no_response" || res.status === "http_error" ? failuresInARow + 1 : 0;
    if (failuresInARow >= 3 && !stopped) stopped = `failures: ${failuresInARow} requests in a row failed (last: ${res.status}${res.httpStatus ? ` ${res.httpStatus}` : ""})`;
    if (st.overrun && !stopped) stopped = `overrun: $${st.committedUsd.toFixed(4)} committed against $${manifest.capUsd}`;
  }
  return { results, stopped };
}

export interface FinalRow extends RequestResult {
  /** Every attempt's ledger entry, and what the request costs across all of them. */
  ledgerAttempts: { key: string; status: "open" | "confirmed" | "uncertain"; usd: number }[];
  ledgerUsd: number;
  ledgerStatus: "confirmed" | "uncertain" | "none";
}

/**
 * One row per manifest request, in manifest order, no omissions or duplicates:
 * the latest result for each id (or not_run with the stop reason), and the
 * ledger's figure across all its attempts. Returns the coverage summary.
 */
export function writeFinalReport(opts: { manifest: Manifest; requests: FrozenRequest[]; ledger: RunLedger; resultsFile: string; stopped: string | null; outFile: string }) {
  const latest = new Map<string, RequestResult>();
  if (fs.existsSync(opts.resultsFile)) {
    for (const line of fs.readFileSync(opts.resultsFile, "utf8").split("\n").filter(Boolean)) {
      const r = JSON.parse(line) as RequestResult;
      latest.set(r.id, r);
    }
  }
  const rows: FinalRow[] = opts.requests.map((r) => {
    const route = opts.manifest.routes[r.route];
    const res: RequestResult = latest.get(r.id) ?? {
      id: r.id, job: r.job, no: r.no, candidateId: r.candidateId, model: route.model, status: "not_run", attempts: 0, httpStatus: null,
      generationId: null, finishReason: null, inputTokens: null, outputTokens: null, costUsd: null, costStatus: "none", parsed: null,
      problems: [], flags: [], raw: null, stopReason: opts.stopped ?? "not reached",
    };
    const attempts = opts.ledger.attemptsFor(r.id);
    const ledgerUsd = Math.round(attempts.reduce((s, a) => s + a.usd, 0) * 1e6) / 1e6;
    const ledgerStatus = attempts.length === 0 ? "none" : attempts.every((a) => a.status === "confirmed") ? "confirmed" : "uncertain";
    return { ...res, ledgerAttempts: attempts, ledgerUsd, ledgerStatus };
  });
  const ids = rows.map((x) => x.id);
  if (new Set(ids).size !== ids.length || ids.length !== Object.keys(opts.manifest.requestHashes).length) throw new Error("Final report does not cover the manifest exactly once.");
  const byModel: Record<string, Record<string, number>> = {};
  for (const row of rows) {
    const m = (byModel[row.model] ??= {});
    m[row.status] = (m[row.status] ?? 0) + 1;
  }
  const summary = { stopped: opts.stopped, requests: rows.length, statusByModel: byModel, ledger: opts.ledger.state() };
  fs.writeFileSync(opts.outFile, JSON.stringify({ summary, rows }, null, 1));
  return summary;
}
