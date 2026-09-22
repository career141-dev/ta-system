/**
 * Synthetic seed dataset.
 *
 * Client names, position titles and staff first names are taken from the live
 * workbooks so the app is recognisable to the team testing it.
 *
 * EVERY CANDIDATE IS INVENTED. No real candidate's name, phone number, email
 * or profile appears here, and none should ever be added — this dataset exists
 * precisely so the platform can be tested without touching real people's data.
 */

import type {
  Application,
  Brief,
  Candidate,
  CallFeedback,
  Client,
  Database,
  Interview,
  EsaRecord,
  IntakeItem,
  JobPost,
  Offer,
  PipelineEvent,
  OutreachMessage,
  Placement,
  LinkVaultEntry,
  Opening,
  Referee,
  SavedSearch,
  SourcingChannel,
  Stage,
  User,
  FollowUpCallOutcome,
} from "./types";
import { matchAgainst } from "@/lib/dedup";
import { parseCv, problemsWith } from "@/lib/ingest";
import { draftsFor, followUpFor, STANDARD_QUESTIONS, type Contact } from "@/lib/followup";
import { routeInbound, routeNote } from "@/lib/routing";

const DAY = 86_400_000;
const now = Date.now();
const ago = (d: number) => now - d * DAY;

// Deterministic pseudo-random so the seed is stable across restarts.
let s = 20260911;
const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

// ─── Users ───────────────────────────────────────────────────────────────────

const users: User[] = [
  { id: "u_dir", name: "Director", email: "director@career141.com", phone: "+94 77 101 4007", routingEmail: null, role: "director", initials: "DR", isActive: true },
  { id: "u_lead", name: "Azma", email: "azma@career141.com", phone: "+94 77 102 4014", routingEmail: "azma.jobs@career141.com", role: "ta_lead", initials: "AZ", isActive: true },
  { id: "u_sanduni", name: "Sanduni", email: "sanduni@career141.com", phone: "+94 77 103 4021", routingEmail: "sanduni.jobs@career141.com", role: "ta", initials: "SA", isActive: true },
  { id: "u_nuha", name: "Nuha", email: "nuha@career141.com", phone: "+94 77 104 4028", routingEmail: "nuha.jobs@career141.com", role: "ta", initials: "NU", isActive: true },
  { id: "u_imalsha", name: "Imalsha", email: "imalsha@career141.com", phone: "+94 77 105 4035", routingEmail: "imalsha.jobs@career141.com", role: "ta", initials: "IM", isActive: true },
  { id: "u_zainab", name: "Zainab", email: "zainab@career141.com", phone: "+94 77 106 4042", routingEmail: "zainab.jobs@career141.com", role: "ta", initials: "ZA", isActive: true },
  { id: "u_jesmeen", name: "Jesmeen", email: "jesmeen@career141.com", phone: "+94 77 107 4049", routingEmail: "jesmeen.jobs@career141.com", role: "ta", initials: "JE", isActive: true },
  { id: "u_thushini", name: "Thushini", email: "thushini@career141.com", phone: "+94 77 108 4056", routingEmail: "thushini.jobs@career141.com", role: "ta", initials: "TH", isActive: true },
  { id: "u_ops", name: "Ops", email: "ops@career141.com", phone: "+94 77 109 4063", routingEmail: null, role: "ops", initials: "OP", isActive: true },
];

// ─── Clients ─────────────────────────────────────────────────────────────────

const clients: Client[] = [
  {
    id: "cl_delmo", name: "Delmo", industry: "FMCG & Retail",
    contacts: [{ name: "Head of HR", title: "Head of HR", email: "hr@delmo.example", isPrimary: true }],
    esaSignedAt: ago(120), status: "active", createdAt: ago(400),
  },
  {
    id: "cl_ckdl", name: "CKDL", industry: "Apparel Manufacturing",
    contacts: [{ name: "Group HR Director", title: "Group HR Director", email: "hr@ckdl.example", isPrimary: true }],
    esaSignedAt: ago(200), status: "active", createdAt: ago(500),
  },
  {
    id: "cl_apex", name: "Apex", industry: "Apparel Manufacturing",
    contacts: [{ name: "Talent Lead", title: "Talent Lead", email: "talent@apex.example", isPrimary: true }],
    esaSignedAt: ago(60), status: "active", createdAt: ago(300),
  },
  {
    id: "cl_lankahosp", name: "Lanka Hospitals", industry: "Healthcare",
    contacts: [{ name: "CHRO Office", title: "CHRO Office", email: "chro@lankahosp.example", isPrimary: true }],
    esaSignedAt: null, status: "active", createdAt: ago(90),
  },
];

// ─── Openings ────────────────────────────────────────────────────────────────

interface OpeningSpec {
  id: string; clientId: string; title: string; tas: string[];
  tier: Opening["priorityTier"]; status: Opening["status"]; posStatus: Opening["positionStatus"];
  min: number; max: number; pkg: string; locs: string[]; nat: string[];
  assignedDaysAgo: number; jdStatus: Opening["jdStatus"]; value: number | null;
}

const openingSpecs: OpeningSpec[] = [
  {
    id: "op_brand", clientId: "cl_delmo", title: "Brand Manager", tas: ["u_nuha", "u_sanduni"],
    tier: "P3", status: "open", posStatus: "active", min: 475_000, max: 550_000,
    pkg: "475K + fuel, negotiable to 550K", locs: ["Sri Lanka"], nat: [],
    assignedDaysAgo: 12, jdStatus: "approved", value: 65_000,
  },
  {
    id: "op_hof", clientId: "cl_delmo", title: "Head of Finance", tas: ["u_zainab", "u_jesmeen"],
    tier: "P2", status: "open", posStatus: "active", min: 500_000, max: 700_000,
    pkg: "LKR 650K take-home + travel", locs: ["Sri Lanka"], nat: [],
    assignedDaysAgo: 6, jdStatus: "approved", value: 90_000,
  },
  {
    id: "op_gmmerc", clientId: "cl_ckdl", title: "GM Merchandising & Marketing", tas: ["u_sanduni"],
    tier: "P4", status: "open", posStatus: "active", min: 7_500, max: 9_000,
    pkg: "USD 7,500–9,000 net + accommodation + vehicle", locs: ["Sri Lanka", "Bangladesh"],
    nat: ["Sri Lankan"], assignedDaysAgo: 9, jdStatus: "approved", value: 120_000,
  },
  {
    id: "op_hobo", clientId: "cl_apex", title: "Head of Branch Operations", tas: ["u_thushini"],
    tier: "P3", status: "open", posStatus: "active", min: 175_000, max: 600_000,
    pkg: "Negotiable, gross", locs: ["Sri Lanka"], nat: [],
    assignedDaysAgo: 3, jdStatus: "pending_ta_approval", value: null,
  },
  {
    id: "op_chro", clientId: "cl_lankahosp", title: "Chief Human Resources Officer", tas: ["u_imalsha"],
    tier: "P1", status: "open", posStatus: "active", min: 600_000, max: 800_000,
    pkg: "600–800K + fuel", locs: ["Colombo"], nat: [],
    assignedDaysAgo: 16, jdStatus: "approved", value: 150_000,
  },
  {
    id: "op_mktexe", clientId: "cl_delmo", title: "Marketing Executive", tas: ["u_sanduni"],
    tier: "P5", status: "on_hold", posStatus: "hold", min: 80_000, max: 150_000,
    pkg: "80–150K gross", locs: ["Colombo"], nat: [],
    assignedDaysAgo: 40, jdStatus: "approved", value: null,
  },
];

