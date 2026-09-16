import { matchesQuery, pageFrom, pageLink, slicePage } from "../src/lib/paging";

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("pages");
ok("page 1 when none is asked for", pageFrom({}, 100, 25) === 1);
ok("the page asked for", pageFrom({ page: "3" }, 100, 25) === 3);
ok("past the end goes to the last page", pageFrom({ page: "9" }, 100, 25) === 4);
ok("nonsense goes to page 1", pageFrom({ page: "x" }, 100, 25) === 1 && pageFrom({ page: "-2" }, 100, 25) === 1);
ok("an empty list has one page", pageFrom({ page: "2" }, 0, 25) === 1);
ok("slice gives the rows of that page", slicePage([1, 2, 3, 4, 5], 2, 2).join() === "3,4");

console.log("\nlinks");
const link = pageLink("/clients", { q: "hospital", held: "x", msg: "Saved", page: "2" });
ok("keeps the search and filters, drops the notice", link(3) === "/clients?q=hospital&held=x&page=3", link(3));
ok("page 1 has no page parameter", link(1) === "/clients?q=hospital&held=x", link(1));
ok("a list with no parameters links cleanly", pageLink("/alerts", {})(2) === "/alerts?page=2");
ok("a second list on the page uses its own key", pageLink("/intake", { rpage: "2", q: "a" }, "dpage")(2) === "/intake?rpage=2&q=a&dpage=2");

console.log("\nsearch");
ok("empty search matches everything", matchesQuery("", "anything"));
ok("every word must appear, in any field", matchesQuery("lanka hosp", "Lanka Hospital", "Healthcare"));
ok("case is ignored", matchesQuery("DEKKO", "Dekko Isho"));
ok("a missing word does not match", !matchesQuery("lanka bank", "Lanka Hospital"));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
