// convex/lib/feedbackAccess.ts
//
// Who may see a feedback item, with roles read as the live database stores
// them. Pure, so tests/feedbackaccess can check it (review of #157, 9 Oct).

/**
 * The person's role as the web app reads it (src/data/convex/map.ts): an
 * explicit taRole wins, else the backend role mapped. On live a TA Lead is
 * stored as ta_manager or senior_ta with taRole "ta_lead", so reading `role`
 * alone left every lead unable to review feedback (review of #157, 9 Oct).
 */
const BACKEND_ROLE: Record<string, string> = {
  admin: "admin", ta_manager: "ta_lead", senior_ta: "ta_lead", director: "director",
  recruiter: "ta", ta: "ta", test_ta: "ta", ops: "ops", client: "client", viewer: "viewer",
};
export function deskRole(u: { role?: string; taRole?: string | null }): string {
  return u.taRole || BACKEND_ROLE[u.role ?? ""] || "viewer";
}

/**
 * Who may see a feedback item — the list and its screenshot both ask this.
 * Leads and directors see all; admins what a lead sent on, and their own;
 * everyone else only their own.
 */
const ADMIN_STATUSES = new Set(["approved_for_admin", "in_progress", "resolved", "declined_by_admin"]);
export function maySee(actor: { _id: unknown; role?: string; taRole?: string | null }, row: { submittedBy: string; status: string }): boolean {
  const role = deskRole(actor);
  if (row.submittedBy === (actor._id as string)) return true;
  if (isLeadRole(role)) return true;
  return isAdminRole(role) && ADMIN_STATUSES.has(row.status);
}

export function isLeadRole(role: string): boolean {
  return role === "ta_lead" || role === "director";
}

export function isAdminRole(role: string): boolean {
  return role === "admin" || role === "director";
}
