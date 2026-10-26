/**
 * The three guards around every call this server makes to the Convex backend
 * (26 Oct): share identical reads, cap how many calls are in flight, and stop
 * hammering a backend that is down.
 *
 * Pure and dependency-free so tests can drive them with a fake clock; the
 * wiring (fetch, the admin key) stays in convexServer.ts.
 */

/**
 * Identical reads share one request, and a read may opt in to being kept for a
 * few seconds.
 *
 * A layout and the pages inside it render at the same time and ask the backend
 * the same thing; each asked separately. Sharing the in-flight request is
 * always safe. Keeping the answer is not, so only a caller that says how stale
 * it may be gets that, and any write this process makes drops everything held
 * (`clear`) — a save is never followed by a read of the old value. A write by
 * ANOTHER process shows up only after `ttlMs`, which is why the lifetimes are
 * seconds and the callers are few.
 */
export class ReadCache {
  private inflight = new Map<string, Promise<unknown>>();
  private kept = new Map<string, { at: number; value: unknown }>();
  private epoch = 0;

  private now: () => number;
  private maxKept: number;

  constructor(now: () => number = Date.now, maxKept = 200) {
    this.now = now;
    this.maxKept = maxKept;
  }

  static key(path: string, args: Record<string, unknown>): string {
    return `${path}\u0000${JSON.stringify(args)}`;
  }

  async get<T>(key: string, load: () => Promise<T>, ttlMs = 0): Promise<T> {
    if (ttlMs > 0) {
      const hit = this.kept.get(key);
      if (hit && this.now() - hit.at < ttlMs) return structuredClone(hit.value) as T;
    }
    // Each reader gets its own copy: callers sort, push and edit what a read
    // returns, and one caller's edit must never show up in another's rows.
    const running = this.inflight.get(key);
    if (running) return structuredClone(await running) as T;

    const epoch = this.epoch;
    const p = load()
      .then((value) => {
        // A write landed while this read was out: its answer may predate it.
        if (ttlMs > 0 && epoch === this.epoch) {
          if (this.kept.size >= this.maxKept) this.kept.delete(this.kept.keys().next().value as string);
          this.kept.set(key, { at: this.now(), value: structuredClone(value) });
        }
        return value;
      })
      .finally(() => {
        if (this.inflight.get(key) === p) this.inflight.delete(key);
      });
    this.inflight.set(key, p);
    return p;
  }

  /** A write happened: nothing held, and nothing in flight, may be kept. */
  clear(): void {
    this.epoch++;
    this.kept.clear();
    this.inflight.clear();
  }
}

/**
 * At most `limit` calls in flight; the rest wait their turn in arrival order.
 *
 * node's fetch already reuses connections, but nothing capped them: 800 CVs or
 * one busy page opened hundreds of simultaneous requests against a backend that
 * runs a few functions at a time. Queued is slower than refused, and far
 * faster than a backend that has stopped answering.
 */
export class Gate {
  private active = 0;
  private waiting: Array<() => void> = [];

  private limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.active++;
    try {
      return await work();
    } finally {
      // Hand the slot straight to the next waiter; `active` is unchanged.
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}

/**
 * After `threshold` failures to reach the backend in a row, calls fail at once
 * for `coolMs` instead of each waiting out its own timeout and retries — one
 * dead backend froze every page for everybody (28 Sep). The first call after
 * the pause is let through to find out whether it is back.
 */
export class Breaker {
  private failures = 0;
  private openedAt = 0;

  private now: () => number;
  private threshold: number;
  private coolMs: number;

  constructor(now: () => number = Date.now, threshold = 5, coolMs = 5_000) {
    this.now = now;
    this.threshold = threshold;
    this.coolMs = coolMs;
  }

  /** Seconds left to wait, or 0 when a call may go ahead. */
  blockedFor(): number {
    if (this.failures < this.threshold) return 0;
    const left = this.coolMs - (this.now() - this.openedAt);
    if (left > 0) return Math.ceil(left / 1000);
    // Cooled: let one through. A failure re-opens it, a success closes it.
    this.openedAt = this.now();
    return 0;
  }

  success(): void {
    this.failures = 0;
  }

  failure(): void {
    if (++this.failures >= this.threshold) this.openedAt = this.now();
  }
}

/** Wait before retry `attempt` (1-based): 300ms doubling to 2s, ±25% so retries do not arrive together. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(300 * Math.pow(2, attempt - 1), 2000);
  return Math.round(base * (0.75 + random() * 0.5));
}
