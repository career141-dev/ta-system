/**
 * `work`, or `fallback` once `ms` have passed — whichever comes first (6 Oct).
 *
 * For readers that can wait for ever on a broken file: an action that waits
 * holds one of the backend's six action slots until the 300 s cut-off. A
 * rejection that arrives after the time is up is swallowed, not left unhandled.
 * Pure, so tests/within.test.ts runs it directly.
 */
export function within<T>(work: Promise<T>, ms: number, fallback: T, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      console.warn(`[within] ${what} gave no answer in ${ms / 1000}s — moving on.`);
      resolve(fallback);
    }, ms);
  });
  work.catch(() => undefined);
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
