import { colomboDaysBetween } from "./calendar";

export { colomboDaysBetween };

export function relDays(ts: number | null, now = Date.now()): string {
  if (!ts) return "—";
  const d = colomboDaysBetween(ts, now);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  return `${d}d ago`;
}

export function inHours(ts: number): string {
  const h = (ts - Date.now()) / 3_600_000;
  if (h < 0) return `${Math.abs(Math.round(h))}h ago`;
  if (h < 1) return `in ${Math.round(h * 60)}m`;
  if (h < 48) return `in ${Math.round(h)}h`;
  return `in ${Math.round(h / 24)}d`;
}

export function money(n: number | null, ccy: string): string {
  if (n === null) return "—";
  if (ccy === "LKR") return `${Math.round(n / 1000)}K`;
  return `${ccy} ${n.toLocaleString()}`;
}

export function timeAt(ts: number): string {
  return new Date(ts).toLocaleString("en-GB", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

/**
 * "22 Oct 2026, 10:42 AM" in Sri Lanka time, whichever machine renders it
 * (22 Oct): Excel Tables showed the day alone, in the server's zone, so a
 * link added after midnight read as the day before.
 */
export function colomboDateTime(ts: number, withYear = false): string {
  const date = new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", ...(withYear ? { year: "numeric" } : {}), timeZone: "Asia/Colombo" });
  return `${date}, ${clockAt(ts, "Asia/Colombo")}`;
}

/** "10:42 AM" in a time zone. */
export function clockAt(ts: number, timeZone: string): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });
}

/** On-screen dates: "30 Aug 2026". Relative ageing uses relDays; timestamps use timeAt. */
export function dateAt(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/**
 * "Now X · expects Y · 30 days notice", with only the parts that are known.
 * An empty record used to print "Now · expects · days notice".
 */
export function packageLine(c: {
  currentSalary: string | null;
  expectedSalary: string | null;
  noticePeriodDays: number | null;
}): string {
  const parts = [
    c.currentSalary?.trim() ? `Now ${c.currentSalary.trim()}` : null,
    c.expectedSalary?.trim() ? `expects ${c.expectedSalary.trim()}` : null,
    c.noticePeriodDays === 0 ? "immediate joiner" : c.noticePeriodDays != null ? `${c.noticePeriodDays} days notice` : null,
  ].filter(Boolean) as string[];
  if (parts.length === 0) return "Package not known";
  const line = parts.join(" · ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

/**
 * Where a candidate came from, as the badge beside their name. A person
 * headhunted through Excel Tables (channel L) read "Applicant", as if they had
 * applied (21 Sep) — and then everyone who applied to a LinkedIn post read
 * "Headhunted", since they carry L too; `source` (lib/cvSource) tells them
 * apart (28 Sep).
 */
export function channelTag(channel: string | null | undefined, source?: string): string {
  if (source === "post") return channel === "L" ? "LinkedIn post" : "Applicant";
  if (channel === "L") return "Headhunted";
  if (channel === "HH") return "Sourced";
  if (channel === "SCOOP") return "Database";
  return "Applicant";
}
