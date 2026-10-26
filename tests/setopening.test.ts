/**
 * The opening a TA's set subject means (convex/lib/setOpening.ts, 26 Oct).
 * Subjects and opening titles are the real ones.
 */
import { parseHouseSubject } from "../convex/lib/shortlistMail";
import { setOpenings } from "../convex/lib/setOpening";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const o = (id: string, clientName: string, title: string) => ({ id, clientName, title });
const openings = [
  o("sqops", "SQ - BD", "General Manager – Operations"),
  o("sqie", "SQ - BD", "General Manager - Industrial Engineering"),
  o("sqplan", "SQ - BD", "Head of Planning"),
  o("soc", "DeltaSpike", "Security Operations Center Analyst/ Executive Analyst - TDR"),
  o("dsfin1", "DeltaSpike", "FINANCE MANAGER"),
  o("dsfin2", "DeltaSpike", "FINANCE MANAGER"),
  o("akbar", "Akbar Brothers", "Customer Experience Manager"),
  o("purch", "DELMO - HOLDING", "Purchasing manager"),
  o("hr", "MELWA", "Head OF HR"),
  o("ghr", "MELWA", "Group Head of HR"),
  o("elec", "Q COLLECTION (SL)", "Senior Executive - Electrical"),
  o("mhr", "Q COLLECTION (SL)", "MANAGER HR"),
  o("cut", "FGL Vietnam", "Head of Cutting"),
];
const ids = (subject: string) => setOpenings(parseHouseSubject(subject)!, openings).map((x) => x.id);

console.log("\nthe desk's names");
eq("Q COLLECTION (BD) > GM OPS", ids("Q COLLECTION (BD) > GM OPS > SET 01"), ["sqops"]);
eq("Q COLLECTION (BD) > GM IE", ids("Q COLLECTION (BD) > GM IE > SET 10"), ["sqie"]);
eq("DELTA SPIKE > SOC ANALYST - TDR", ids("DELTA SPIKE > SOC ANALYST - TDR > SET 04"), ["soc"]);
eq("CUSTOMER SERVICE MANAGER", ids("AKBAR BROTHERS > CUSTOMER SERVICE MANAGER > SET 01"), ["akbar"]);
eq("Manager - Purchasing", ids("Set 01 - Delmo - Manager - Purchasing - 01 CV"), ["purch"]);
eq("SENIOR ELECTRICAL ENGINEER", ids("Q COLLECTION (SL) > SENIOR ELECTRICAL ENGINEER > SET 02"), ["elec"]);
eq("HR MANAGER", ids("Q COLLECTION - HR MANAGER - SET 01"), ["mhr"]);
eq("Vietnam - Head of Cutting - 02 CV's", ids("SET 04 - FGL - Vietnam - Head of Cutting - 02 CV's"), ["cut"]);

console.log("\nthe right one of two");
eq("HEAD OF HR is not Group Head of HR", ids("MELWA > HEAD OF HR > SET 01"), ["hr"]);
eq("GROUP HEAD OF HR", ids("SET 1 - MELWA - GROUP HEAD OF HR- 2 CVs"), ["ghr"]);
eq("the same opening twice: both", ids("DELTA SPIKE > FINANCE MANAGER > SET 01"), ["dsfin1", "dsfin2"]);

console.log("\nno opening");
eq("HEAD OF QUALITY is not Head of Planning", ids("SQ > HEAD OF QUALITY > SET 01"), []);
eq("HEAD OF PD is not Head of Planning", ids("Q COLLECTION (BD) > HEAD OF PD > SET 05"), []);
eq("a position with no opening", ids("Q COLLECTION (SL) > MANAGEMENT TRAINEE (HR) > SET 01"), []);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
