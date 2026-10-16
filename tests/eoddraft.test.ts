import { decodeEodBrowserDraft, encodeEodBrowserDraft, type EodBrowserDraft } from "../src/lib/eodDraft";

let pass = 0, fail = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${ok ? "" : ` got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const draft: EodBrowserDraft = {
  subject: "SET 1 - TEST",
  baseSubject: "SET 1 - TEST",
  introText: "Dear Sir",
  outroText: "Thank you",
  researchLink: "https://chatgpt.com/share/test",
  shortlistDraft: {
    app1: {
      name: "Shamika",
      age: "31",
      notice: "30 days",
      notes: [">Available for interviews"],
      currentCompany: "Career141",
      currentDesignation: "Talent Acquisition Executive",
      currentRemuneration: "LKR 200,000",
      expectedRemuneration: "LKR 250,000",
    },
  },
  extraTo: "director@example.com",
  extraCc: "lead@example.com",
  removed: "",
  skipAttachments: false,
};

const restored = decodeEodBrowserDraft(encodeEodBrowserDraft(draft));
eq("Age survives navigation", restored?.shortlistDraft?.app1?.age, "31");
eq("Current Company survives navigation", restored?.shortlistDraft?.app1?.currentCompany, "Career141");
eq("Current Designation survives navigation", restored?.shortlistDraft?.app1?.currentDesignation, "Talent Acquisition Executive");
eq("the remaining candidate edits survive too", restored?.shortlistDraft?.app1, draft.shortlistDraft.app1);
eq("all surrounding email fields survive", { ...restored, shortlistDraft: undefined }, { ...draft, shortlistDraft: undefined });
eq("a damaged browser draft is ignored", decodeEodBrowserDraft("{bad"), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
