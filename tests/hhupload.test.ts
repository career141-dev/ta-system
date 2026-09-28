/**
 * "Upload headhunted CV" on TA Follow-up (28 Sep). The extraction itself is the
 * CV platform's and is not re-tested here; these pin what this feature adds:
 * the channel it records reads as HH everywhere, and the wiring that files a
 * headhunted upload into TA Follow-up is in place for every way the pipeline
 * can file a CV on an opening.
 */
import fs from "node:fs";
import path from "node:path";

const { channelOf } = await import("@/data/convex/map");

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

console.log("\nthe channel");
const hh = read("convex/ta/hhUpload.ts");
const channel = /HEADHUNT_CHANNEL = "([^"]+)"/.exec(hh)?.[1];
eq("the upload records a channel", typeof channel, "string");
eq("which the TA System reads as HH", channelOf(channel), "HH");
eq("an ordinary manual upload is not HH", channelOf("manual_upload"), "E");

console.log("\nthe upload uses the existing extraction, not a new one");
eq("queued on processCvExtraction", hh.includes("api.cvs.cvExtraction.processCvExtraction"), true);
eq("filed on this opening through assignToJob", /assignToJob: job\._id/.test(hh), true);
eq("no text extraction of its own", /extractText|callOpenRouterLLM/.test(hh), false);
eq("claimed by the same rule as Shortlist", hh.includes("claimForTa(ctx, user, app)"), true);
eq("flagged HH on the application", hh.includes('taSourcingChannel: "HH"'), true);

console.log("\nevery place the pipeline files a CV on an opening hands a headhunt on");
const ex = read("convex/cvs/cvExtraction.ts");
const filings = (ex.match(/await filePosts\(ctx,/g) ?? []).length;
const hooks = (ex.match(/internal\.ta\.hhUpload\.fileHeadhunt/g) ?? []).length;
eq("one hook per filing", hooks, filings);
eq("and only for a headhunted upload", (ex.match(/if \(cvUpload\?\.headhuntedBy\)/g) ?? []).length, filings);

console.log("\nthe button");
const page = read("src/app/openings/[id]/pipeline/[stage]/page.tsx");
eq("shown on TA Follow-up only", page.includes('s === "ta_follow_up" && canAct && <HhUpload'), true);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
