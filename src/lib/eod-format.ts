import type { Id } from "@/data/types";

/**
 * The shape and column names of the end-of-day email, with no data access —
 * deliberately separate from `eod.ts` so a client component can import it
 * without dragging the server-side store into the browser bundle.
 */

export interface ShortlistRow {
  no: number;
  name: string;
  location: string;
  age: string;
  notice: string;
  notes: string[];
  currentCompany: string;
  currentDesignation: string;
  currentRemuneration: string;
  expectedRemuneration: string;
  applicationId: Id;
}

export interface EffortRow {
  date: string;
  assignee: string;
  hundredOrFollowUp: string;
  lEffort: number | null;
  sets: number | null;
  da: number | null;
  scoop: number | null;
  l: number | null;
  post: number | null;
  addOns: number | null;
  backUp: number | null;
}

/** Table one, in the order the desk sends it. */
export const SHORTLIST_COLUMNS = [
  "NO",
  "NAME",
  "LOCATION",
  "AGE",
  "NOTICE",
  "NOTES",
  "CURRENT COMPANY",
  "CURRENT DESIGNATION",
  "CURRENT REMUNERATION",
  "EXPECTED REMUNERATION",
] as const;

/** Table two — the L-sheet. */
export const EFFORT_COLUMNS = [
  { key: "date", label: "DATE" },
  { key: "assignee", label: "ASSIGNEE" },
  { key: "hundredOrFollowUp", label: "100% / FOLLOW UP" },
  { key: "lEffort", label: "NO.OF L EFFORT" },
  { key: "sets", label: "SETS" },
  { key: "da", label: "DA (Direct Applicant)" },
  { key: "scoop", label: "SCOOP" },
  { key: "l", label: "L" },
  { key: "post", label: "POST" },
  { key: "addOns", label: "ADD-ONS" },
  { key: "backUp", label: "BACK-UP" },
] as const;

/**
 * Q4a — still undefined, so these print empty rather than zero. A blank says
 * "not tracked yet"; a zero says "nothing happened", and those are very
 * different messages to a Director.
 */
export const UNDEFINED_COLUMNS = new Set(["post", "addOns", "backUp"]);
