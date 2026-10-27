export const TRACKING_RETENTION_MS = 30 * 86400000;
export const canViewTaTracking = (role: string) => role === "admin" || role === "ta_lead";
export const canPairTaTracking = (role: string) => canViewTaTracking(role) || role === "ta" || role === "ta_support";

export interface TrackingRow {
  date: string;
  domain: string;
  foregroundMs: number;
  activeMs: number;
  idleMs: number;
  clicks: number;
  scrolls: number;
  movementSeconds: number;
  lastSeen: number;
}
export interface TrackingReportRow extends TrackingRow { userId: string; name: string }
export interface TrackingReport {
  rows: TrackingReportRow[];
  devices: { userId: string; lastSyncAt: number; enabled: boolean }[];
}
export function trackingDay(time = Date.now()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo", year: "numeric", month: "2-digit", day: "2-digit" }).format(time);
}
export function validTrackingDate(value: string, now = Date.now()) {
  const start = Date.parse(`${value}T00:00:00+05:30`);
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(start) && trackingDay(start) === value && value <= trackingDay(now) && start + 86400000 > now - TRACKING_RETENTION_MS;
}
export function validateTrackingRows(input: unknown, now = Date.now()): TrackingRow[] {
  if (!Array.isArray(input) || input.length > 200) throw new Error("Send at most 200 website rows at a time.");
  return input.map((value) => {
    if (!value || typeof value !== "object") throw new Error("Invalid website row.");
    const row = value as TrackingRow;
    if (typeof row.date !== "string" || !validTrackingDate(row.date, now)) throw new Error("Date must be within the last 30 days.");
    if (typeof row.domain !== "string" || row.domain.length > 253 || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(row.domain) || row.domain.includes("..")) throw new Error("Send website domains only.");
    const fields = ["foregroundMs", "activeMs", "idleMs", "clicks", "scrolls", "movementSeconds", "lastSeen"] as const;
    for (const field of fields) if (!Number.isSafeInteger(row[field]) || row[field] < 0) throw new Error("Invalid activity count.");
    if (row.foregroundMs > 86400000 || row.activeMs + row.idleMs !== row.foregroundMs || row.movementSeconds > 86400 || row.clicks > 10000000 || row.scrolls > 10000000) throw new Error("Invalid daily totals.");
    if (row.lastSeen < now - TRACKING_RETENTION_MS || row.lastSeen > now + 60000 || trackingDay(row.lastSeen - 1) !== row.date && trackingDay(row.lastSeen) !== row.date) throw new Error("Invalid activity timestamp.");
    return Object.fromEntries(["date", "domain", ...fields].map(field => [field, row[field as keyof TrackingRow]])) as unknown as TrackingRow;
  });
}
