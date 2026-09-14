/**
 * C141_DATA_DIR=$PWD/.data-live-test node --import ./tests/alias.mjs scripts/p1/evaluate.ts <final.json> [laptop.jsonl]
 *
 * P1 evaluation (14 September). Per model, per job and overall, against the
 * recruiter's decisions, with the continue-to-P2 rule applied in code.
 */
import fs from "node:fs";
import path from "node:path";
import { evaluateP1 } from "@/lib/p1Evaluate";
const { dataDir } = await import("@/data/dataDir");

const finalFile = process.argv[2];
if (!finalFile) { console.error("Pass the final.json path."); process.exit(1); }
const final = JSON.parse(fs.readFileSync(finalFile, "utf8")) as { rows: Parameters<typeof evaluateP1>[0]["rows"] };
const set = JSON.parse(fs.readFileSync(path.join(dataDir(), "review", "screenset-v3.json"), "utf8")) as { items: { job: number; id: string; decisions: Record<string, string> }[] };
const truth = Object.fromEntries(set.items.map((i) => [`${i.job}|${i.id}`, i.decisions.u_lead]));
console.log(JSON.stringify(evaluateP1({ rows: final.rows, truth, peoplePerModel: set.items.length }), null, 1));
process.exit(0);
