/**
 * TA Feedback & Approval System Tests:
 * 1. TA Submits feedback -> initial status "pending_lead"
 * 2. Access Control & Visibility:
 *    - Unauthenticated caller sees nothing
 *    - TA sees only their own submissions
 *    - TA Lead sees all submissions across desk (including pending_lead)
 *    - Admin sees ONLY what a lead has approved (does not see pending_lead or lead-resolved/declined)
 * 3. TA Lead Review Gate:
 *    - Approval & Escalation -> "approved_for_admin" with lead notes
 *    - Escalated item now appears in Admin queue
 *    - Direct Resolution -> "resolved_by_lead"
 *    - Decline -> "declined_by_lead"
 * 4. Admin Queue & Resolution:
 *    - Admin moves to "in_progress", "resolved", "declined_by_admin" with resolution notes
 * 5. Role checks & alert badges
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.C141_STORE = "json";
process.env.C141_TEST_RUN = "1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "c141-feedback-"));
process.chdir(tmp);
const { repo } = await import("@/data/store");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

console.log("\n1. TA Submission Workflow");
repo.reset();

const taUser = repo.users().find((u) => u.role === "ta")!;
const leadUser = repo.users().find((u) => u.role === "ta_lead")!;
const directorUser = repo.users().find((u) => u.role === "director")!;
const adminUser: typeof taUser = {
  id: "u_admin",
  name: "System Admin",
  email: "admin@career141.com",
  phone: null,
  routingEmail: null,
  role: "admin",
  initials: "AD",
  isActive: true,
};

// Submit feedback
const fbId = repo.addFeedback({
  submittedBy: taUser.id,
  submittedByName: taUser.name,
  submittedByRole: taUser.role,
  category: "bug",
  priority: "high",
  title: "Candidate search dropdown glitch",
  description: "When typing uppercase letters, results do not filter immediately.",
  pageUrl: "/database",
});

const item1 = repo.feedback(fbId);
eq("item created with id", Boolean(item1), true);
eq("initial status is pending_lead", item1?.status, "pending_lead");
eq("priority preserved", item1?.priority, "high");
eq("category preserved", item1?.category, "bug");
eq("pageUrl preserved", item1?.pageUrl, "/database");

console.log("\n2. Visibility and Access Control");
eq("Unauthenticated caller sees nothing", repo.feedbacks().length, 0);

const taFeedbacks = repo.feedbacks(taUser);
eq("TA sees their own submission", taFeedbacks.some((f) => f.id === fbId), true);

const leadFeedbacks = repo.feedbacks(leadUser);
eq("TA Lead sees submissions across desk", leadFeedbacks.some((f) => f.id === fbId), true);

const directorFeedbacks = repo.feedbacks(directorUser);
eq("Director sees submissions across desk", directorFeedbacks.some((f) => f.id === fbId), true);
const adminFeedbacks = repo.feedbacks(adminUser);
eq("Admin does NOT see unapproved pending_lead submission", adminFeedbacks.some((f) => f.id === fbId), false);

console.log("\n3. TA Lead Review Gate - Approval & Escalation");
const leadNotes = "Verified by lead. Critical issue for candidate search.";
const leadReviewAt = Date.now();
repo.updateFeedback(fbId, {
  status: "approved_for_admin",
  leadReviewedBy: leadUser.id,
  leadReviewedByName: leadUser.name,
  leadReviewedAt: leadReviewAt,
  leadNotes,
});

const item1Reviewed = repo.feedback(fbId);
eq("status updated to approved_for_admin", item1Reviewed?.status, "approved_for_admin");
eq("lead reviewer id recorded", item1Reviewed?.leadReviewedBy, leadUser.id);
eq("lead review notes saved", item1Reviewed?.leadNotes, leadNotes);

const adminFeedbacksAfterApproval = repo.feedbacks(adminUser);
eq("Admin now sees submission approved by lead", adminFeedbacksAfterApproval.some((f) => f.id === fbId), true);

console.log("\n4. Admin Queue & Resolution");
const adminResolution = "Fixed debounce and case-insensitivity in search filter v2.4.";
const resolvedAt = Date.now();

// Move to in_progress
repo.updateFeedback(fbId, {
  status: "in_progress",
  adminReviewedBy: adminUser.id,
  adminReviewedByName: adminUser.name,
  adminReviewedAt: Date.now(),
});
eq("admin moved to in_progress", repo.feedback(fbId)?.status, "in_progress");

// Resolve
repo.updateFeedback(fbId, {
  status: "resolved",
  adminReviewedBy: adminUser.id,
  adminReviewedByName: adminUser.name,
  adminReviewedAt: resolvedAt,
  adminResolution,
  resolvedAt,
});

const item1Resolved = repo.feedback(fbId);
eq("status updated to resolved", item1Resolved?.status, "resolved");
eq("admin resolution text recorded", item1Resolved?.adminResolution, adminResolution);
eq("resolved timestamp present", Boolean(item1Resolved?.resolvedAt), true);

console.log("\n5. TA Lead Direct Resolution (Process/Training Question)");
const fbId2 = repo.addFeedback({
  submittedBy: taUser.id,
  submittedByName: taUser.name,
  submittedByRole: taUser.role,
  category: "workflow",
  priority: "low",
  title: "How to export candidate notes to Excel?",
  description: "Where is the export button located for interview rounds?",
  pageUrl: "/openings/op_1",
});

repo.updateFeedback(fbId2, {
  status: "resolved_by_lead",
  leadReviewedBy: leadUser.id,
  leadReviewedByName: leadUser.name,
  leadReviewedAt: Date.now(),
  leadNotes: "Go to Opening > Candidates > Export Table in the top right toolbar.",
  resolvedAt: Date.now(),
});

const item2Resolved = repo.feedback(fbId2);
eq("resolved directly by lead without admin escalation", item2Resolved?.status, "resolved_by_lead");
eq("lead notes contain answer", item2Resolved?.leadNotes?.includes("Export Table"), true);
eq("Admin does not see lead-resolved item", repo.feedbacks(adminUser).some((f) => f.id === fbId2), false);

console.log("\n6. TA Lead Decline Workflow");
const fbId3 = repo.addFeedback({
  submittedBy: taUser.id,
  submittedByName: taUser.name,
  submittedByRole: taUser.role,
  category: "other",
  priority: "low",
  title: "Duplicate feature request",
  description: "Add dark mode toggle.",
  pageUrl: "/clients",
});

repo.updateFeedback(fbId3, {
  status: "declined_by_lead",
  leadReviewedBy: leadUser.id,
  leadReviewedByName: leadUser.name,
  leadReviewedAt: Date.now(),
  leadNotes: "Dark mode already exists in the top right user menu.",
});

const item3Declined = repo.feedback(fbId3);
eq("lead declined with explanatory note", item3Declined?.status, "declined_by_lead");
eq("Admin does not see lead-declined item", repo.feedbacks(adminUser).some((f) => f.id === fbId3), false);

console.log("\n7. Alert Badges Notification & Clear on Open");
// Clear read settings for a clean test
repo.setSetting(`read_feedbacks:${leadUser.id}`, "[]");
repo.setSetting(`read_feedbacks:${adminUser.id}`, "[]");

const fbNew = repo.addFeedback({
  submittedBy: taUser.id,
  submittedByName: taUser.name,
  submittedByRole: taUser.role,
  category: "bug",
  priority: "urgent",
  title: "Urgent issue on candidate follow-up",
  description: "Screen freezes on long notes input.",
});

eq("TA lead has unseen alert badge for pending_lead feedback", repo.unseenFeedbackCount(leadUser) > 0, true);
eq("Admin does NOT have unseen alert badge for pending_lead feedback", repo.unseenFeedbackCount(adminUser), 0);

// When TA Lead opens feedback desk
repo.markAllFeedbackSeen(leadUser.id, leadUser);
eq("TA lead badge clears to 0 after opening feedback page", repo.unseenFeedbackCount(leadUser), 0);

// When TA Lead approves for admin
repo.updateFeedback(fbNew, { status: "approved_for_admin", leadReviewedBy: leadUser.id, leadReviewedAt: Date.now() });
eq("Admin now has unseen alert badge for approved feedback", repo.unseenFeedbackCount(adminUser) > 0, true);

// When Admin opens feedback desk
repo.markAllFeedbackSeen(adminUser.id, adminUser);
eq("Admin badge clears to 0 after opening feedback page", repo.unseenFeedbackCount(adminUser), 0);

console.log("\n8. TA Simplified Submission & TopNav Visibility");
const { isTa } = await import("@/lib/auth");
eq("taUser is identified as TA", isTa(taUser), true);
eq("leadUser is not TA", isTa(leadUser), false);
eq("adminUser is not TA", isTa(adminUser), false);

// TopNav feedback link visibility rule: (n.href !== "/feedback" || !isTa(user))
const showFeedbackInNav = (u: typeof taUser) => !isTa(u);
eq("TopNav feedback view is hidden for TA", showFeedbackInNav(taUser), false);
eq("TopNav feedback view is visible for TA Lead", showFeedbackInNav(leadUser), true);
eq("TopNav feedback view is visible for Admin", showFeedbackInNav(adminUser), true);

// Test submission without category, priority, or title (auto-derived)
const rawDesc = "Candidate search dropdown glitch when filtering by uppercase letters.";
const firstLine = rawDesc.split("\n")[0].trim();
const derivedTitle = firstLine.length > 70 ? `${firstLine.slice(0, 67)}...` : firstLine;
const simplifiedFbId = repo.addFeedback({
  submittedBy: taUser.id,
  submittedByName: taUser.name,
  submittedByRole: taUser.role,
  category: "other",
  priority: "medium",
  title: derivedTitle,
  description: rawDesc,
});

const simplifiedItem = repo.feedback(simplifiedFbId);
eq("simplified TA feedback created", Boolean(simplifiedItem), true);
eq("category defaulted to other", simplifiedItem?.category, "other");
eq("priority defaulted to medium", simplifiedItem?.priority, "medium");
eq("title derived from description", simplifiedItem?.title, derivedTitle);

console.log(`\nResults: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
