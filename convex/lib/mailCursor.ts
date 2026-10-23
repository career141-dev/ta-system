// convex/lib/mailCursor.ts
//
// When the mailbox poller may move its "read up to" time forward. Pure, so it
// is tested alone (tests/mailcursor.test.ts).
//
// The poller reads unread mail received since the cursor (less 5 minutes) and
// handles at most POLL_BATCH messages a run. Until 5 October it moved the
// cursor to the run's start every time. Messages 16 and on were left unread
// but fell behind the cursor, so no later run fetched them again: a burst of
// LinkedIn applications lost all but 15, with no record. A failed Graph read
// moved it on too, skipping the outage.

//
// Holding the cursor still at the old time was its own failure (23 October):
// every run then listed everything since — read mail included, with bodies —
// and on linkedin@ that grew past the 64 MB an action may use. Every run ran
// out of memory before handling one message, and linkedin@ was not read from
// 5 to 23 October. Now a run lists ids and dates only, downloads just the
// messages it handles, and moves the cursor up to the oldest one still
// waiting, so the window shrinks as the backlog is worked through.

/** Messages handled per run — each can mean a download, an upload and a model call. */
export const POLL_BATCH = 15;
/** The shared application mailboxes take more a run, to work through a burst. */
export const LOG_POLL_BATCH = 40;

export function pollBatch(readsByLog: boolean): number {
  return readsByLog ? LOG_POLL_BATCH : POLL_BATCH;
}

/**
 * Where the cursor goes after a run, or null to leave it where it is.
 *
 * - The mailbox could not be listed in full: left alone, so nothing is skipped.
 * - Messages are still waiting: the oldest of them, so the next run starts
 *   there and lists less as the backlog shrinks.
 * - Nothing waiting: the run's start.
 *
 * `markReadDisabled`: a deployment whose outbound lock leaves mail unread
 * (staging), reading by the read flag, would see the same messages forever, so
 * it moves to the run's start as before.
 */
export function nextCursor(run: {
  fetchedAll: boolean;
  waiting: { receivedDateTime?: string }[];
  runStart: string;
  markReadDisabled: boolean;
}): string | null {
  if (!run.fetchedAll) return null;
  if (run.markReadDisabled) return run.runStart;
  const oldest = run.waiting.map((m) => m.receivedDateTime ?? "").filter(Boolean).sort()[0];
  return oldest ?? run.runStart;
}

/** A mailbox not read in full for this long is reported to the desk. */
export const STALLED_AFTER_MS = 60 * 60_000;

/**
 * Whether a mailbox has stopped being read, and the desk has not been told
 * about this stall yet. `okAt` is the last run that listed it in full.
 */
export function stalledUnreported(o: { okAt?: string | null; reportedAt?: string | null; now: number }): boolean {
  if (!o.okAt) return false;
  if (o.now - Date.parse(o.okAt) < STALLED_AFTER_MS) return false;
  return !o.reportedAt || o.reportedAt < o.okAt;
}

/** Oldest first, so a burst is worked through in order and none waits forever. */
export function oldestFirst<T extends { receivedDateTime?: string }>(messages: T[]): T[] {
  return [...messages].sort((a, b) => (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? ""));
}

/**
 * The shared application mailboxes are read by a log of what was handled, not
 * by the read flag (5 October): an email someone opened in Outlook first was
 * never picked up. job@ keeps the read flag — its mail is candidates' replies,
 * and handling an old reply again would answer it twice.
 */
export function readsByLog(mailbox: string, linkedinShared?: string): boolean {
  const m = mailbox.trim().toLowerCase();
  return m === "linkedin@career141.com" || m === "cv@career141.com" || (!!linkedinShared && m === linkedinShared.trim().toLowerCase());
}

/**
 * What still needs handling: not in the log, and not mail the old read-flag
 * poller had already handled (read, and received before the log began).
 */
export function notYetHandled<T extends { id: string; isRead?: boolean; receivedDateTime?: string }>(
  messages: T[],
  logged: Set<string>,
  logSince: string,
): T[] {
  return messages.filter((m) => !logged.has(m.id) && !(m.isRead && (m.receivedDateTime ?? "") < logSince));
}
