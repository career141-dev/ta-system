/**
 * A link that leaves the platform, made safe to put in an `href`.
 *
 * The database holds LinkedIn addresses the way people typed them into a CV:
 * `linkedin.com/in/vishwa-fernando-85519495`, `www.linkedin.com/in/…`, with a
 * stray space inside the slug, occasionally with a scheme. A value without a
 * scheme is a RELATIVE path to a browser, so on the Database screen the
 * "Profile" button went to `/database/www.linkedin.com/in/…` and 404'd.
 *
 * Returns null for anything that is not a plain web address, including
 * `javascript:` — these strings come out of CV extraction, not from us.
 */
export function externalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Whitespace inside an address is extraction noise ("paramsothy- nirosan").
  let s = raw.trim().replace(/\s+/g, "");
  if (!s) return null;
  if (/^\/\//.test(s)) s = `https:${s}`;
  else if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}
