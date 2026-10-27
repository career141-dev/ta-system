export const MAX_GAP_MS = 75000;
export const RETENTION_MS = 30 * 86400000;

export function domainOf(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.hostname.toLowerCase().replace(/^www\./, '');
  } catch { return null; }
}

export function dayKey(time) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Colombo', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(time));
}

export function newState() {
  return { enabled: false, name: '', consent: false, cursor: null, rows: {}, gapsMs: 0, updatedAt: 0 };
}

// Only checkpointed intervals are credited. Long sleep/crash gaps are never
// silently assigned to the last website. Buckets split at Colombo midnight.
export function settle(state, now) {
  const cursor = state.cursor;
  if (!cursor) return;
  const elapsed = now - cursor.at;
  if (elapsed <= 0) { state.cursor = null; return; }
  if (elapsed > MAX_GAP_MS) {
    state.gapsMs += elapsed;
    state.cursor = null;
    return;
  }
  let start = cursor.at;
  while (start < now) {
    const date = dayKey(start);
    const nextMidnight = Date.parse(date + 'T00:00:00+05:30') + 86400000;
    const end = Math.min(now, nextMidnight);
    const key = JSON.stringify([date, state.name, cursor.domain]);
    const row = state.rows[key] ||= {
      date, name: state.name, domain: cursor.domain,
      foregroundMs: 0, activeMs: 0, idleMs: 0,
      clicks: 0, scrolls: 0, movementSeconds: 0, lastSeen: end
    };
    row.foregroundMs += end - start;
    row[cursor.active ? 'activeMs' : 'idleMs'] += end - start;
    row.lastSeen = end;
    start = end;
  }
  state.cursor = null;
}

export function prune(state, now) {
  for (const [key, row] of Object.entries(state.rows)) {
    if (row.lastSeen < now - RETENTION_MS) delete state.rows[key];
  }
}
