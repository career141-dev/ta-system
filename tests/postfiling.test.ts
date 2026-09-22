/**
 * Post routing on the shared mailboxes (convex/pipeline/postFiling.ts, 22 Sep):
 * every opening's first post, and the rules as the live poller uses them.
 * Pure — no Graph, no database.
 */
import { firstPostFor } from "../convex/lib/firstPost";
import { routeShared, type RoutablePost } from "../convex/lib/postRouting";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const job = (extra: Record<string, unknown> = {}) =>
  ({ _id: "op_1", title: "Head of Finance", keyword: "HOF-7K", location: "Colombo, Sri Lanka", primaryRecruiterId: "u_shamra", status: "active", ...extra }) as never;

console.log("\nan opening's first post");
{
  const p = firstPostFor(job(), 1);
  eq("carries the opening's title", p.title, "Head of Finance");
  eq("keeps the old keyword as an alias", p.aliasKeywords, ["HOF-7K"]);
  eq("belongs to the primary recruiter", p.assignedTaId, "u_shamra");
  eq("city and country from the location", [p.city, p.country], ["Colombo", "Sri Lanka"]);
  eq("live on an active opening", p.status, "live");
  eq("a LinkedIn advert", p.channel, "linkedin");
}
{
  const p = firstPostFor(job({ keyword: undefined, location: "", status: "draft", primaryRecruiterId: undefined }), 1);
  eq("no keyword: no alias", p.aliasKeywords, []);
  eq("no location: no place", [p.city, p.country], [null, null]);
  eq("a draft opening's post is a draft", p.status, "draft");
  eq("no recruiter yet: unassigned", p.assignedTaId, null);
}

const post = (id: string, openingId: string, title: string, extra: Partial<RoutablePost> = {}): RoutablePost => ({
  id, openingId, title, previousTitles: [], aliasKeywords: [], city: null, country: "Sri Lanka",
  channel: "linkedin", campaignCode: "", externalUrl: null, postedAt: 0, status: "live", ...extra,
});

console.log("\nthe live poller's routing");
const posts = [
  post("p1", "op_apex", "Head of Finance", { status: "draft" }),
  post("p2", "op_sq", "Head of Finance", { postedAt: 5 }),
  post("p3", "op_mkt", "Head of Marketing", { previousTitles: ["GM Marketing"], aliasKeywords: ["Assistant Manager Digital Marketing"] }),
];
{
  const r = routeShared({ subject: "New application: Head of Finance from Nimal Perera", linkedinOnly: true }, posts);
  eq("a draft post still takes applicants", [r?.openingId, r?.alsoTo.map((a) => a.openingId)].flat().sort(), ["op_apex", "op_sq"]);
}
{
  const r = routeShared({ subject: "New application: GM Marketing from A B", linkedinOnly: true }, posts);
  eq("the title before the TA renamed the advert", r?.openingId, "op_mkt");
  const k = routeShared({ subject: "New application: Assistant Manager Digital Marketing from A B", linkedinOnly: true }, posts);
  eq("an alias the TA added", [k?.openingId, k?.confidence], ["op_mkt", "keyword"]);
}
{
  const r = routeShared({ subject: "New application: Finance Executive from A B", linkedinOnly: true }, posts);
  eq("a near title is not a match — nothing is guessed", r, null);
  const r2 = routeShared({ subject: "CV for any suitable vacancy", linkedinOnly: false }, posts);
  eq("no title at all goes to the database", r2, null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
