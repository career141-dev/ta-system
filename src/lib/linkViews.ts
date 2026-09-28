/**
 * The table's three views (the desk, 28 Sep): everything, the add-ons, or the
 * shortlisted. All by default, so an add-on is never out of sight on a tab the
 * TA forgets to open; the others narrow it when they want just those.
 */
export const LINK_VIEWS = [
  { key: "", label: "All links" },
  { key: "addons", label: "Add-ons" },
  { key: "shortlisted", label: "Shortlisted" },
] as const;

export function inLinkView(row: { isAddOn?: boolean; outcome: string }, view: string): boolean {
  if (view === "addons") return !!row.isAddOn;
  if (view === "shortlisted") return row.outcome === "shortlisted";
  return true;
}