const openings: Opening[] = openingSpecs.map((o, i) => ({
  id: o.id,
  clientId: o.clientId,
  title: o.title,
  positionCode: `C141-${String(i + 1).padStart(4, "0")}`,
  jobOrderNumber: `JO-2026-${String(i + 101).padStart(3, "0")}`,
  // A JD that names the skills it wants, the way a real one does. The earlier
  // version asked only for "proven experience in a comparable role", which is
  // true of every JD ever written and matches nobody in particular — with
  // nothing specific to score against, every candidate came out identical and
  // the ranked list was forty people tied on the same number.
  jdMarkdown: "",
  followUpQuestions: [],
  autoFollowUp: false,
  jdStatus: o.jdStatus,
  jdApprovedBy: o.jdStatus === "approved" ? "u_lead" : null,
  jdApprovedAt: o.jdStatus === "approved" ? ago(o.assignedDaysAgo - 1) : null,
  briefId: null,
  salaryMin: o.min,
  salaryMax: o.max,
  salaryCurrency: o.min > 10_000 ? "LKR" : "USD",
  packageNotes: o.pkg,
  targetGender: null,
    targetNationalities: o.nat,
  locations: o.locs,
  headcount: 1,
  priorityTier: o.tier,
  positionStatus: o.posStatus,
  assignedTaIds: o.tas,
  taLeadId: "u_lead",
  directorId: "u_dir",
  requirementReceivedAt: ago(o.assignedDaysAgo + 2),
  assignedAt: ago(o.assignedDaysAgo),
  closedAt: null,
  valueOnProgressing: o.value,
  valueOfPlacement: null,
  valueLost: null,
  status: o.status,
  createdAt: ago(o.assignedDaysAgo),
  updatedAt: ago(int(0, 3)),
}));

// ─── Job posts ───────────────────────────────────────────────────────────────

const jobPosts: JobPost[] = [
  { openingId: "op_brand", title: "Brand Manager", aliases: ["Senior Brand Manager"], country: "Sri Lanka", ta: "u_nuha" },
  { openingId: "op_brand", title: "Marketing Manager – Brand", aliases: ["Brand Lead"], country: "Sri Lanka", ta: "u_sanduni" },
  { openingId: "op_hof", title: "Head of Finance", aliases: ["Finance Head"], country: "Sri Lanka", ta: "u_zainab" },
  { openingId: "op_hof", title: "Group Finance Manager", aliases: [], country: "Sri Lanka", ta: "u_jesmeen" },
  { openingId: "op_gmmerc", title: "GM Merchandising & Marketing", aliases: ["Head of Merchandising"], country: "Sri Lanka", ta: "u_sanduni" },
  { openingId: "op_gmmerc", title: "Merchandising Manager", aliases: ["GM Merchandising"], country: "Bangladesh", ta: "u_sanduni" },
  { openingId: "op_hobo", title: "Head of Branch Operations", aliases: [], country: "Sri Lanka", ta: "u_thushini" },
  { openingId: "op_chro", title: "Chief Human Resources Officer", aliases: ["Group Head of HR", "CHRO"], country: "Sri Lanka", ta: "u_imalsha" },
  { openingId: "op_mktexe", title: "Marketing Executive", aliases: [], country: "Sri Lanka", ta: "u_sanduni" },
].map((j, i) => {
  const opening = openings.find((o) => o.id === j.openingId)!;
  const client = clients.find((c) => c.id === opening.clientId)!;
  const slug = client.name.toLowerCase().slice(0, 5);
  const cc = j.country === "Bangladesh" ? "bd" : "lk";
  return {
    id: `jp_${i + 1}`,
    openingId: j.openingId,
    title: j.title,
    previousTitles: [],
    campaignCode: "",
    aliasKeywords: j.aliases,
    country: j.country,
    city: null,
    channel: "linkedin" as const,
    routingEmailAlias: `jobs+${slug}-${cc}-${i + 1}@career141.com`,
    assignedTaId: j.ta,
    externalUrl: null,
    postedAt: ago(int(1, 10)),
    status: opening.status === "on_hold" ? ("paused" as const) : ("live" as const),
    cvCountToday: int(0, 16),
    createdAt: ago(int(5, 14)),
  };
});

// ─── Candidates — all invented ───────────────────────────────────────────────

const FIRST = ["Aruna", "Bimal", "Chathuri", "Dilani", "Eranga", "Fathima", "Gayan", "Harsha", "Ishara", "Janaka",
  "Kavindi", "Lakmal", "Menaka", "Nadeesha", "Oshadi", "Pradeep", "Ruwan", "Sachini", "Tharindu", "Udara",
  "Vimukthi", "Waruna", "Yasas", "Zahra", "Amaya", "Buddhika", "Chamara", "Dinesh", "Erandi", "Gihan",
  "Hiruni", "Isuru", "Kasun", "Lahiru", "Malith", "Nimali", "Piyumi", "Rashmi", "Sanduni", "Thilini",
  "Upeksha", "Vishwa", "Yohan", "Anjali", "Chathura", "Dulani", "Hasitha", "Kalpana", "Madushan", "Nipuna",
  "Rukshan", "Sewwandi", "Thisara", "Wasana"];
const LAST = ["Abeywardena", "Bandara", "Colombage", "Dissanayake", "Ekanayake", "Fernando", "Gunasekara",
  "Herath", "Illangakoon", "Jayasuriya", "Karunaratne", "Liyanage", "Mendis", "Nawaratne", "Perera",
  "Rajapaksa", "Samaraweera", "Tennakoon", "Udawatte", "Wickramasinghe", "Amarasinghe", "Balasooriya",
  "Chandrasekara", "De Silva", "Edirisinghe", "Gamage", "Hettiarachchi", "Jayawardena", "Kodikara",
  "Madushanka", "Nanayakkara", "Pathirana", "Ratnayake", "Senanayake", "Thilakaratne", "Vithanage",
  "Weerasinghe", "Yapa", "Abeysekara", "Goonetilleke"];

/** Two people can share a name in life; on a search results page it reads as a bug. */
const usedNames = new Set<string>();
function uniqueName(): { first: string; last: string; name: string } {
  for (let tries = 0; tries < 200; tries++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    const name = `${first} ${last}`;
    if (!usedNames.has(name)) {
      usedNames.add(name);
      return { first, last, name };
    }
  }
  const first = pick(FIRST);
  const last = `${pick(LAST)} ${String.fromCharCode(65 + int(0, 25))}`;
  return { first, last, name: `${first} ${last}` };
}
const EMPLOYERS = ["Northline Holdings", "Vantage Lanka", "Crestmoor Group", "Silverpoint PLC", "Harbourway Ltd",
  "Oakfield Industries", "Meridian Ceylon", "Bluestone Apparel", "Everest Foods", "Kingsbridge PLC"];
const CITIES = ["Colombo", "Gampaha", "Kandy", "Negombo", "Nugegoda", "Dehiwala", "Kurunegala", "Galle"];
const DEGREES = ["MBA", "BSc Business Administration", "CIMA", "CA (SL)", "BBA Marketing", "MSc Management"];

/**
 * Skills, industries and a wider title list — the database search (spec §6D) is
 * only testable against a pool that looks like 115,000 CVs rather than six
 * openings' worth. Still entirely invented; see the seed header.
 */
