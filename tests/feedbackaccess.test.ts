/**
 * Who may see a feedback item and its screenshot (convex/lib/feedbackAccess maySee),
 * with roles read as the live database stores them (review of #157, 9 Oct).
 */
import { deskRole, maySee } from "../convex/lib/feedbackAccess";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const item = (status: string) => ({ submittedBy: "u_ta", status });
const ta = { _id: "u_ta", role: "recruiter" };
const otherTa = { _id: "u_ta2", role: "recruiter" };
const lead = { _id: "u_lead", role: "ta_manager", taRole: "ta_lead" };
const leadNoTaRole = { _id: "u_lead2", role: "senior_ta" };
const admin = { _id: "u_admin", role: "admin" };
const client = { _id: "u_client", role: "client" };

console.log("\nroles as live stores them");
eq("a lead stored as ta_manager with taRole ta_lead is a lead", deskRole(lead), "ta_lead");
eq("senior_ta with no taRole reads as a lead", deskRole(leadNoTaRole), "ta_lead");
eq("recruiter reads as a TA", deskRole(ta), "ta");
eq("an unknown role can do least", deskRole({ role: "something_new" }), "viewer");

console.log("\nwho sees an item");
eq("the person who sent it", maySee(ta, item("pending_lead")), true);
eq("another TA does not", maySee(otherTa, item("pending_lead")), false);
eq("a lead sees every item", [maySee(lead, item("pending_lead")), maySee(leadNoTaRole, item("declined_by_lead"))], [true, true]);
eq("an admin does not see what a lead has not sent on", maySee(admin, item("pending_lead")), false);
eq("an admin sees what a lead sent on", maySee(admin, item("approved_for_admin")), true);
eq("a client account sees nobody else's", maySee(client, item("approved_for_admin")), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
