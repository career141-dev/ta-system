import { can } from "@/lib/auth";
import { seatFor } from "@/lib/visibility";
import type { Assignment, User } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const user = (role: User["role"], over: Partial<User> = {}): User =>
  ({ id: `u_${role}`, name: role, email: "", phone: null, routingEmail: null, role, initials: "X", isActive: true, ...over });
const on = (role: Assignment["role"], userId = "u_ta"): Assignment =>
  ({ id: "as", openingId: "op", userId, role, assignedAt: 0, assignedBy: null });
const ok = (u: User, cap: Parameters<typeof can>[1], ctx: Parameters<typeof can>[2] = {}) => can(u, cap, ctx).ok;

console.log("\nfinding 02: a client account is never an unrestricted seat");
const client = user("client");
const seat = seatFor(client, "client_contact");
eq("cannot see sourcing", seat.canSeeSourcing, false);
eq("cannot act", seat.canAct, false);
eq("sees only client stages", seat.stages, ["client_shortlist", "interview", "offer", "placed"]);
eq("still restricted with no assignment", seatFor(client, null).canAct, false);
eq("cannot change an opening's status", ok(client, "opening.manage", { assignment: on("client_contact", client.id) }), false);
eq("cannot search the whole database", ok(client, "database.read"), false);

console.log("\nviewers read and never write");
const viewer = user("viewer");
eq("viewer reads a report", ok(viewer, "report.read"), true);
eq("viewer cannot act even as a named recruiter", ok(viewer, "opening.act", { assignment: on("primary_recruiter", viewer.id) }), false);
eq("viewer seat cannot act", seatFor(viewer, "primary_recruiter").canAct, false);

console.log("\ndeactivated accounts can do nothing");
const gone = user("admin", { isActive: false });
eq("not even an admin", ok(gone, "opening.read"), false);

console.log("\nTAs work the openings they are on");
const ta = user("ta");
eq("on it: acts", ok(ta, "opening.act", { assignment: on("primary_recruiter") }), true);
eq("not on it: refused", ok(ta, "opening.act", {}), false);
eq("another TA's claimed candidate: refused", ok(ta, "opening.act", { assignment: on("supporting_recruiter"), ownerTaId: "u_other" }), false);
eq("a lead can still unstick it", ok(user("ta_lead"), "opening.act", { ownerTaId: "u_other" }), true);

console.log("\nfinding 12: approval stages need the approver");
eq("TA cannot move to director shortlist by hand", ok(ta, "decide.director", { assignment: on("primary_recruiter") }), false);
eq("but can apply the Director's recorded reply", ok(ta, "decide.director", { viaRecordedReview: true }), true);
eq("the director can", ok(user("director"), "decide.director"), true);
eq("a client contact records a client decision", ok(client, "decide.client", { assignment: on("client_contact", client.id) }), true);
eq("TA cannot fake a client decision", ok(ta, "decide.client", { assignment: on("primary_recruiter") }), false);

console.log("\nadministration");
eq("only admin manages people", [ok(user("admin"), "user.manage"), ok(user("director"), "user.manage"), ok(ta, "user.manage")], [true, false, false]);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