const SKILLS_BY_FIELD: Record<string, string[]> = {
  marketing: ["Brand Strategy", "Digital Marketing", "Trade Marketing", "Market Research", "Campaign Management", "Social Media", "ATL/BTL", "Product Launch"],
  finance: ["Financial Reporting", "Budgeting", "IFRS", "Treasury", "Audit", "Costing", "Tax Planning", "ERP - SAP"],
  hr: ["Talent Acquisition", "Employee Relations", "Payroll", "HRIS", "Performance Management", "Learning & Development", "Industrial Relations"],
  merch: ["Merchandising", "Sourcing", "Vendor Management", "Costing", "Production Planning", "Buyer Relations", "Tech Packs"],
  ops: ["Supply Chain", "Lean Manufacturing", "Warehouse Management", "Logistics", "Six Sigma", "Process Improvement", "Fleet Management"],
  sales: ["Sales Management", "Sales Strategy", "Key Account Management", "Channel Development", "Distributor Management", "Route to Market"],
  it: ["Project Management", "Data Analysis", "Power BI", "SQL", "Systems Integration", "Change Management"],
};

const INDUSTRIES = ["Apparel", "FMCG", "Manufacturing", "Banking & Finance", "Logistics", "Retail",
  "Hospitality", "Healthcare", "Construction", "Telecom", "Plantation", "IT Services"];

/** title → which skill pool it draws from, so a CV reads coherently. */
const TITLE_FIELD: Record<string, keyof typeof SKILLS_BY_FIELD> = {
  "Brand Manager": "marketing", "Marketing Executive": "marketing", "Marketing Manager": "marketing",
  "Head of Marketing": "marketing", "Digital Marketing Manager": "marketing",
  "Finance Manager": "finance", "Head of Finance": "finance", "Financial Controller": "finance",
  "Accountant": "finance", "Chief Financial Officer": "finance", "Internal Auditor": "finance",
  "Head of Human Resources": "hr", "HR Manager": "hr", "HR Business Partner": "hr", "Recruitment Manager": "hr",
  "Merchandising Manager": "merch", "Senior Merchandiser": "merch", "Merchandiser": "merch", "Sourcing Manager": "merch",
  "Operations Manager": "ops", "Head of Operations": "ops", "Supply Chain Manager": "ops",
  "Production Manager": "ops", "Warehouse Manager": "ops", "Logistics Manager": "ops",
  "Sales Manager": "sales", "Head of Sales": "sales", "Key Account Manager": "sales",
  "Regional Sales Manager": "sales", "Business Development Manager": "sales",
  "IT Manager": "it", "Project Manager": "it", "Business Analyst": "it", "Data Analyst": "it",
};

const DB_TITLES = Object.keys(TITLE_FIELD);

/**
 * The JD text for a seeded opening.
 *
 * Names three or four real skills from the same pool the candidates draw on,
 * plus the years and a qualification where the role warrants one — so the
 * scoring has something to separate people by, as it would on a real JD.
 */
function jdFor(title: string): string {
  const pool = SKILLS_BY_FIELD[TITLE_FIELD[title] ?? "ops"];
  const wanted = pool.slice(0, 3);
  const nice = pool.slice(3, 6);
  const senior = /head|chief|gm|director|group/i.test(title);
  const years = senior ? 10 : 5;
  const qual = /finance|account/i.test(title)
    ? "CIMA or ACCA, part or fully qualified"
    : senior
      ? "MBA preferred"
      : null;

  return [
    `## ${title}`,
    "",
    "Reporting to the leadership team, this role owns delivery across the function.",
    "",
    "**Requirements**",
    "",
    `- Minimum ${years} years in a comparable role`,
    ...wanted.map((w) => `- ${w}`),
    "- Strong stakeholder management",
    ...(qual ? [`- ${qual}`] : []),
    ...(nice.length ? ["", "**Desirable**", "", ...nice.map((n) => `- ${n}`)] : []),
  ].join("\n");
}

function skillsFor(title: string): string[] {
  const pool = SKILLS_BY_FIELD[TITLE_FIELD[title] ?? "ops"];
  const n = int(3, 6);
  const out = new Set<string>();
  while (out.size < n) out.add(pick(pool));
  return [...out];
}

/** Two or three roles back, in the same field, at other companies. */
// Filled here rather than in the literal above, because the skill pools are
// declared after the openings are.
for (const o of openings) o.jdMarkdown = jdFor(o.title);

function makeWorkHistory(title: string, employer: string, years: number) {
  const thisYear = new Date().getFullYear();
  const field = TITLE_FIELD[title] ?? "ops";
  const siblings = DB_TITLES.filter((t) => TITLE_FIELD[t] === field && t !== title);
  const out: { title: string; employer: string; fromYear: number; toYear: number | null }[] = [];
  let cursor = thisYear - Math.min(years, int(2, 5));
  out.push({ title, employer, fromYear: cursor, toYear: null });
  const steps = years > 12 ? 2 : years > 6 ? int(1, 2) : 1;
  for (let k = 0; k < steps; k++) {
    const span = int(2, 4);
    const to = cursor;
    cursor -= span;
    if (cursor < thisYear - years) break;
    out.push({
      title: siblings.length ? pick(siblings) : title,
      employer: pick(EMPLOYERS.filter((e) => e !== employer)),
      fromYear: cursor,
      toYear: to,
    });
  }
  return out;
}

function makeCandidate(i: number, title: string): Candidate {
  const { first, last, name } = uniqueName();
  const employer = pick(EMPLOYERS);
  const years = int(4, 24);
  return {
    id: `ca_${i}`,
    fullName: name,
    email: `${first.toLowerCase()}.${last.toLowerCase().replace(/\s+/g, "")}@example.invalid`,
    phone: `+94 7${int(0, 8)} ${int(100, 999)} ${int(1000, 9999)}`,
    linkedinUrl: `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase().replace(/\s+/g, "-")}-${int(100, 999)}`,
    location: pick(CITIES),
    nationality: rnd() > 0.15 ? "Sri Lankan" : pick(["Indian", "Bangladeshi"]),
    age: int(28, 52),
    gender: rnd() > 0.5 ? "Male" : "Female",
    currentEmployer: employer,
    currentTitle: title,
    totalExperienceYears: years,
    educationDegree: pick(DEGREES),
    educationInstitution: pick(["University of Colombo", "University of Moratuwa", "CIMA", "Open University"]),
    qualifications: null,
    englishLevel: int(6, 10),
    languages: rnd() > 0.8 ? ["English", "Sinhala", "Tamil"] : ["English", "Sinhala"],
    skills: skillsFor(title),
    industries: [pick(INDUSTRIES), ...(rnd() > 0.6 ? [pick(INDUSTRIES)] : [])],
    noticePeriodDays: pick([14, 30, 30, 60, 90]),
    currentSalary: `${int(200, 900)}K gross`,
    expectedSalary: `${int(300, 1200)}K gross`,
    cvFileName: `${name} - Career141.pdf`,
    workHistory: makeWorkHistory(title, employer, years),
    createdAt: ago(int(1, 40)),
  };
}

const candidates: Candidate[] = [];
const applications: Application[] = [];
const callFeedback: CallFeedback[] = [];
const interviews: Interview[] = [];

