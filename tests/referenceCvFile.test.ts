import assert from "node:assert/strict";
import { MAX_REFERENCE_CV_BYTES, referenceCvFileProblem } from "../src/lib/referenceCvFile";

for (const name of ["candidate.pdf", "candidate.docx", "candidate.txt", "CANDIDATE.PDF"]) {
  assert.equal(referenceCvFileProblem(name, 1_024), null, `${name} is supported`);
}
assert.match(referenceCvFileProblem("candidate.doc", 1_024) ?? "", /cannot be read reliably/i);
assert.match(referenceCvFileProblem("candidate.png", 1_024) ?? "", /PDF, DOCX or TXT/i);
assert.match(referenceCvFileProblem("candidate.pdf", MAX_REFERENCE_CV_BYTES + 1) ?? "", /over 10 MB/i);
assert.match(referenceCvFileProblem("candidate.pdf", 0) ?? "", /select/i);

console.log("Reference CV file validation tests passed.");
