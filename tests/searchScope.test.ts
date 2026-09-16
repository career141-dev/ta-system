import { searchScopeFor } from "../src/lib/searchScope";

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("the header search follows the page");
ok("clients keeps the desk-wide header search (its own box is on the page)", searchScopeFor("/clients").action === "/search");
ok("openings keeps its bucket", searchScopeFor("/openings").action === "/openings" && searchScopeFor("/openings").keep.includes("bucket"));
ok("a stage searches that stage", searchScopeFor("/openings/o1/pipeline/follow_up").action === "/openings/o1/pipeline/follow_up");
ok("the applicants keep the post", searchScopeFor("/openings/o1/linkedin-job").keep.includes("post"));
ok("the database searches the database", searchScopeFor("/database").action === "/database/results");
ok("a candidate searches their activity, on the same tab", searchScopeFor("/openings/o1/candidate/a1").keep.includes("tab"));
ok("a trailing slash is the same page", searchScopeFor("/people/").action === "/people");
ok("the dashboard searches its own lists", searchScopeFor("/").action === "/");
ok("a page with no list uses the desk-wide search", searchScopeFor("/reports").action === "/search");
ok("an opening's overview uses the desk-wide search", searchScopeFor("/openings/o1").action === "/search");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