const TITLE_BY_OPENING: Record<string, string> = {
  op_brand: "Brand Manager",
  op_hof: "Finance Manager",
  op_gmmerc: "Merchandising Manager",
  op_hobo: "Operations Manager",
  op_chro: "Head of Human Resources",
  op_mktexe: "Marketing Executive",
};

// How many candidates sit in each stage, per Opening — shaped to look like a
// real desk rather than an even spread.
const SHAPE: Record<string, Partial<Record<Stage, number>>> = {
  op_brand: { new_cv: 9, matched: 6, ai_follow_up: 3, ta_follow_up: 4, director_review: 4, director_shortlist: 3, client_shortlist: 2, interview: 1, offer: 1, placed: 2, rejected: 5, dropped_out: 2 },
  op_hof: { new_cv: 5, matched: 4, ai_follow_up: 2, ta_follow_up: 3, director_review: 3, director_shortlist: 2, rejected: 3 },
  op_gmmerc: { new_cv: 4, matched: 3, ai_follow_up: 2, ta_follow_up: 4, director_review: 2, director_shortlist: 2, client_shortlist: 1, interview: 2, offer: 1, placed: 1, rejected: 4, dropped_out: 1 },
  op_hobo: { new_cv: 7, matched: 2, ai_follow_up: 1, ta_follow_up: 1 },
  op_chro: { new_cv: 3, matched: 5, ai_follow_up: 2, ta_follow_up: 2, director_review: 3, director_shortlist: 2, client_shortlist: 2, interview: 1, placed: 1, rejected: 6 },
  op_mktexe: { new_cv: 2, ta_follow_up: 1, rejected: 2 },
};

const CHANNELS: SourcingChannel[] = ["DA", "L", "L", "HH", "SCOOP", "E", "IM", "FB"];

let cIdx = 0;
let aIdx = 0;

for (const opening of openings) {
  const shape = SHAPE[opening.id] ?? {};
  const posts = jobPosts.filter((j) => j.openingId === opening.id);
  // Sets are per Opening (spec §7, Q2) — fill sequentially, five to close.
  let setNumber = 1;
  let inCurrentSet = 0;

  for (const [stage, count] of Object.entries(shape) as [Stage, number][]) {
    for (let k = 0; k < count; k++) {
      const cand = makeCandidate(cIdx++, TITLE_BY_OPENING[opening.id] ?? "Manager");

      // A candidate sits in follow-up BECAUSE something is missing — that is
      // the whole reason the stage exists. Seeding them complete made the
      // chase sequence look like it had nothing to do. Each one loses a
      // different combination, including one with no way to reach them at all,
      // so the queue shows every state a sequence can be in.
      if (stage === "ai_follow_up" || stage === "ta_follow_up" || (stage as string) === "follow_up") {
        const gap = k % 5;
        if (gap === 0) cand.currentSalary = null;
        if (gap === 1) { cand.expectedSalary = null; cand.noticePeriodDays = null; }
        if (gap === 2) cand.cvFileName = null;
        if (gap === 3) { cand.currentSalary = null; cand.expectedSalary = null; cand.noticePeriodDays = null; }
        if (gap === 4) { cand.expectedSalary = null; cand.phone = null; cand.email = null; }
      }

      candidates.push(cand);

      const shortlisted = !["new_cv", "matched"].includes(stage);
      let assignedSet: number | null = null;
      if (shortlisted && stage !== "rejected" && stage !== "dropped_out") {
        assignedSet = setNumber;
        inCurrentSet++;
        if (inCurrentSet >= 5) {
          setNumber++;
          inCurrentSet = 0;
        }
      }

      const app: Application = {
        id: `app_${aIdx++}`,
        openingId: opening.id,
        jobPostId: posts.length ? pick(posts).id : null,
        candidateId: cand.id,
        stage,
        answers: {},
        sourcingChannel: pick(CHANNELS),
        ownerTaId: shortlisted ? pick(opening.assignedTaIds) : null,
        shortlistedAt: shortlisted ? ago(int(1, 10)) : null,
        setNumber: assignedSet,
        rating: shortlisted ? int(3, 5) : null,
        notes: [
          `>Total Experience - ${cand.totalExperienceYears}yr`,
          `>Currently at ${cand.currentEmployer}`,
          rnd() > 0.6 ? ">Open to relocation" : ">Available at short notice",
        ],
        statusA: null,
        statusB: null,
        rankTier: null,
        rankWeight: null,
        isAddOn: false,
        addedOnAt: null,
        backupForApplicationId: null,
        offerDeclinedAt: null,
        offerDeclineReason: null,
        rejectedBy: stage === "rejected" ? pick(["u_dir", "u_lead"]) : null,
        rejectReason: stage === "rejected" ? pick(["Not enough sector experience", "Package expectation above range", "Client passed"]) : null,
        droppedOutReason: stage === "dropped_out" ? pick(["Accepted another offer", "Withdrew — counter-offered"]) : null,
        // New CVs keep arriving: most unscreened applicants landed within the
        // last two days, so "CVs today" and "yesterday" count something real.
        createdAt: stage === "new_cv" ? now - int(1, 44) * 3_600_000 : ago(int(2, 20)),
        // Follow-up entries are re-timed by makeOutreach to within the day.
        lastStageChangedAt: (stage === "ai_follow_up" || stage === "ta_follow_up" || (stage as string) === "follow_up") ? ago(k * 2 + 1) : ago(int(0, 6)),
      };
      applications.push(app);

      // Interviews, and the call feedback that goes with them (spec §6A).
      if (stage === "interview" || stage === "offer" || stage === "placed") {
        const scheduled = stage === "interview" ? now + int(2, 30) * 3_600_000 : ago(int(2, 9));
        interviews.push({
          id: `iv_${app.id}`,
          applicationId: app.id,
          scheduledAt: scheduled,
          timezone: "Asia/Colombo",
          location: "Client office, Colombo",
          mode: "in_person",
          round: 1,
          interviewers: ["Hiring Manager"],
          durationMins: 45,
          confirmedAt: stage === "interview" ? null : ago(int(3, 10)),
          notes: null,
          createdAt: ago(int(3, 12)),
          outcome: stage === "interview" ? "pending" : "attended",
          // Attending and passing are two different facts — an interview that
          // has happened has an attendance AND a verdict.
          result: stage === "interview" ? "pending" : "passed",
          clientRating: stage === "interview" ? null : int(3, 5),
          clientFeedback:
            stage === "interview"
              ? null
              : "Strong on the technical side. Wanted more detail on how they have handled a team through a restructure.",
        });
        if (stage !== "interview") {
          callFeedback.push({
            id: `cf_${app.id}_post`,
            applicationId: app.id,
            kind: "post_interview",
            outcome: "reached",
            body: "Candidate felt the conversation went well. Comfortable with the scope, asked about reporting lines and the travel expectation.",
            structured: null,
            source: "manual",
            recordedBy: app.ownerTaId ?? "u_lead",
            recordedAt: ago(int(1, 6)),
          });
        }
      }
    }
  }
}

// ─── Referees — invented, like every other person in this dataset ────────────

const RELATIONSHIPS = [
  "Former line manager",
  "Head of department",
  "Direct supervisor",
  "Managing Director",
  "Former colleague",
];

