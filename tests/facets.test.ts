/**
 * The filters beside the Database results (29 Oct): strict, in memory, counts
 * that match what ticking would give. Synthetic people only.
 */
import { FACETS, anyActive, cityOf, facetOptions, hiddenForUnknownYears, pickedFrom, rowMatches, titleKey, type FacetRow } from "@/lib/facets";
import { FILTER_PARAMS, resultsKeyOf } from "@/lib/query";
import type { Candidate } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const row = (id: string, c: Partial<Candidate>, signals: string[] = []): FacetRow => ({
  candidate: { id, currentTitle: null, location: null, totalExperienceYears: null, noticePeriodDays: null, industries: [], ...c } as unknown as Candidate,
  signals: signals.map((kind) => ({ kind })),
});
const rows: FacetRow[] = [
  row("a", { currentTitle: "Accountant", location: "Colombo, Sri Lanka", totalExperienceYears: 2, noticePeriodDays: 0, industries: ["Banking"] }, ["free"]),
  row("b", { currentTitle: "Sr. Accountant", location: "Colombo", totalExperienceYears: 4, noticePeriodDays: 30, industries: ["Banking", "Audit"] }, ["in_pipeline"]),
  row("c", { currentTitle: "sr accountant", location: "Kandy", totalExperienceYears: 4, noticePeriodDays: 45, industries: ["Audit"] }),
  row("d", { currentTitle: "Finance Manager", location: "Colombo", totalExperienceYears: 12, noticePeriodDays: 90 }, ["placed"]),
  row("e", { currentTitle: "Accountant", location: null, totalExperienceYears: null }),
  row("f", { currentTitle: "Auditor", location: "Galle", totalExperienceYears: 30, noticePeriodDays: null }),
];
const ids = (p: ReturnType<typeof pickedFrom>) => rows.filter((r) => rowMatches(r, p)).map((r) => r.candidate.id);
const pick = (sp: Record<string, string | string[]>, levels: string[] = []) => pickedFrom(sp, new Set(levels));

console.log("\nnothing picked");
eq("everyone, nothing active", [ids(pick({})), anyActive(pick({}))], [["a", "b", "c", "d", "e", "f"], false]);
eq("a full-width slider is no filter", pick({ xmin: "0", xmax: "30" }).range, null);

console.log("\nthe range");
eq("inclusive at both ends", ids(pick({ xmin: "2", xmax: "4" })), ["a", "b", "c"]);
eq("one or two people is a valid answer", ids(pick({ xmin: "12", xmax: "12" })), ["d"]);
eq("30 is 30 and over", ids(pick({ xmin: "20", xmax: "30" })), ["f"]);
eq("unknown years are hidden once narrowed", ids(pick({ xmin: "0", xmax: "10" })), ["a", "b", "c"]);
eq("backwards ends are swapped", pick({ xmin: "9", xmax: "3" }).range, [3, 9]);
eq("a bad number is ignored", pick({ xmin: "abc" }).range, null);
eq("how many it hides for unknown years", hiddenForUnknownYears(rows, pick({ xmin: "0", xmax: "10" })), 1);
eq("clearing it returns everyone", ids(pick({})).length, 6);

console.log("\ntick lists");
eq("titles that differ by case and dots are one", titleKey("Sr. Accountant"), titleKey("sr accountant"));
eq("city is the part before the comma", cityOf("Colombo, Sri Lanka"), "Colombo");
eq("OR within a list", ids(pick({ jt: ["accountant", "auditor"] })), ["a", "e", "f"]);
eq("AND across lists", ids(pick({ jt: ["sr accountant"], loc: "colombo" })), ["b"]);
eq("AND with the range", ids(pick({ jt: "accountant", xmin: "0", xmax: "3" })), ["a"]);
eq("AND with Level", ids(pick({ loc: "colombo" }, ["nope"])), []);
eq("notice period bands", ids(pick({ np: ["0", "30"] })), ["a", "b"]);
eq("unstated notice is its own band", ids(pick({ np: "x" })), ["e", "f"]);
eq("availability from the signals", ids(pick({ av: ["free", "placed"] })), ["a", "d"]);
eq("a person can sit in several industries", ids(pick({ ind: "audit" })), ["b", "c"]);

console.log("\ncounts");
const title = FACETS.find((f) => f.param === "jt")!;
const all = facetOptions(title, rows, pick({}));
eq("by count, then name", all.map((o) => [o.label, o.count]), [["Accountant", 2], ["Sr. Accountant", 2], ["Auditor", 1], ["Finance Manager", 1]]);
const narrowed = facetOptions(title, rows, pick({ loc: "colombo" }));
eq("counts follow the other filters", narrowed.map((o) => [o.label, o.count]), [["Accountant", 1], ["Finance Manager", 1], ["Sr. Accountant", 1]]);
const own = facetOptions(title, rows, pick({ jt: "auditor" }));
eq("a list's own ticks do not shrink its counts", own.find((o) => o.label === "Accountant")?.count, 2);
const stays = facetOptions(title, rows, pick({ jt: "auditor", loc: "colombo" }));
eq("a ticked option stays listed at 0", stays.find((o) => o.key === "auditor"), { key: "auditor", label: "Auditor", count: 0, on: true });
const notice = FACETS.find((f) => f.param === "np")!;
eq("fixed options keep their order and drop the empty", facetOptions(notice, rows, pick({})).map((o) => o.key), ["0", "30", "60", "90", "x"]);

console.log("\nthe address");
eq("the filters are the filter params", FACETS.map((f) => f.param).sort(), FILTER_PARAMS.filter((p) => !["lvl", "xmin", "xmax"].includes(p)).sort());
eq("a filter keeps the same search", resultsKeyOf({ q: "java", xmin: "3", xmax: "5", jt: "x", loc: "y", np: "0", av: "free", ind: "z", lvl: "2" }), resultsKeyOf({ q: "java" }));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
