/**
 * The proof picture on a strategy row (src/lib/strategyProof): what may be
 * attached, who may attach it, and who may open it. The rule under test: a file
 * is only ever stored as a PNG, JPEG or WebP that really is one, whatever the
 * browser says it is, and is served only to the TA who attached it or, once
 * submitted, to a lead.
 */
import { PROOF_MAX_BYTES, PROOF_MAX_PER_ROW, checkProofUpload, mayAttachProof, mayOpenProof, sniffImage } from "@/lib/strategyProof";
import type { StrategyAssignment, User } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(Math.max(0, 16 - b.length)).fill(0)]);
const text = (s: string) => new TextEncoder().encode(s.padEnd(16, " "));
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0);
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50);

console.log("\nWhat a file really is");
eq("a PNG", sniffImage(PNG), "image/png");
eq("a JPEG", sniffImage(JPEG), "image/jpeg");
eq("a WebP", sniffImage(WEBP), "image/webp");
eq("an SVG is not an image here", sniffImage(text("<svg xmlns='http://www.w3.org/2000/svg'>")), null);
eq("HTML is not", sniffImage(text("<!doctype html><script>")), null);
eq("a script is not", sniffImage(text("<script>alert(1)</script>")), null);
eq("a PDF is not", sniffImage(text("%PDF-1.7")), null);
eq("a GIF is not on the list", sniffImage(text("GIF89a")), null);
eq("a RIFF file that is not WebP (a WAV)", sniffImage(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45)), null);
eq("an empty file", sniffImage(new Uint8Array()), null);
eq("a PNG signature cut short", sniffImage(bytes(0x89, 0x50, 0x4e).subarray(0, 3)), null);

console.log("\nWhat may be attached");
eq("a real PNG within the limits", checkProofUpload({ size: 1000, head: PNG, existing: 0 }), { ok: true, contentType: "image/png" });
eq("the browser's idea of the type is not asked: a script named .png is refused", checkProofUpload({ size: 1000, head: text("<script>"), existing: 0 }).ok, false);
eq("a refused type says so", (checkProofUpload({ size: 1000, head: text("<svg"), existing: 0 }) as { message: string }).message, "Only PNG, JPEG or WebP pictures can be attached.");
eq("empty", checkProofUpload({ size: 0, head: PNG, existing: 0 }).ok, false);
eq("exactly the size limit is fine", checkProofUpload({ size: PROOF_MAX_BYTES, head: JPEG, existing: 0 }).ok, true);
eq("a byte over is refused with 413", (checkProofUpload({ size: PROOF_MAX_BYTES + 1, head: JPEG, existing: 0 }) as { status: number }).status, 413);
eq("the limit is 5 MB", PROOF_MAX_BYTES, 5 * 1024 * 1024);
eq("a row holds up to five", [checkProofUpload({ size: 10, head: PNG, existing: PROOF_MAX_PER_ROW - 1 }).ok, checkProofUpload({ size: 10, head: PNG, existing: PROOF_MAX_PER_ROW }).ok], [true, false]);

const row = (over: Partial<StrategyAssignment> = {}): StrategyAssignment => ({
  id: "sa_1", openingId: "op", strategyId: "st_1", strategyName: "LinkedIn Search", doneBy: ["u_nuha"], assignedAt: 1, assignedBy: "u_lead",
  byRole: "ta_lead", selected: null, notApplicable: false, doneAt: null, note: null, submittedAt: null, submittedBy: null,
  proofs: [
    { id: "pending", contentType: "image/png", size: 1, addedAt: 1, addedBy: "u_nuha", submittedAt: null },
    { id: "sent", contentType: "image/png", size: 1, addedAt: 1, addedBy: "u_nuha", submittedAt: 5 },
  ],
  ...over,
});
const person = (role: User["role"], id: string, isActive = true) => ({ id, role, isActive });

console.log("\nWho may attach");
eq("the TA on the row", mayAttachProof(person("ta", "u_nuha"), row()), true);
eq("another TA on the job, on a ticked row (9 Oct)", mayAttachProof(person("ta", "u_imalsha"), row()), true);
eq("not on an unticked row", mayAttachProof(person("ta", "u_nuha"), row({ selected: false })), false);
eq("not on an older row with nobody on it", mayAttachProof(person("ta", "u_nuha"), row({ doneBy: [] })), false);
eq("a lead does not attach for them", mayAttachProof(person("ta_lead", "u_lead"), row()), false);
eq("a client", mayAttachProof(person("client", "u_nuha"), row()), false);
eq("a deactivated TA", mayAttachProof(person("ta", "u_nuha", false), row()), false);
eq("not on a struck-through row", mayAttachProof(person("ta", "u_nuha"), row({ notApplicable: true })), false);

console.log("\nWho may open which picture");
eq("the TA opens their pending picture", mayOpenProof(person("ta", "u_nuha"), row(), "pending"), true);
eq("the TA opens a submitted one", mayOpenProof(person("ta", "u_nuha"), row(), "sent"), true);
eq("another TA opens neither", [mayOpenProof(person("ta", "u_imalsha"), row(), "pending"), mayOpenProof(person("ta", "u_imalsha"), row(), "sent")], [false, false]);
eq("a lead opens a submitted one", mayOpenProof(person("ta_lead", "u_lead"), row(), "sent"), true);
eq("a lead does not open a pending one", mayOpenProof(person("ta_lead", "u_lead"), row(), "pending"), false);
eq("a director opens a submitted one", mayOpenProof(person("director", "u_dir"), row(), "sent"), true);
eq("an admin opens a submitted one", mayOpenProof(person("admin", "u_admin"), row(), "sent"), true);
eq("a client opens nothing", mayOpenProof(person("client", "u_c"), row(), "sent"), false);
eq("a viewer opens nothing", mayOpenProof(person("viewer", "u_v"), row(), "sent"), false);
eq("a picture that is not on the row", mayOpenProof(person("ta_lead", "u_lead"), row(), "nope"), false);
eq("a deactivated lead opens nothing", mayOpenProof(person("ta_lead", "u_lead", false), row(), "sent"), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
