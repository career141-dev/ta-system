// A reader that never answers must not hold an action slot (6 Oct).
import { within } from "../convex/lib/within";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const never = new Promise<string>(() => {});
const t = Date.now();
eq("a reader that never answers gives the fallback", await within(never, 50, "raw", "test"), "raw");
eq("…after the limit, not before", Date.now() - t >= 45, true);
eq("an answer in time is passed through", await within(Promise.resolve("text"), 1000, "raw", "test"), "text");
let unhandled = false;
process.on("unhandledRejection", () => { unhandled = true; });
const lateFail = new Promise<string>((_, reject) => setTimeout(() => reject(new Error("Bad XRef entry")), 30));
eq("a late failure still gives the fallback", await within(lateFail, 10, "raw", "test"), "raw");
await new Promise((r) => setTimeout(r, 60));
eq("…and is not an unhandled rejection", unhandled, false);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
