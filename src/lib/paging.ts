/**
 * Page numbers and page links for the lists.
 *
 * Every list reads its page from the URL, so a page is a link: it survives a
 * reload, the browser's back button, and a trip to another page and back.
 * Changing the search or the filters starts again at page 1.
 */

type Params = Record<string, string | string[] | undefined>;

/** The page asked for, clamped to the pages that exist. */
export function pageFrom(sp: Params, total: number, pageSize: number, key = "page"): number {
  const raw = sp[key];
  const n = Math.floor(Number(typeof raw === "string" ? raw : 1)) || 1;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return Math.min(Math.max(1, n), pages);
}

/** The rows on one page. */
export function slicePage<T>(items: T[], page: number, pageSize: number): T[] {
  return items.slice((page - 1) * pageSize, page * pageSize);
}

/**
 * A link to another page of the same list: every current parameter is kept —
 * the search, the filters, the tab — and only the page changes. `msg` is a
 * one-off notice and is not carried.
 */
export function pageLink(path: string, sp: Params, key = "page"): (page: number) => string {
  return (page: number) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(sp)) {
      if (k === key || k === "msg" || v === undefined) continue;
      for (const one of Array.isArray(v) ? v : [v]) p.append(k, one);
    }
    if (page > 1) p.set(key, String(page));
    const qs = p.toString();
    return qs ? `${path}?${qs}` : path;
  };
}

/** Case-insensitive "every word appears somewhere in these fields". */
export function matchesQuery(q: string | undefined, ...fields: (string | null | undefined)[]): boolean {
  const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fields.filter(Boolean).join(" ").toLowerCase();
  return words.every((w) => hay.includes(w));
}
