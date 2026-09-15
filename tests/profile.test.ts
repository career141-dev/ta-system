import { fileSize, mapProfile, previewsInline } from "@/lib/candidateProfile";

let passed = 0;
let failed = 0;
const ok = (name: string, cond: boolean) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}`); }
};

const cv = { fileName: "VISHWA FERNANDO.pdf", fileType: "application/pdf", fileSize: 69226, status: "processed", storage: "r2" as const };
const raw = {
  candidate: {
    summary: "  Commercial sales leader.  ",
    seniorityLevel: "Lead/Principal",
    sourceChannel: "linkedin",
    languages: ["English", "Sinhala", "English", ""],
    certifications: ["CIM"],
    jobHistory: [
      { title: "Direct Sales Manager", company: "Luxury Brands", startDate: "Jan 2022", endDate: "Present", description: "Leads direct sales." },
      { title: "Manager", company: "KonnektBPO", startDate: "2019", endDate: "2021" },
      { company: "" },
    ],
    education: [{ degree: "BBA", institution: "ICBM", year: 2012 }],
    educationDegree: "G.C.E. Advanced Level",
    doNotContact: true,
    doNotContactReason: "Asked not to be called",
  },
  referees: [{ name: "A. Perera", designation: "GM", company: "X", contactNo: "077", email: null, relationship: "Manager" }],
  matches: [
    { applicationId: "a1", jobId: "j1", jobTitle: "Sales", clientName: "C", score: null, explanation: null },
    { applicationId: "a2", jobId: "j2", jobTitle: "Brand", clientName: "C", score: 82, explanation: "Strong fit" },
  ],
  cv,
  cvText: null,
  cvTextInR2: true,
};

const p = mapProfile(raw);
console.log("profile");
ok("summary trimmed", p.summary === "Commercial sales leader.");
ok("languages de-duplicated and blanks dropped", p.languages.join() === "English,Sinhala");
ok("career keeps real roles, drops empty ones", p.career.length === 2);
ok("present means current, with no end date", p.career[0].current && p.career[0].to === null);
ok("a past role keeps its end", p.career[1].to === "2021" && !p.career[1].current);
ok("description carried", p.career[0].description === "Leads direct sales.");
ok("education list plus the older flat degree", p.education.length === 2 && p.education[0].year === "2012");
ok("scored match first, unscored last", p.matches[0].score === 82 && p.matches[1].score === null);
ok("do-not-contact carried with its reason", p.doNotContact?.reason === "Asked not to be called");
ok("referees carried", p.referees[0].name === "A. Perera");
ok("pdf previews inline", previewsInline(p.cv));
ok("word does not", !previewsInline({ ...cv, fileName: "cv.docx", fileType: "application/msword" }));
ok("file size", fileSize(69226) === "68 KB" && fileSize(2_500_000) === "2.4 MB" && fileSize(null) === null);

const flatOnly = mapProfile({ ...raw, candidate: { educationDegree: "MBA", educationInstitution: "PIM" } });
ok("flat education alone still shows", flatOnly.education.length === 1 && flatOnly.education[0].institution === "PIM");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
