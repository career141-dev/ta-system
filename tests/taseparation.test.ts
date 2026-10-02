// Two TAs on one opening work apart; the lead sees both (2 Oct).
import { can } from "@/lib/auth";
import { rowIsAnotherTas, seatFor, visibleToSeat } from "@/lib/visibility";
import type { Application, Assignment, User } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const user = (role: User["role"], id: string): User =>
  ({ id, name: id, email: "", phone: null, routingEmail: null, role, initials: "X", isActive: true });
const on = (userId: string): Assignment =>
  ({ id: `as_${userId}`, openingId: "op", userId, role: "supporting_recruiter", assignedAt: 0, assignedBy: null });
const app = (id: string, ownerTaId: string | null, stage: Application["stage"] = "ta_follow_up"): Application =>
  ({ id, ownerTaId, stage } as Application);

const hassan = user("ta", "u_hassan");
const jesmeen = user("ta", "u_jesmeen");
const lead = user("ta_lead", "u_lead");
const director = user("director", "u_dir");
const apps = [
  app("a1", "u_hassan"), app("a2", "u_jesmeen"), app("a3", null, "new_cv"), app("a4", "u_jesmeen", "director_review"),
];
const seeOf = (u: User) => visibleToSeat(apps, seatFor(u, "supporting_recruiter")).map((a) => a.id);

console.log("\ncandidates: each TA works their own, the pool is shared, the lead sees both");
eq("a TA sees their own and the unclaimed", seeOf(hassan), ["a1", "a3"]);
eq("the other TA sees theirs and the unclaimed", seeOf(jesmeen), ["a2", "a3", "a4"]);
eq("a TA lead sees both TAs' candidates", seeOf(lead), ["a1", "a2", "a3", "a4"]);
eq("a director sees both too", seeOf(director), ["a1", "a2", "a3", "a4"]);
eq("a client contact is still limited to client stages", visibleToSeat(apps, seatFor(user("client", "u_c"), "client_contact")).length, 0);

console.log("\nacting on a colleague's candidate is refused; a lead can unstick it");
const ctxOther = { assignment: on("u_hassan"), ownerTaId: "u_jesmeen" };
eq("a TA cannot act on the other TA's candidate", can(hassan, "opening.act", ctxOther).ok, false);
eq("a TA can act on their own", can(hassan, "opening.act", { assignment: on("u_hassan"), ownerTaId: "u_hassan" }).ok, true);
eq("a TA can act on an unclaimed one", can(hassan, "opening.act", { assignment: on("u_hassan"), ownerTaId: null }).ok, true);
eq("a lead can act on either", can(lead, "opening.act", { ownerTaId: "u_jesmeen" }).ok, true);

console.log("\nExcel Tables rows: another TA's row is theirs");
const deskWide = (id: string) => id === "u_lead";
const theirs = { addedBy: "u_jesmeen" };
eq("another TA's row is not mine", rowIsAnotherTas(theirs, hassan, deskWide), true);
eq("my own row is mine", rowIsAnotherTas({ addedBy: "u_hassan" }, hassan, deskWide), false);
eq("a row a lead put in is handed to the TAs", rowIsAnotherTas({ addedBy: "u_lead" }, hassan, deskWide), false);
eq("a lead is never kept out of a row", rowIsAnotherTas(theirs, lead, deskWide), false);
eq("sourcing on another TA's row is refused", can(hassan, "opening.sourcing", { assignment: on("u_hassan"), ownerTaId: "u_jesmeen" }).ok, false);
eq("sourcing on my own row is allowed", can(hassan, "opening.sourcing", { assignment: on("u_hassan"), ownerTaId: "u_hassan" }).ok, true);
eq("sourcing on a lead's row is allowed", can(hassan, "opening.sourcing", { assignment: on("u_hassan"), ownerTaId: null }).ok, true);
eq("sourcing with no row is unchanged", can(hassan, "opening.sourcing", { assignment: on("u_hassan") }).ok, true);
eq("a lead can work any row", can(lead, "opening.sourcing", { ownerTaId: "u_jesmeen" }).ok, true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