const referees: Referee[] = [];
let refIdx = 0;
for (const c of candidates) {
  // Not every CV lists referees, and the ones that do usually list two.
  if (rnd() > 0.55) continue;
  const n = rnd() > 0.5 ? 2 : 1;
  for (let i = 0; i < n; i++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    referees.push({
      id: `rf_${refIdx++}`,
      fromCandidateId: c.id,
      name: `${first} ${last}`,
      title: pick(["Head of Finance", "General Manager", "Director - Operations", "Chief Executive", "Head of HR"]),
      company: rnd() > 0.35 ? (c.currentEmployer ?? pick(EMPLOYERS)) : pick(EMPLOYERS),
      phone: rnd() > 0.3 ? `+94 7${int(0, 8)} ${int(100, 999)} ${int(1000, 9999)}` : null,
      email: `${first.toLowerCase()}.${last.toLowerCase().replace(/\s+/g, "")}@example.invalid`,
      relationship: pick(RELATIONSHIPS),
      contactable: rnd() > 0.2,
      lastContactedAt: null,
      extractedAt: c.createdAt,
    });
  }
}

// ─── Link vault ──────────────────────────────────────────────────────────────

const linkVault: LinkVaultEntry[] = [];
let lIdx = 0;
for (const opening of openings.filter((o) => o.status === "open")) {
  const n = int(6, 14);
  for (let i = 0; i < n; i++) {
    const first = pick(FIRST);
    const last = pick(LAST);
    linkVault.push({
      id: `lv_${lIdx++}`,
      openingId: opening.id,
      addedBy: pick(opening.assignedTaIds),
      linkedinUrl: `https://www.linkedin.com/in/${first.toLowerCase()}-${last.toLowerCase().replace(/\s+/g, "-")}-${int(100, 999)}`,
      name: `${first} ${last}`,
      title: TITLE_BY_OPENING[opening.id] ?? "Manager",
      company: pick(EMPLOYERS),
      isEyeMarked: i < 2,
      phoneNumber: rnd() > 0.5 ? `+94 7${int(0, 8)} ${int(100, 999)} ${int(1000, 9999)}` : null,
      phoneSource: rnd() > 0.5 ? pick(["mutual_connection", "reception_call", "internal_db"]) : null,
      sourcingChannel: rnd() > 0.3 ? "L" : "HH",
      outcome: pick(["no_contact", "contacted", "contacted", "responded", "cv_received", "unreachable"]),
      candidateId: null,
      conversationLog: [],
      createdAt: ago(int(1, 12)),
    });
  }
}

// ─── Alerts (spec §12) ───────────────────────────────────────────────────────

const alerts: Database["alerts"] = [];
let alIdx = 0;

// Low volume: any live post under 10 CVs today.
for (const jp of jobPosts.filter((j) => j.status === "live" && j.cvCountToday < 10)) {
  const opening = openings.find((o) => o.id === jp.openingId)!;
  alerts.push({
    id: `al_${alIdx++}`, kind: "low_volume", subjectType: "job_post", subjectId: jp.id,
    assignedTo: jp.assignedTaId ?? opening.taLeadId, raisedAt: ago(0), dueAt: now + DAY,
    resolvedAt: null, detail: `${jp.cvCountToday} CVs today on "${jp.title}" — under the 10/day line`,
  });
}

// Interview confirmation, and the 4h escalation where no pre-interview call is logged.
for (const iv of interviews.filter((i) => i.outcome === "pending")) {
  const app = applications.find((a) => a.id === iv.applicationId)!;
  const opening = openings.find((o) => o.id === app.openingId)!;
  const cand = candidates.find((c) => c.id === app.candidateId)!;
  alerts.push({
    id: `al_${alIdx++}`, kind: "interview_confirmation", subjectType: "application", subjectId: app.id,
    assignedTo: app.ownerTaId ?? opening.taLeadId, raisedAt: ago(0), dueAt: iv.scheduledAt,
    resolvedAt: null, detail: `Confirm ${cand.fullName} is attending today's interview`,
  });
  alerts.push({
    id: `al_${alIdx++}`, kind: "interview_confirmation_escalation", subjectType: "application", subjectId: app.id,
    assignedTo: opening.taLeadId, raisedAt: ago(0), dueAt: iv.scheduledAt - 4 * 3_600_000,
    resolvedAt: null, detail: `${cand.fullName} not yet contacted — interview in under 4 hours`,
  });
}

// Stale role: live longer than the priority tier's target.
for (const o of openings.filter((x) => x.status === "open")) {
  const days = Math.floor((now - (o.assignedAt ?? now)) / DAY);
  const target = { P1: 14, P2: 21, P3: 30, P4: 45, P5: 60 }[o.priorityTier];
  if (days > target * 0.5) {
    alerts.push({
      id: `al_${alIdx++}`, kind: "stale_role", subjectType: "opening", subjectId: o.id,
      assignedTo: o.taLeadId, raisedAt: ago(0), dueAt: now + DAY, resolvedAt: null,
      detail: `${o.title} — day ${days} of a ${o.priorityTier} (${target}-day) target`,
    });
  }
}

const briefs: Brief[] = [];

// ─── The database itself ─────────────────────────────────────────────────────
//
// Everyone above arrived through one of the six live openings. The real pool is
// the other 115,000 — people who came in through roles that closed years ago and
// sit in the database waiting to be found again. Search is untestable without
// them, so the seed carries a proportionate stand-in: candidates attached to no
// opening at all, spread across every title in the vocabulary.

const DB_POOL = 620;
for (let i = 0; i < DB_POOL; i++) {
  const c = makeCandidate(cIdx++, pick(DB_TITLES));
  // Database CVs are older on average — that is what makes them a database.
  c.createdAt = ago(int(30, 900));
  candidates.push(c);
}

// A handful were placed by us years ago. Worth surfacing on a search, and worth
// flagging before anyone approaches them.
const alumni = candidates.slice(-DB_POOL).filter(() => rnd() > 0.94);
for (const c of alumni) {
  applications.push({
    id: `app_${aIdx++}`,
    openingId: pick(openings).id,
    jobPostId: null,
    candidateId: c.id,
    stage: "placed",
    answers: {},
    sourcingChannel: "SCOOP",
    ownerTaId: pick(users.filter((u) => u.role === "ta")).id,
    shortlistedAt: ago(int(400, 700)),
    setNumber: null,
    rating: null,
    // Marked, because these predate the platform: they have no offer,
    // placement or agreement record and should not be counted as current work.
    notes: ["Placed through Career141", ">Historical placement — before this system"],
    statusA: null, statusB: null, rankTier: null, rankWeight: null,
    isAddOn: false, addedOnAt: null,
    backupForApplicationId: null, offerDeclinedAt: null, offerDeclineReason: null,
    rejectedBy: null, rejectReason: null, droppedOutReason: null,
    createdAt: ago(int(700, 900)),
    lastStageChangedAt: ago(int(400, 700)),
  });
}

const savedSearches: SavedSearch[] = [
  {
    id: "ss_1",
    name: "Apparel merchandisers, Colombo",
    query: "Merchandiser in Colombo with apparel experience, at least 6 years, notice under 30 days",
    mode: "natural",
    ownerId: "u_sanduni",
    openingId: "op_gmmerc",
    createdAt: ago(11),
    lastRunAt: ago(2),
    lastResultCount: null,
  },
  {
    id: "ss_2",
    name: "Finance leads — CIMA or CA",
    query: "Finance Manager or Head of Finance, CIMA or CA, 10+ years, Colombo or Gampaha",
    mode: "natural",
    ownerId: "u_zainab",
    openingId: "op_hof",
    createdAt: ago(24),
    lastRunAt: ago(5),
    lastResultCount: null,
  },
  {
    id: "ss_3",
    name: "FMCG sales — not from Everest",
    query: "Sales Manager with FMCG and distributor management, not from Everest Foods",
    mode: "natural",
    ownerId: "u_lead",
    openingId: null,
    createdAt: ago(40),
    lastRunAt: null,
    lastResultCount: null,
  },
];

