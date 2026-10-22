import { applyCandidateDraft, candidateDraftBases, candidateDraftsFromFields, decodeEodBrowserDraft, editCandidateDraft, encodeEodBrowserDraft, type EodBrowserDraft } from "../src/lib/eodDraft";
import type { ShortlistRow } from "../src/lib/eod-format";

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

// Profile updates against EOD box edits (PR #238, 22 Oct).
const record = (over: Partial<ShortlistRow> = {}): ShortlistRow => ({
  no: 1, name: "Shamika", age: "31", notice: "3 months", notes: [">Available for interviews", ">Notice 3 months"],
  currentCompany: "Career141", currentDesignation: "TA Executive", currentRemuneration: "LKR 200,000",
  expectedRemuneration: "LKR 250,000", applicationId: "app1", ...over,
});
const was = record();
const edited = editCandidateDraft(undefined, was, "notice", "2 months");
eq("an edit stands while the record is unchanged", applyCandidateDraft(was, edited).notice, "2 months");
eq("a profile updated after the edit wins", applyCandidateDraft(record({ notice: "1 month" }), edited).notice, "1 month");
const now = record({ notice: "1 month" });
eq("an edit typed after the profile update is kept, not dropped as it is typed",
  applyCandidateDraft(now, editCandidateDraft(edited, now, "notice", "6 weeks")).notice, "6 weeks");
eq("other fields' edits are untouched by one field's update",
  applyCandidateDraft(record({ notice: "1 month" }), editCandidateDraft(edited, was, "age", "32")).age, "32");

// A TA took a note line out on purpose; the draft predates bases.
const legacy = { notes: [">Available for interviews"] };
eq("an edit saved without a base keeps the TA's notes", applyCandidateDraft(was, legacy).notes, [">Available for interviews"]);
eq("the deleted note line does not come back", applyCandidateDraft(was, legacy).notes.includes(">Notice 3 months"), false);

// The server-saved midday/EOD draft: every box field is a form field.
const form: Record<string, string> = {
  shortlist_app1_notice: "2 months",
  shortlist_app1_notes: ">Available for interviews",
  shortlist_app1_age: "31",
};
const saved = { ...form, ...candidateDraftBases([was], form) };
eq("bases are saved only for the box's fields", Object.keys(candidateDraftBases([was], form)).sort(),
  ["base_shortlist_app1_age", "base_shortlist_app1_notes", "base_shortlist_app1_notice"]);
eq("notes are saved as the form sends them", saved.base_shortlist_app1_notes, ">Available for interviews\n>Notice 3 months");
const reloaded = candidateDraftsFromFields([was], saved).app1;
eq("after a reload the TA's edits stand", applyCandidateDraft(was, reloaded).notice, "2 months");
eq("after a reload the deleted note line stays deleted", applyCandidateDraft(was, reloaded).notes, [">Available for interviews"]);
const updated = record({ notice: "1 month", notes: [">Available for interviews", ">Notice 1 month"] });
eq("after a reload a profile update replaces the stale notice", applyCandidateDraft(updated, reloaded).notice, "1 month");
eq("after a reload a profile update replaces the stale notes", applyCandidateDraft(updated, reloaded).notes, updated.notes);
eq("after a reload an unchanged field keeps its edit", applyCandidateDraft(updated, reloaded).age, "31");
eq("a draft saved before bases keeps every edit", applyCandidateDraft(updated, candidateDraftsFromFields([was], form).app1).notice, "2 months");
eq("the browser draft keeps bases across navigation",
  applyCandidateDraft(updated, decodeEodBrowserDraft(encodeEodBrowserDraft({ ...draft, shortlistDraft: { app1: edited } }))?.shortlistDraft?.app1).notice, "1 month");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
