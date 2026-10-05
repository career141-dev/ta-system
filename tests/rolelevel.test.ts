import { currentRoleGate, jobLevelRank, levelFromTitle, levelSection } from "../convex/lib/roleLevel";
import { inLevelOrder } from "../src/lib/levels";
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

// ── A level from the title, for people the classifier has not seen (5 Oct) ──
eq("Senior Software Engineer", levelFromTitle("Senior Software Engineer"), CAND.senior);
eq("Software Engineer", levelFromTitle("Software Engineer"), CAND.mid);
eq("Software Engineer, 1 yr", levelFromTitle("Software Engineer", 1), CAND.junior);
eq("Associate Software Engineer", levelFromTitle("Associate Software Engineer"), CAND.junior);
eq("Junior Developer", levelFromTitle("Junior Developer"), CAND.junior);
eq("Software Engineering Intern", levelFromTitle("Software Engineering Intern"), CAND.intern);
eq("Tech Lead", levelFromTitle("Tech Lead"), CAND.lead);
eq("Assistant Manager - Finance", levelFromTitle("Assistant Manager - Finance"), CAND.lead);
eq("Assistant General Manager", levelFromTitle("Assistant General Manager"), CAND.agm);
eq("Senior Manager HR", levelFromTitle("Senior Manager HR"), CAND.seniorManager);
eq("General Manager", levelFromTitle("General Manager"), CAND.gm);
eq("Finance Director", levelFromTitle("Finance Director"), CAND.director);
eq("Marketing Executive", levelFromTitle("Marketing Executive"), CAND.mid);
eq("Senior Executive - Sales", levelFromTitle("Senior Executive - Sales"), CAND.senior);
eq("no title", levelFromTitle(null), null);

// ── Sections: the job's level, then each level below, then above, then unknown ──
const senior = CAND.senior;
eq("same level", levelSection(senior, CAND.senior), { order: 0, label: "Senior — this job's level" });
eq("one below", levelSection(senior, CAND.mid), { order: 1, label: "Mid-level — one level below" });
eq("two below", levelSection(senior, CAND.junior), { order: 2, label: "Junior / Associate — two levels below" });
eq("three below", levelSection(senior, CAND.intern), { order: 3, label: "Intern / Trainee — 3 levels below" });
eq("above sits after every level below", levelSection(senior, CAND.lead).order > levelSection(senior, CAND.intern).order, true);
eq("unknown last", levelSection(senior, null).order > levelSection(senior, CAND.director).order, true);
eq("no job: highest level first", levelSection(null, CAND.director).order < levelSection(null, CAND.intern).order, true);

// ── Sections keep the fit order inside each one ──
const people = [
  { n: "junior 90", lvl: CAND.junior }, { n: "senior 85", lvl: CAND.senior }, { n: "mid 80", lvl: CAND.mid },
  { n: "senior 70", lvl: CAND.senior }, { n: "intern 65", lvl: CAND.intern }, { n: "mid 60", lvl: CAND.mid },
];
eq("grouped, best fit first in each", inLevelOrder(people, (p) => levelSection(senior, p.lvl)).map((p) => p.n),
  ["senior 85", "senior 70", "mid 80", "mid 60", "junior 90", "intern 65"]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
