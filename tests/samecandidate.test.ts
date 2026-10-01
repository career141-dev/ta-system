/**
 * Which existing candidate an arriving CV is merged into (1 Oct): only on
 * proof. Any one shared field used to merge two people — an agency's phone on a
 * scoop CV put a stranger's CV on someone's record.
 */
import { findSameCandidate } from "../convex/lib/sameCandidate";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

// Just enough of ctx.db for the lookups: query(table).withIndex(name, q => q.eq(field, value)).take(n).
const rows: Record<string, unknown>[] = [
  { _id: "c_nimal", fullName: "Nimal Perera", email: "nimal@gmail.com", phoneClean: "0771234567", linkedinUrl: "https://www.linkedin.com/in/nimal-p" },
  { _id: "c_agency1", fullName: "Kasun Silva", phoneClean: "0112345678" },
  { _id: "c_agency2", fullName: "Amal Fernando", phoneClean: "94112345678" },
  { _id: "c_hash", fullName: "Ruwan Jayasinghe", fileHash: "abc" },
];
const ctx = {
  db: {
    query: () => ({
      withIndex: (_index: string, fn: (q: { eq: (f: string, v: string) => unknown }) => unknown) => {
        let field = "", value = "";
        fn({ eq: (f, v) => ((field = f), (value = v)) });
        return { take: async (n: number) => rows.filter((r) => r[field] === value).slice(0, n) };
      },
    }),
  },
};
const find = async (incoming: Record<string, string | undefined>) => (await findSameCandidate(ctx, incoming))?._id ?? null;

console.log("\nproof: merged");
eq("the same CV file", await find({ fileHash: "abc", fullName: "Someone Else" }), "c_hash");
eq("the same LinkedIn profile, written differently", await find({ linkedinUrl: "lk.linkedin.com/in/nimal-p/" }), "c_nimal");
eq("the same phone and the same name", await find({ fullName: "Mr. Nimal Perera", phone: "+94 77 123 4567" }), "c_nimal");
eq("the same email, in capitals, and initials that fit", await find({ fullName: "N. Perera", email: "Nimal@Gmail.com" }), "c_nimal");

console.log("\nno proof: a new person");
eq("the same phone, a different name", await find({ fullName: "Sunil Bandara", phone: "0771234567" }), null);
eq("the same email, no name on the CV", await find({ email: "nimal@gmail.com" }), null);
eq("a number two people hold (an agency's) is nobody's proof", await find({ fullName: "Kasun Silva", phone: "011 234 5678" }), null);
eq("a short or junk number is ignored", await find({ fullName: "Nimal Perera", phone: "94" }), null);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
