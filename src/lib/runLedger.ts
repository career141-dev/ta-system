/**
 * The money ledger for one approved paid test run (14 September, P1 onward).
 *
 * Separate from `lib/spend.ts`, which guards the whole test folder with a $5
 * ceiling. This one is built for a single approved run with its own allowance:
 *
 *   - **Durable.** Every reservation and settlement is appended and flushed to
 *     disk before the request is sent, so a crash cannot lose a charge.
 *   - **Validated, not just parsed.** Every record is checked for type, fields,
 *     finite non-negative amounts and a legal sequence (unique reservations;
 *     settlements and reconciliations only for existing reservations, once
 *     each), on opening and again before each append. Any invalid record stops
 *     the run; history is never rewritten or reset.
 *   - **Fails closed.** A ledger that is unreadable, missing after start, or
 *     belongs to a different run, allowance, manifest or runner stops the run.
 *   - **Halts persist.** A halt (for example a charge above its reservation) is
 *     written to the ledger; no reservation is accepted until a person records
 *     a resolution with an approval reference.
 *   - **One process at a time.** A lock file is created exclusively; a stale
 *     lock is removed by a person, not by code.
 *   - **Conservative.** A charge counts at its real figure only when the
 *     provider reports it. A failed, unanswered or unreported request keeps its
 *     full reservation as "uncertain" until reconciled. A reservation left open
 *     by a crash counts at its maximum. Confirmed charges are recorded as
 *     reported, never capped at the reservation.
 */
import fs from "node:fs";
import path from "node:path";

type Line =
  | { type: "open"; runId: string; capUsd: number; manifestHash: string; runnerHash: string; at: number }
  | { type: "reserve"; key: string; maxUsd: number; at: number }
  | { type: "settle"; key: string; status: "confirmed"; usd: number; at: number }
  | { type: "settle"; key: string; status: "uncertain"; reason: string; at: number }
  | { type: "reconcile"; key: string; usd: number; source: string; at: number }
  | { type: "halt"; reason: string; at: number }
  | { type: "resolve"; approval: string; note: string; at: number };

export class LedgerError extends Error {}

export interface LedgerState {
  confirmedUsd: number;
  uncertainUsd: number;
  openUsd: number;
  /** Everything that could have been charged: confirmed + uncertain + open reservations. */
  committedUsd: number;
  capUsd: number;
  overrun: boolean;
  /** The unresolved halt, if any. */
  halted: string | null;
}

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
const isAmount = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
const isText = (s: unknown, max = 500): s is string => typeof s === "string" && s.length > 0 && s.length <= max;
const isTime = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/** Checks one record against the records before it. Returns the problem, or null. */
function problem(line: unknown, before: Line[], index: number): string | null {
  if (!line || typeof line !== "object" || Array.isArray(line)) return "not an object";
  const l = line as Record<string, unknown>;
  const keys = Object.keys(l).sort().join(",");
  const reserved = new Set(before.filter((x) => x.type === "reserve").map((x) => (x as { key: string }).key));
  const settled = new Set(before.filter((x) => x.type === "settle").map((x) => (x as { key: string }).key));
  const reconciled = new Set(before.filter((x) => x.type === "reconcile").map((x) => (x as { key: string }).key));
  if (!isTime(l.at)) return "bad time";
  if (index === 0 && l.type !== "open") return "first record is not the opening record";
  if (index > 0 && l.type === "open") return "second opening record";
  switch (l.type) {
    case "open":
      if (keys !== "at,capUsd,manifestHash,runId,runnerHash,type") return "opening record fields";
      if (!isText(l.runId, 40) || !isAmount(l.capUsd) || !/^[0-9a-f]{64}$/.test(String(l.manifestHash)) || !/^[0-9a-f]{64}$/.test(String(l.runnerHash))) return "opening record values";
      return null;
    case "reserve":
      if (keys !== "at,key,maxUsd,type") return "reservation fields";
      if (!isText(l.key, 200) || !isAmount(l.maxUsd) || l.maxUsd === 0) return "reservation values";
      if (reserved.has(l.key)) return `duplicate reservation ${l.key}`;
      return null;
    case "settle":
      if (!isText(l.key, 200) || !reserved.has(l.key)) return `settlement for unknown reservation ${String(l.key)}`;
      if (settled.has(l.key)) return `second settlement for ${l.key}`;
      if (l.status === "confirmed") return keys === "at,key,status,type,usd" && isAmount(l.usd) ? null : "confirmed settlement fields or amount";
      if (l.status === "uncertain") return keys === "at,key,reason,status,type" && isText(l.reason, 120) ? null : "uncertain settlement fields";
      return "unknown settlement status";
    case "reconcile":
      if (keys !== "at,key,source,type,usd" || !isText(l.key, 200) || !isAmount(l.usd) || !isText(l.source, 200)) return "reconciliation fields or amount";
      if (!reserved.has(l.key)) return `reconciliation for unknown reservation ${l.key}`;
      if (reconciled.has(l.key)) return `second reconciliation for ${l.key}`;
      return null;
    case "halt":
      return keys === "at,reason,type" && isText(l.reason, 300) ? null : "halt fields";
    case "resolve": {
      if (keys !== "approval,at,note,type" || !isText(l.approval, 200) || !isText(l.note, 300)) return "resolution fields";
      const lastHalt = before.map((x) => x.type).lastIndexOf("halt");
      const lastResolve = before.map((x) => x.type).lastIndexOf("resolve");
      return lastHalt > lastResolve ? null : "resolution without an open halt";
    }
    default:
      return `unknown record type ${String(l.type)}`;
  }
}