// ─── Pipeline events ─────────────────────────────────────────────────────────
//
// The history behind each application. Without these the candidate timeline is
// empty on every seeded person, which makes a working feature look broken —
// and more to the point, a pipeline whose past is blank cannot answer the
// question the timeline exists for.
//
// Reconstructed from where each application ended up: the route it must have
// taken to get there, spaced backwards from its last stage change.

const ROUTE: Partial<Record<Stage, Stage[]>> = {
  matched: [],
  ai_follow_up: ["new_cv"],
  ta_follow_up: ["new_cv", "ai_follow_up"],
  director_review: ["new_cv", "ai_follow_up", "ta_follow_up"],
  director_shortlist: ["new_cv", "ai_follow_up", "ta_follow_up", "director_review"],
  client_shortlist: ["new_cv", "ai_follow_up", "ta_follow_up", "director_review", "director_shortlist"],
  interview: ["new_cv", "ai_follow_up", "ta_follow_up", "director_review", "director_shortlist", "client_shortlist"],
  offer: ["new_cv", "ai_follow_up", "ta_follow_up", "director_review", "director_shortlist", "client_shortlist", "interview"],
  placed: ["new_cv", "ai_follow_up", "ta_follow_up", "director_review", "director_shortlist", "client_shortlist", "interview", "offer"],
  rejected: ["new_cv"],
  dropped_out: ["new_cv", "ai_follow_up", "ta_follow_up"],
};

/** Who or what made each move — the same distinction the live events carry. */
function actorFor(to: Stage): { actorType: PipelineEvent["actorType"]; eventType: string } {
  if (to === "director_shortlist") return { actorType: "director", eventType: "director_shortlisted" };
  if (to === "client_shortlist") return { actorType: "client", eventType: "client_shortlisted" };
  if (to === "ai_follow_up" || to === "ta_follow_up" || (to as string) === "follow_up") return { actorType: "system", eventType: "moved_to_follow_up" };
  return { actorType: "user", eventType: `moved_to_${to}` };
}

const REASON: Partial<Record<Stage, string>> = {
  director_review: "Set closed at five — sent up.",
  director_shortlist: "Yes from the Director.",
  client_shortlist: "Client picked them off the set.",
  interview: "Interview booked.",
  rejected: "Not enough sector experience.",
  dropped_out: "Withdrew — counter-offered.",
};

function makeEvents(): PipelineEvent[] {
  const out: PipelineEvent[] = [];
  let n = 0;

  for (const app of applications) {
    if (app.notes.includes(">Historical placement — before this system")) continue;
    const route = ROUTE[app.stage];
    if (!route) continue;
    const steps = [...route.slice(1), app.stage];
    /*
     * Spread the route evenly across the application's own life rather than
     * stepping back a fixed interval — a fixed step puts a nine-stage history
     * twelve days before a CV that arrived five days ago, and every event that
     * predates the record gets dropped, which is how the first attempt
     * produced a full pipeline with an empty timeline.
     */
    const span = Math.max(app.lastStageChangedAt - app.createdAt, 3_600_000);
    const gap = span / steps.length;
    steps.forEach((to, i) => {
      const from = i === 0 ? route[0] : steps[i - 1];
      const at = Math.round(app.createdAt + gap * (i + 1));
      const { actorType, eventType } = actorFor(to);
      out.push({
        id: `pe_s${n++}`,
        applicationId: app.id,
        openingId: app.openingId,
        eventType,
        fromStage: from,
        toStage: to,
        actorType,
        actorId: actorType === "user" ? (app.ownerTaId ?? null) : actorType === "director" ? "u_dir" : null,
        note: REASON[to] ?? null,
        at,
      });
    });
  }
  return out;
}

// ─── Closing records ─────────────────────────────────────────────────────────
//
// Agreements, offers and placements for the applications already sitting at
// those stages. The set is written to cover the states that cost money, not
// the happy path: one client with no signed agreement behind a live placement,
// one placement that joined and was never invoiced, one with its guarantee
// about to close, and one that fell through inside the window.

function makeEsas(): EsaRecord[] {
  return [
    {
      id: "esa_delmo", clientId: "cl_delmo", openingId: null, status: "signed",
      feePercent: 12, guaranteeDays: 90,
      sentAt: ago(210), signedAt: ago(203), signedBy: "Group Head of HR",
      dueAt: ago(196), documentName: "Delmo — ESA 2026.pdf", notes: null, createdAt: ago(210),
    },
    {
      id: "esa_ckdl", clientId: "cl_ckdl", openingId: null, status: "signed",
      feePercent: 15, guaranteeDays: 60,
      sentAt: ago(150), signedAt: ago(141), signedBy: "Director — People",
      dueAt: ago(136), documentName: "CKDL — ESA.pdf", notes: "Higher rate, shorter guarantee.",
      createdAt: ago(150),
    },
    {
      // Sent and never signed, with a live placement underneath it. This is the
      // one the standing check exists for: the fee has nothing behind it.
      id: "esa_apex", clientId: "cl_apex", openingId: null, status: "sent",
      feePercent: 12, guaranteeDays: 90,
      sentAt: ago(24), signedAt: null, signedBy: null,
      dueAt: ago(10), documentName: "Apex — ESA draft.pdf",
      notes: "Chased twice. Legal are sitting on it.", createdAt: ago(24),
    },
    {
      id: "esa_lankahosp", clientId: "cl_lankahosp", openingId: null, status: "draft",
      feePercent: 10, guaranteeDays: 120,
      sentAt: null, signedAt: null, signedBy: null,
      dueAt: null, documentName: null, notes: "Terms still being agreed.", createdAt: ago(9),
    },
  ];
}

