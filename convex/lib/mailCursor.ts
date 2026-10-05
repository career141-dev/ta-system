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

/** Messages handled per run — each can mean a download, an upload and a model call. */
export const POLL_BATCH = 15;

/**
 * Move the cursor only when this run saw the whole mailbox and handled all of
 * it. Otherwise it stays, and the next run fetches what is still unread again;
 * a message handled now is marked read, so it is not fetched twice.
 *
 * `markReadDisabled`: a deployment whose outbound lock leaves mail unread
 * (staging) would refetch the same messages forever with a held cursor, so it
 * keeps the old behaviour.
 */
export function advanceCursor(run: { fetchedAll: boolean; found: number; markReadDisabled: boolean }): boolean {
  if (run.markReadDisabled) return true;
  return run.fetchedAll && run.found <= POLL_BATCH;
}

/** Oldest first, so a burst is worked through in order and none waits forever. */
export function oldestFirst<T extends { receivedDateTime?: string }>(messages: T[]): T[] {
  return [...messages].sort((a, b) => (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? ""));
}
