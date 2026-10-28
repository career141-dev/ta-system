// A cut-off JSON answer from DeepSeek counts as a failed try, so the CV is
// asked again instead of failing on "not readable JSON" (28 Oct).
import { isCompleteJson } from "../convex/lib/jsonAnswer";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
eq("a whole object is complete", isCompleteJson('{"fullName":"Kasun Perera","skills":[]}'), true);
eq("a fenced object is complete", isCompleteJson('```json\n{"fullName":"Kasun"}\n```'), true);
eq("an answer cut off mid-history is not", isCompleteJson('{"fullName":"Kasun Perera","jobHistory":[{"company":"Dialog","title":"Eng'), false);
eq("a cut-off answer with an inner } is not", isCompleteJson('{"fullName":"Kasun","education":[{"degree":"BSc"}],"jobHistory":[{"company":"Dia'), false);
eq("no object at all is not", isCompleteJson("I cannot read this"), false);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