function makeClosings(): { offers: Offer[]; placements: Placement[] } {
  const offers: Offer[] = [];
  const placements: Placement[] = [];
  const esas = makeEsas();

  const salaryOf = (c: Candidate) => {
    const n = Number((c.expectedSalary ?? "600K").replace(/[^\d]/g, ""));
    return (Number.isFinite(n) && n > 0 ? n : 600) * 1_000;
  };

  // Only the current pipeline. The seed also carries ~30 people this desk
  // placed years ago as database history; giving each of those a live offer and
  // an uninvoiced placement would manufacture about fifteen million rupees of
  // outstanding fees that do not exist.
  const HISTORICAL = ">Historical placement — before this system";
  let placementIndex = 0;

  applications
    .filter((a) => (a.stage === "offer" || a.stage === "placed") && !a.notes.includes(HISTORICAL))
    .forEach((app, i) => {
      const cand = candidates.find((c) => c.id === app.candidateId)!;
      const opening = openings.find((o) => o.id === app.openingId)!;
      const esa = esas.find((e) => e.clientId === opening.clientId);
      const accepted = app.stage === "placed";
      const salary = salaryOf(cand);

      const offer: Offer = {
        id: `of_${app.id}`,
        applicationId: app.id,
        openingId: opening.id,
        candidateId: cand.id,
        salary,
        salaryBasis: "monthly",
        currency: "LKR",
        startDate: accepted ? ago(-14 + i * 9) : ago(-30),
        terms: "Vehicle, fuel and a driver allowance on top of the basic.",
        status: accepted ? "accepted" : "pending",
        respondedAt: accepted ? ago(20) : null,
        declineReason: null,
        madeBy: opening.taLeadId,
        createdAt: ago(accepted ? 26 : 5),
      };
      offers.push(offer);
      if (!accepted) return;

      // Each placement lands in a different state so the money screen shows
      // what it is for rather than a column of finished rows.
      const shape = placementIndex++ % 4;
      const joinedDaysAgo = shape === 0 ? 4 : shape === 1 ? 40 : shape === 2 ? 82 : 20;
      const joinDate = ago(joinedDaysAgo);

      placements.push({
        id: `pl_${app.id}`,
        offerId: offer.id,
        applicationId: app.id,
        openingId: opening.id,
        candidateId: cand.id,
        clientId: opening.clientId,
        placedBy: app.ownerTaId ?? opening.taLeadId,
        sourcingChannel: app.sourcingChannel,
        salary,
        salaryBasis: "monthly",
        currency: "LKR",
        joinDate,
        // shape 0: started days ago, nobody has confirmed it.
        joinConfirmedAt: shape === 0 ? null : ago(joinedDaysAgo - 1),
        feePercent: esa?.feePercent ?? 12,
        flatFee: null,
        // shape 2: joined nearly three months ago, never invoiced.
        invoiceSentAt: shape === 0 || shape === 2 ? null : ago(joinedDaysAgo - 3),
        invoiceNumber: shape === 0 || shape === 2 ? null : `INV-2026-${100 + i}`,
        invoicePaidAt: shape === 1 ? ago(joinedDaysAgo - 25) : null,
        guaranteeDays: esa?.guaranteeDays ?? 90,
        // shape 3: walked out inside the guarantee.
        fellThroughAt: shape === 3 ? ago(6) : null,
        fellThroughReason: shape === 3 ? "Counter-offered by the previous employer in week two." : null,
        notes: null,
        createdAt: ago(joinedDaysAgo + 6),
      });
    });

  return { offers, placements };
}

// ─── Follow-up history ───────────────────────────────────────────────────────
//
// Follow-up runs inside one day, so the people in it entered at different
// hours today and yesterday, and each has been taken through the real engine up
// to now — a call answered here, a callback booked there, one nobody has
// touched, one whose day has run out. The history is produced by the same
// rules the live screen reads, so the two cannot disagree.

function makeOutreach(): OutreachMessage[] {
  const out: OutreachMessage[] = [];
  const inFollowUp = applications.filter((a) => a.stage === "ai_follow_up" || a.stage === "ta_follow_up" || (a.stage as string) === "follow_up");
  const HOUR = 3_600_000;
  const outcomes: FollowUpCallOutcome[] = ["no_answer", "answered", "callback", "will_send", "no_answer"];

  inFollowUp.forEach((app, i) => {
    // Spread entries over the last thirty hours: most still inside their day,
    // a few past it.
    app.lastStageChangedAt = now - (2 + ((i * 7) % 30)) * HOUR;

    const cand = candidates.find((c) => c.id === app.candidateId)!;
    const opening = openings.find((o) => o.id === app.openingId)!;
    const ta = users.find((u) => u.id === app.ownerTaId) ?? users[0];
    // A quarter untouched, so "the call is owed now" is on screen too.
    if (i % 4 === 0) return;

    const contacts: Contact[] = [];
    for (let guard = 0; guard < 8; guard++) {
      const f = followUpFor({
        candidate: cand,
        questions: STANDARD_QUESTIONS,
        enteredAt: app.lastStageChangedAt,
        contacts,
        now,
      });
      if (!f.next || f.next.at > now) break;
      const at = f.next.at;

      if (f.next.channels.includes("ai_call")) {
        const outcome = outcomes[(i + guard) % outcomes.length];
        const promisedAt = outcome === "callback" || outcome === "will_send" ? at + 2 * HOUR : null;
        contacts.push({ at, channel: "ai_call", direction: "out", outcome, promisedAt });
        out.push({
          id: `om_${app.id}_${guard}_call`,
          applicationId: app.id,
          candidateId: cand.id,
          direction: "out",
          channel: "ai_call",
          attempt: guard + 1,
          to: cand.phone,
          subject: null,
          body:
            outcome === "callback"
              ? "Busy at work — asked for a call back in two hours."
              : outcome === "will_send"
                ? "Said they would WhatsApp the figures within two hours."
                : outcome === "answered"
                  ? "Spoke briefly; did not have the salary figures to hand."
                  : "",
          sentAt: at,
          byUserId: null,
          createdAt: at,
          callOutcome: outcome,
          promisedAt,
        });
        continue;
      }

      for (const d of draftsFor({
        candidate: cand,
        missing: f.missing,
        roleTitle: opening.title,
        purpose: f.next.purpose,
        channels: f.next.channels,
        taName: ta.name.split(" ")[0],
      })) {
        contacts.push({ at, channel: d.channel, direction: "out" });
        out.push({
          id: `om_${app.id}_${guard}_${d.channel}`,
          applicationId: app.id,
          candidateId: cand.id,
          direction: "out",
          channel: d.channel,
          attempt: guard + 1,
          to: d.to,
          subject: d.subject,
          body: d.body,
          sentAt: at,
          byUserId: null,
          createdAt: at,
        });
      }
    }
  });

  return out;
}

// ─── The intake queue ────────────────────────────────────────────────────────
//
// Six CVs at the door, written so the queue shows every outcome dedup can
// reach rather than a row of happy cases. Two of them are duplicates of people
// already on the database — one plainly, one that only LOOKS like one — which
// is the pair the whole review step exists for.
//
// Every person here is invented, as everywhere else in this seed.

function cvText(x: {
  name: string; email?: string | null; phone?: string | null; linkedin?: string | null;
  title: string; employer: string; city: string; years: number; degree: string;
  institution: string; skills: string[];
}): string {
  return [
    "CURRICULUM VITAE",
    "",
    x.name,
    x.title,
    "",
    "Personal Details",
    `Address: ${x.city}, Sri Lanka`,
    x.email ? `Email: ${x.email}` : null,
    x.phone ? `Mobile: ${x.phone}` : null,
    x.linkedin ? `LinkedIn: ${x.linkedin}` : null,
    "NIC No: 199012345678",
    "",
    "Profile",
    `A ${x.title.toLowerCase()} with over ${x.years} years experience across the sector.`,
    "",
    "Employment",
    `Company: ${x.employer}`,
    `Position: ${x.title}`,
    "",
    "Education",
    `${x.degree} — ${x.institution}`,
    `University: ${x.institution}`,
    "",
    "Key Skills",
    ...x.skills.map((sk) => `- ${sk}`),
    "",
    "Referees available on request.",
  ].filter((l) => l !== null).join("\n");
}

/** The queue turns over within a day, so it is the only thing in this seed
 *  measured in hours rather than days. */
const hoursAgo = (h: number) => now - h * 3_600_000;