export class RunLedger {
  private readonly file: string;
  private readonly lock: string;
  private lockFd: number | null = null;
  private lines: Line[] = [];
  private readonly dir: string;
  private readonly runId: string;
  private readonly capUsd: number;
  private readonly manifestHash: string;
  private readonly runnerHash: string;

  constructor(dir: string, runId: string, capUsd: number, manifestHash: string, runnerHash = "0".repeat(64)) {
    this.dir = dir;
    this.runId = runId;
    this.capUsd = capUsd;
    this.manifestHash = manifestHash;
    this.runnerHash = runnerHash;
    this.file = path.join(dir, "ledger.jsonl");
    this.lock = path.join(dir, "ledger.lock");
  }

  open(now = Date.now()): LedgerState {
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      this.lockFd = fs.openSync(this.lock, "wx");
      fs.writeSync(this.lockFd, String(process.pid));
    } catch {
      throw new LedgerError(`Another runner holds ${this.lock}. If no runner is active, a person must remove the lock after checking.`);
    }
    try {
      const started = path.join(this.dir, "started");
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, "utf8");
        if (raw.length > 0 && !raw.endsWith("\n")) throw new LedgerError("Ledger ends in a partial record; the run will not continue until it is inspected.");
        const lines: Line[] = [];
        raw.split("\n").slice(0, -1).forEach((text, i) => {
          let parsed: unknown;
          try { parsed = JSON.parse(text); } catch { throw new LedgerError(`Ledger line ${i + 1} is unreadable; the run will not continue until it is inspected.`); }
          const why = problem(parsed, lines, i);
          if (why) throw new LedgerError(`Ledger line ${i + 1} is invalid (${why}); the run will not continue until it is inspected.`);
          lines.push(parsed as Line);
        });
        const first = lines[0] as Extract<Line, { type: "open" }> | undefined;
        if (!first) throw new LedgerError("Ledger has no opening line.");
        if (first.runId !== this.runId || first.capUsd !== this.capUsd || first.manifestHash !== this.manifestHash || first.runnerHash !== this.runnerHash) {
          throw new LedgerError("Ledger belongs to a different run, allowance, manifest or runner version.");
        }
        this.lines = lines;
      } else {
        if (fs.existsSync(started)) throw new LedgerError("This run was started but its ledger is missing.");
        this.append({ type: "open", runId: this.runId, capUsd: this.capUsd, manifestHash: this.manifestHash, runnerHash: this.runnerHash, at: now });
        fs.writeFileSync(started, new Date(now).toISOString());
      }
      return this.state();
    } catch (e) {
      this.close();
      throw e;
    }
  }

  close() {
    if (this.lockFd !== null) {
      fs.closeSync(this.lockFd);
      fs.rmSync(this.lock, { force: true });
      this.lockFd = null;
    }
  }

  private append(line: Line) {
    const why = problem(line, this.lines, this.lines.length);
    if (why) throw new LedgerError(`Refused to record an invalid entry (${why}).`);
    const fd = fs.openSync(this.file, "a");
    try {
      fs.writeSync(fd, JSON.stringify(line) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.lines.push(line);
  }

  state(): LedgerState {
    const reserved = new Map<string, number>();
    const settled = new Map<string, { status: "confirmed" | "uncertain"; usd: number }>();
    let halted: string | null = null;
    for (const l of this.lines) {
      if (l.type === "reserve") reserved.set(l.key, l.maxUsd);
      else if (l.type === "settle") settled.set(l.key, l.status === "confirmed" ? { status: "confirmed", usd: l.usd } : { status: "uncertain", usd: reserved.get(l.key)! });
      else if (l.type === "reconcile") settled.set(l.key, { status: "confirmed", usd: l.usd });
      else if (l.type === "halt") halted = l.reason;
      else if (l.type === "resolve") halted = null;
    }
    let confirmedUsd = 0, uncertainUsd = 0, openUsd = 0;
    for (const [key, max] of reserved) {
      const s = settled.get(key);
      if (!s) openUsd += max;
      else if (s.status === "confirmed") confirmedUsd += s.usd;
      else uncertainUsd += s.usd;
    }
    const committedUsd = r6(confirmedUsd + uncertainUsd + openUsd);
    return { confirmedUsd: r6(confirmedUsd), uncertainUsd: r6(uncertainUsd), openUsd: r6(openUsd), committedUsd, capUsd: this.capUsd, overrun: committedUsd > this.capUsd + 1e-9, halted };
  }

  /** Reserve before sending. Returns false, and records nothing, when it could pass the allowance or the run is halted. */
  reserve(key: string, maxUsd: number, now = Date.now()): boolean {
    if (this.lockFd === null) throw new LedgerError("Ledger is not open.");
    const st = this.state();
    if (st.halted) return false;
    if (st.committedUsd + maxUsd > this.capUsd + 1e-9) return false;
    this.append({ type: "reserve", key, maxUsd: r6(maxUsd), at: now });
    return true;
  }

  reservation(key: string): number | null {
    const l = this.lines.find((x) => x.type === "reserve" && x.key === key) as Extract<Line, { type: "reserve" }> | undefined;
    return l ? l.maxUsd : null;
  }

  /** Records the provider's charge exactly as reported (not rounded down to the reservation). */
  confirm(key: string, usd: number, now = Date.now()) {
    this.append({ type: "settle", key, status: "confirmed", usd, at: now });
  }

  uncertain(key: string, reason: string, now = Date.now()) {
    this.append({ type: "settle", key, status: "uncertain", reason: reason.slice(0, 120), at: now });
  }

  /** After checking the provider's record for this request. */
  reconcile(key: string, usd: number, source: string, now = Date.now()) {
    this.append({ type: "reconcile", key, usd, source, at: now });
  }

  halt(reason: string, now = Date.now()) {
    this.append({ type: "halt", reason: reason.slice(0, 300), at: now });
  }

  /** Only a person, with a reference to a fresh approval, clears a halt. */
  resolve(approval: string, note: string, now = Date.now()) {
    this.append({ type: "resolve", approval, note, at: now });
  }

  keys(): { key: string; status: "open" | "confirmed" | "uncertain" }[] {
    const out = new Map<string, "open" | "confirmed" | "uncertain">();
    for (const l of this.lines) {
      if (l.type === "reserve") out.set(l.key, "open");
      else if (l.type === "settle") out.set(l.key, l.status);
      else if (l.type === "reconcile") out.set(l.key, "confirmed");
    }
    return [...out].map(([key, status]) => ({ key, status }));
  }

  /** Per request id: every attempt's key and what it counts for now. */
  attemptsFor(id: string): { key: string; status: "open" | "confirmed" | "uncertain"; usd: number }[] {
    const st = new Map(this.keys().map((k) => [k.key, k.status]));
    const amount = (key: string) => {
      const rec = [...this.lines].reverse().find((l) => (l.type === "reconcile" || (l.type === "settle" && l.status === "confirmed")) && l.key === key) as { usd: number } | undefined;
      return rec ? rec.usd : this.reservation(key) ?? 0;
    };
    return [...st.keys()].filter((k) => k === id || k.startsWith(`${id}#`)).map((key) => ({ key, status: st.get(key)!, usd: amount(key) }));
  }
}
