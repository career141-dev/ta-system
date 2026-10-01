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

/**
 * A LinkedIn profile as a recruiter pastes it — with or without `https://`,
 * `www.` or a country subdomain, with a trailing slash or query — as one tidy
 * address, the key two pastes of the same person share, and a name read from
 * the address for a row nobody has named yet.
 *
 * Excel Tables took the text exactly as typed, and its box refused anything
 * without `https://` before the form was even sent; the rows it did take
 * showed "Unnamed profile" until someone typed a name (testing, 21 Sep).
 * Returns null for anything that is not a linkedin.com/in/ profile.
 */
/**
 * The key a row's LinkedIn address is matched on: the /in/ profile's, or for a
 * LinkedIn Recruiter page ("…/talent/hire/…/profile/AEMAAC…") that profile's
 * own id (1 Oct). Recruiter addresses had no key, so every capture of the same
 * person from Recruiter made another row.
 */
export function linkKey(raw: string | null | undefined): string | null {
  const inKey = profileLink(raw)?.key;
  if (inKey) return inKey;
  const m = (raw ?? "").match(/linkedin\.com\/talent\/[^?#\s]*?\/profile\/([A-Za-z0-9_-]{10,})/i);
  return m ? `linkedin.com/talent/profile/${m[1].toLowerCase()}` : null;
}

export function profileLink(raw: string | null | undefined): { url: string; key: string; guessedName: string | null } | null {
  const href = externalUrl(raw);
  if (!href) return null;
  const m = href.match(/^https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return null;
  let slug: string;
  try {
    slug = decodeURIComponent(m[1]).trim();
  } catch {
    slug = m[1];
  }
  if (!slug) return null;
  const key = `linkedin.com/in/${slug.toLowerCase()}`;
  return { url: `https://www.${key}`, key, guessedName: nameFromSlug(slug) };
}

/**
 * "vishwa-fernando-85519495" → "Vishwa Fernando". LinkedIn appends a run of
 * digits or hex to taken names; that and anything else that is not a word is
 * dropped. Null when nothing name-like is left.
 */
function nameFromSlug(slug: string): string | null {
  const words = slug
    .split(/[-_.\s]+/)
    .filter((w) => w && !/\d/.test(w) && /^[\p{L}']+$/u.test(w));
  if (!words.length) return null;
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}
