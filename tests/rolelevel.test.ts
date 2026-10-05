import { currentRoleGate, jobLevelRank } from "../convex/lib/roleLevel";
import { mapSeniority } from "../convex/lib/jobRequirements";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

// The candidate classifier's ladder (lib/currentRoleClassifier), as numbers.
const CAND = { intern: 0, junior: 1, mid: 2, senior: 3, lead: 4, manager: 5, seniorManager: 6, agm: 7, gm: 8, director: 9 };
const gateFor = (jobSeniority: string, cand: number) => currentRoleGate(jobLevelRank(jobSeniority), cand).gate;

// ── Every schema level lands on the candidate ladder (5 Oct bug) ──
eq("entry_level = junior", jobLevelRank("entry_level"), CAND.junior);
eq("mid_level = mid", jobLevelRank("mid_level"), CAND.mid);
eq("executive = mid", jobLevelRank("executive"), CAND.mid);
eq("senior_executive = senior", jobLevelRank("senior_executive"), CAND.senior);
eq("manager = manager", jobLevelRank("manager"), CAND.manager);
eq("senior_manager = senior manager", jobLevelRank("senior_manager"), CAND.seniorManager);
eq("agm = agm", jobLevelRank("agm"), CAND.agm);
eq("gm = gm", jobLevelRank("gm"), CAND.gm);
eq("director = director", jobLevelRank("director"), CAND.director);
eq("c_suite = director/c-suite", jobLevelRank("c_suite"), CAND.director);
eq("other skips the gate", jobLevelRank("other"), null);
eq("blank skips the gate", jobLevelRank(null), null);

// ── Same level is never "overqualified" — the bug dropped all of these ──
eq("mid person, mid job: in", gateFor("mid_level", CAND.mid), "pass");
eq("junior person, entry job: in", gateFor("entry_level", CAND.junior), "pass");
eq("manager, manager job: in", gateFor("manager", CAND.manager), "pass");
eq("senior manager, senior manager job: in", gateFor("senior_manager", CAND.seniorManager), "pass");
eq("GM, GM job: in", gateFor("gm", CAND.gm), "pass");

// ── Senior Software Engineer: the JD title reads as senior_executive ──
eq("'Senior Software Engineer' reads as senior_executive", mapSeniority("Senior Software Engineer"), "senior_executive");
eq("senior SE for senior job: in", gateFor("senior_executive", CAND.senior), "pass");
eq("SE (one below) for senior job: in, no penalty", currentRoleGate(jobLevelRank("senior_executive"), CAND.mid), { gate: "pass", penalty: 0 });
eq("junior SE (two below): in, penalised", currentRoleGate(jobLevelRank("senior_executive"), CAND.junior), { gate: "pass_with_penalty", penalty: -12 });
eq("tech lead for senior job: out", gateFor("senior_executive", CAND.lead), "excluded_overqualified");

// ── The gate's own rules are unchanged ──
eq("above the job: out", gateFor("mid_level", CAND.manager), "excluded_overqualified");
eq("unclassified candidate: in", currentRoleGate(3, null), { gate: "pass", penalty: 0 });
eq("penalty is capped at -40", currentRoleGate(9, 0), { gate: "pass_with_penalty", penalty: -40 });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
