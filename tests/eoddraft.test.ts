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

// Leaving and returning to Director Review starts a new email draft for this CV.
const firstReview = record({ reviewStageChangedAt: 100 });
const firstEdit = editCandidateDraft(undefined, firstReview, "notes", [">Available for interviews"]);
eq("deleted lines stay deleted during the same review visit", applyCandidateDraft(firstReview, firstEdit).notes, [">Available for interviews"]);
const nextReview = record({ reviewStageChangedAt: 200, notes: [">New follow-up details", ">New availability"] });
const browserEdit = decodeEodBrowserDraft(encodeEodBrowserDraft({ ...draft, shortlistDraft: { app1: firstEdit } }))?.shortlistDraft?.app1;
eq("returning to review discards the earlier browser notes", applyCandidateDraft(nextReview, browserEdit).notes, nextReview.notes);
eq("returning to review resets edits even if the source notes are identical", applyCandidateDraft({ ...firstReview, reviewStageChangedAt: 200 }, firstEdit).notes, firstReview.notes);
const reviewSaved = { ...form, ...candidateDraftBases([firstReview], form) };
eq("server drafts preserve deletions in the same review visit", applyCandidateDraft(firstReview, candidateDraftsFromFields([firstReview], reviewSaved).app1).notes, [">Available for interviews"]);
eq("server drafts expire when the candidate returns to review", applyCandidateDraft(nextReview, candidateDraftsFromFields([nextReview], reviewSaved).app1).notes, nextReview.notes);
// Drafts saved before visits were recorded are kept (22 Oct): releasing
// #243 during the day must not throw away TAs' unsent EOD box edits.
eq("a draft saved before visits were recorded keeps the TA's notes", applyCandidateDraft(nextReview, legacy).notes, legacy.notes);
eq("an older server draft keeps its edits after the release", applyCandidateDraft(firstReview, candidateDraftsFromFields([firstReview], form).app1).notes, [">Available for interviews"]);
const adopted = editCandidateDraft(legacy, firstReview, "age", "33");
eq("editing an older draft keeps its notes", applyCandidateDraft(firstReview, adopted).notes, legacy.notes);
eq("and stamps it with this visit", adopted._reviewStageChangedAt, 100);
eq("so a later return to review starts fresh", applyCandidateDraft(nextReview, adopted).notes, nextReview.notes);
const nextEdit = editCandidateDraft(firstEdit, nextReview, "age", "32");
eq("editing another field does not revive earlier notes", applyCandidateDraft(nextReview, nextEdit).notes, nextReview.notes);
eq("new review edits are preserved", applyCandidateDraft(nextReview, nextEdit).age, "32");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
