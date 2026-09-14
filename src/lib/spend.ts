/**
 * The hard stop on money spent in the live-data test (13 September).
 *
 * Active whenever this build runs on a separate data folder (`C141_DATA_DIR`),
 * which is how the test runs. The cap is written here, not read from a setting,
 * so no environment variable or script can raise it.
 *
 * Before every paid call — a model, an embedding batch, a search — the most it
 * could cost is reserved. If what has been spent plus what is reserved plus
 * this call's maximum would pass the cap, the call does not happen. Afterwards
 * the reservation is replaced by what it actually cost. Every entry is written
 * to `spend.json` in the data folder, so the total survives restarts.
 */
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "@/data/dataDir";

export const TEST_CAP_USD = 5;

/** Per million tokens, OpenRouter prices checked 13 September. Unknown models reserve at the dearest rate. */
const PRICES: Record<string, { in: number; out: number }> = {
  "anthropic/claude-opus-5": { in: 5, out: 25 },
  "anthropic/claude-sonnet-5": { in: 2, out: 10 },
  "google/gemini-3.1-pro-preview": { in: 2, out: 12 },
  "google/gemini-3.6-flash": { in: 0.75, out: 3.75 },
  "google/gemini-2.5-flash-lite": { in: 0.1, out: 0.4 },
  "openai/gpt-4o-mini": { in: 0.15, out: 0.6 },
  "deepseek/deepseek-v4-flash": { in: 0.05, out: 0.1 },
  "openai/text-embedding-3-small": { in: 0.02, out: 0 },
};
const DEAREST = { in: 5, out: 25 };
/** A web-search plugin call can add retrieval fees on top of tokens. */
const SEARCH_ALLOWANCE_USD = 0.05;
const SERPER_PER_CREDIT_USD = 0.001;

export class SpendCapError extends Error {
  readonly spent: number;
  constructor(spent: number, wanted: number, label: string) {
    super(`Stopped before "${label}": $${spent.toFixed(4)} spent, this call could cost up to $${wanted.toFixed(4)}, and the test cap is $${TEST_CAP_USD}.`);
    this.spent = spent;
  }
}

interface Ledger {
  spent: number;
  entries: { at: number; label: string; usd: number }[];
}

export function capActive(): boolean {
  return (process.env.C141_DATA_DIR ?? "").trim().length > 0;
}

const file = () => path.join(dataDir(), "spend.json");
let reserved = 0;

/** A missing ledger is a fresh start; a ledger that exists but cannot be read stops all paid calls (14 September). */
function read(): Ledger {
  if (!fs.existsSync(file())) return { spent: 0, entries: [] };
  try {
    const l = JSON.parse(fs.readFileSync(file(), "utf8")) as Ledger;
    if (!Number.isFinite(l.spent) || !Array.isArray(l.entries)) throw new Error("bad shape");
    return l;
  } catch {
    throw new SpendCapError(Number.NaN, 0, "reading the spend ledger (it exists but is unreadable, so nothing paid will run until it is inspected)");
  }
}

export function spentSoFar(): number {
  return read().spent;
}

function price(model: string) {
  return PRICES[model.replace(/@.*$/, "")] ?? DEAREST;
}

/** The most a model call can cost: every input token plus the full output allowance. */
export function maxModelCost(model: string, promptChars: number, maxTokens: number, search = false): number {
  const p = price(model);
  // Characters/3 over-estimates tokens for English, which is the safe side.
  return (promptChars / 3) * (p.in / 1e6) + maxTokens * (p.out / 1e6) + (search ? SEARCH_ALLOWANCE_USD : 0);
}

export function modelCost(model: string, inputTokens: number, outputTokens: number): number {
  const p = price(model);
  return inputTokens * (p.in / 1e6) + outputTokens * (p.out / 1e6);
}

export const embedMaxCost = (model: string, chars: number) => (chars / 3) * (price(model).in / 1e6);
export const embedCost = (model: string, tokens: number) => tokens * (price(model).in / 1e6);
export const serperMaxCost = (credits: number) => credits * SERPER_PER_CREDIT_USD;

/**
 * Reserve before a paid call. Throws SpendCapError when it could pass the cap.
 * Returns the function to call afterwards with what it really cost (0 if it failed).
 */
export function reserve(label: string, maxUsd: number): (actualUsd: number) => void {
  if (!capActive()) return () => {};
  const spent = read().spent;
  if (spent + reserved + maxUsd > TEST_CAP_USD) throw new SpendCapError(spent + reserved, maxUsd, label);
  reserved += maxUsd;
  let settled = false;
  return (actualUsd: number) => {
    if (settled) return;
    settled = true;
    reserved -= maxUsd;
    const l = read();
    // Never record less than zero, and never trust a missing figure as free:
    // when a provider reports no cost, the reservation is kept as the cost.
    const usd = Number.isFinite(actualUsd) && actualUsd >= 0 ? actualUsd : maxUsd;
    l.spent = Math.round((l.spent + usd) * 1e6) / 1e6;
    l.entries.push({ at: Date.now(), label, usd: Math.round(usd * 1e6) / 1e6 });
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(l));
  };
}