function makeIntake(): IntakeItem[] {
  const existingA = candidates[0];
  const existingB = candidates[1];
  const existingC = candidates[2];

  const drafts: {
    id: string; source: IntakeItem["source"]; from: string | null; hours: number;
    fileName: string; openingId: string | null; text: string;
    /** For the email arrivals: the mailbox it came to and the subject, which
     *  is what the router actually works from. */
    to?: string; subject?: string;
    status?: IntakeItem["status"]; note?: string; handledBy?: string;
  }[] = [
    {
      // Nobody we have. The ordinary case.
      id: "in_1", source: "email", from: "dilrukshi.a@example.invalid", hours: 3,
      fileName: "Dilrukshi Amarasinghe CV.pdf", openingId: null,
      to: "sanduni.jobs@career141.com",
      subject: "New application: Marketing Executive from Dilrukshi Amarasinghe",
      text: cvText({
        name: "Dilrukshi Amarasinghe", email: "dilrukshi.a@example.invalid",
        phone: "077 418 2260", title: "Marketing Executive", employer: "Hemas Consumer Brands",
        city: "Nugegoda", years: 5, degree: "BSc Marketing Management",
        institution: "University of Sri Jayewardenepura",
        skills: ["Campaign planning", "Social media", "Trade marketing", "Google Analytics"],
      }),
    },
    {
      // Same person as an existing record, sending an updated CV. The email
      // matches once it is lowercased; the phone is written the other way; the
      // name is down to an initial. The live dedup finds this one on email and
      // then, because the candidate is not sitting in follow_up, throws the new
      // CV away with a console line.
      id: "in_2", source: "email", from: "gihan.n@example.invalid", hours: 9,
      fileName: "CV updated.pdf", openingId: null,
      to: "nuha.jobs@career141.com",
      subject: "Gihan Nanayakkara applied to Brand Manager at Delmo",
      text: cvText({
        name: `${existingA.fullName.split(" ")[0][0]}. ${existingA.fullName.split(" ").slice(-1)[0]}`,
        email: existingA.email!.toUpperCase(),
        phone: `0${existingA.phone!.replace(/\D/g, "").slice(2)}`,
        title: existingA.currentTitle!, employer: existingA.currentEmployer!,
        city: existingA.location!, years: (existingA.totalExperienceYears ?? 8) + 1,
        degree: existingA.educationDegree!, institution: existingA.educationInstitution!,
        skills: existingA.skills.slice(0, 4),
      }),
    },
    {
      // The trap. One phone number, two people — a household line, or a number
      // typed in wrong. The live dedup merges these two records into one
      // person and lets the second CV overwrite the first.
      id: "in_3", source: "whatsapp", from: existingB.phone, hours: 14,
      fileName: "cv_scan_0042.pdf", openingId: null,
      text: cvText({
        name: "Tharindu Wickramasuriya", email: null,
        phone: existingB.phone!, title: "Stores Supervisor", employer: "Ceylon Cold Stores",
        city: "Kelaniya", years: 6, degree: "Diploma in Supply Chain Management",
        institution: "Open University", skills: ["Inventory control", "SAP MM", "Team supervision"],
      }),
    },
    {
      // Same name, nothing in common, related employer. Might be them under a
      // new address; might be two people who share a common name. Only a human
      // can say, so only a human does.
      id: "in_4", source: "email", from: "careers.reply@example.invalid", hours: 20,
      to: "nuha.jobs@career141.com", subject: "Sending my CV for consideration",
      fileName: `${existingC.fullName} - CV 2026.pdf`, openingId: null,
      text: cvText({
        name: existingC.fullName, email: "applications.2026@example.invalid",
        phone: "071 330 8890", title: existingC.currentTitle!,
        employer: `${existingC.currentEmployer!.split(" ")[0]} Holdings`,
        city: "Colombo 05", years: existingC.totalExperienceYears ?? 10,
        degree: "MBA", institution: "University of Colombo",
        skills: ["Budgeting", "Stakeholder management"],
      }),
    },
    {
      // A photograph of a printed CV. Almost nothing readable. This is a large
      // share of what actually arrives on WhatsApp, and the queue should show
      // it as it is rather than manufacture fields for it.
      id: "in_5", source: "whatsapp", from: "+94 76 551 0084", hours: 26,
      fileName: "IMG-20260910-WA0007.jpg", openingId: null,
      text: "CURRICULUM VITAE\n\nSampath Ranaweera\n\n[image — no extractable text]",
    },
    {
      // Already dealt with, so the queue has a past as well as a present.
      id: "in_6", source: "email", from: "noreply@jobsite.example.invalid", hours: 50,
      fileName: "newsletter.pdf", openingId: null,
      text: "Weekly recruitment digest\n\nTop stories this week in hiring.",
      status: "rejected", note: "Not a CV — mailing list.", handledBy: "u_zainab",
    },
  ];

  const known = candidates.map((c) => ({
    fullName: c.fullName, email: c.email, phone: c.phone,
    linkedinUrl: c.linkedinUrl, currentEmployer: c.currentEmployer, location: c.location,
  }));

  return drafts.map((d) => {
    const route =
      d.to && d.subject ? routeInbound({ to: d.to, subject: d.subject }, users, jobPosts) : null;
    const routedTa = route?.taId ? users.find((u) => u.id === route.taId) ?? null : null;
    const parsed = parseCv(d.text);
    const problems = problemsWith(parsed);
    const m = matchAgainst(
      {
        fullName: parsed.fullName ?? "",
        email: parsed.email, phone: parsed.phone, linkedinUrl: parsed.linkedinUrl,
        currentEmployer: parsed.currentEmployer, location: parsed.location,
      },
      known,
    );
    const hit = m.index >= 0 ? candidates[m.index] : null;
    const status: IntakeItem["status"] =
      d.status ?? (m.verdict === "review" ? "needs_review" : "ready");
    return {
      id: d.id,
      source: d.source,
      receivedFrom: d.from,
      receivedAt: hoursAgo(d.hours),
      fileName: d.fileName,
      fileHash: null,
      sizeBytes: 40_000 + d.text.length * 90,
      rawText: d.text,
      parsed,
      match: {
        verdict: m.verdict,
        candidateId: hit?.id ?? null,
        candidateName: hit?.fullName ?? null,
        evidence: m.evidence,
        reason: m.reason,
        checkedAt: hoursAgo(d.hours),
      },
      status,
      toAddress: d.to ?? null,
      subject: d.subject ?? null,
      openingId: d.openingId ?? route?.openingId ?? null,
      jobPostId: route?.postId ?? null,
      routedToTaId: route?.taId ?? null,
      routeNote: route ? routeNote(route, routedTa?.name ?? null) : null,
      routeConfidence: route?.confidence ?? null,
      candidateId: null,
      handledBy: d.handledBy ?? null,
      handledAt: d.status ? hoursAgo(d.hours - 1) : null,
      note: d.note ?? null,
      problems,
    };
  });
}

export function buildSeed(): Database {
  // Research, benchmarks and suggestions are generated on demand and cost money
  // to produce. Seeding fakes would teach the desk to trust output nothing
  // fetched, which is the opposite of what these features are for.
  return { users, briefs, clients, openings, jobPosts, candidates, referees, applications, callFeedback, interviews, linkVault, alerts, savedSearches, savedReports: [], assignments: [], pipelineEvents: makeEvents(), reviewRounds: [], researchReports: [], benchmarks: [], suggestions: [], chat: [], intake: makeIntake(), outreach: makeOutreach(), ...makeClosings(), esaRecords: makeEsas(), aiCalls: [], settings: [], matchRuns: [], matchExclusions: [], liveMirror: [] };
}
