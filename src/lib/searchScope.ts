/**
 * What the search bar in the header searches, given the page it is on.
 *
 * The bar is one box in one place, but a TA on Clients is looking for a client
 * and a TA on a pipeline stage is looking for a candidate in that stage. So the
 * box searches the list on the current page — it sends `?q=` back to the same
 * page, keeping that page's own filters and tab — and only a page with no list
 * of its own falls back to the desk-wide search.
 */

export type SearchScope = {
  /** Where the form is sent. */
  action: string;
  placeholder: string;
  /** Current parameters that stay on the search (a bucket, a tab, a filter). */
  keep: string[];
};

const GLOBAL: SearchScope = { action: "/search", placeholder: "Search openings and candidates", keep: [] };

const same = (path: string, placeholder: string, keep: string[] = []): SearchScope => ({ action: path, placeholder, keep });

export function searchScopeFor(pathname: string): SearchScope {
  const path = (pathname.replace(/\/+$/, "") || "/").split("?")[0];

  if (path === "/") return same(path, "Search your dashboard");
  // Clients has its own search box on the page (ClientsToolbar), so the header
  // keeps the desk-wide search there.
  if (path === "/people") return same(path, "Search people");
  if (path === "/openings") return same(path, "Search openings", ["bucket"]);
  if (path === "/alerts") return same(path, "Search alerts", ["all"]);
  if (path === "/intake") return same(path, "Search intake");
  if (path === "/review") return same(path, "Search reviews");
  if (/^\/review\/[^/]+$/.test(path)) return same(path, "Search this review");
  if (path === "/database/scan") return same(path, "Search scanned CVs");
  if (path === "/database" || path === "/database/results") {
    return same("/database/results", "Search the database", ["mode", "for", "openingId"]);
  }

  const opening = path.match(/^\/openings\/[^/]+(\/.*)?$/);
  if (opening && opening[1]) {
    const sub = opening[1];
    const filters = ["post", "minExp", "maxExp", "maxNotice", "location", "mine", "company", "past", "skill", "school", "industry", "title", "nationality", "sort", "band"];
    if (/^\/pipeline\/[^/]+$/.test(sub)) return same(path, "Search candidates in this stage", filters);
    if (sub === "/database") return same(path, "Search matched candidates", filters);
    if (sub === "/linkedin-job") return same(path, "Search applicants", filters);
    if (sub === "/hh/links") return same(path, "Search this table");
    if (sub === "/hh/suggestions") return same(path, "Search suggestions", ["show", "sort"]);
    if (sub === "/eod") return same(path, "Search replies already in", ["kind"]);
    if (/^\/candidate\/[^/]+$/.test(sub)) return same(path, "Search this candidate's activity", ["tab"]);
  }

  if (path === "/search") return GLOBAL;
  return GLOBAL;
}
