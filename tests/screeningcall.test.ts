import {
  callBrief,
  candidateSpoke,
  detailsToCollect,
  extractionPrompt,
  normaliseCallAnswers,
  parseJsonObject,
  screeningQuestions,
  standardAnswers,
  standardFieldOf,
  transcriptText,
} from "../convex/lib/screeningCall";
import { firstName, openingInstruction, readBrief, systemPrompt } from "../voice-agent/src/prompt";
import { ROUND_WINDOW_MS, sameRoundAs } from "../convex/lib/followUpScope";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const has = (l: string, text: string, part: string) => eq(l, text.includes(part), true);

// ── The opening's questions, wherever they were set ─────────────────────────
eq(
  "questions from all three places, once each, TA System's first",
  screeningQuestions({
    followUpQuestions: [{ id: "q1", label: "Valid driving licence?" }],
    customFollowUpQuestions: ["valid driving licence?", "Willing to travel?"],
    agent5CustomQuestions: ["  ", "Portfolio link?"],
  }),
  ["Valid driving licence?", "Willing to travel?", "Portfolio link?"],
);
eq("no questions set", screeningQuestions({}), []);
eq(
  "job questions that repeat salary or notice are not asked twice",
  screeningQuestions({ customFollowUpQuestions: ["Current notice period", "Current monthly salary", "Expected salary", "Portfolio link?"] }),
  ["Portfolio link?"],
);
eq(
  "and are answered from the call's figures",
  standardAnswers(["Current notice period", "Current monthly salary", "Expected salary", "Portfolio link?"], {
    currentSalary: 450000, currentSalaryCurrency: "LKR", expectedSalary: 600000, expectedSalaryCurrency: null, noticePeriodDays: 30,
  }),
  { "Current notice period": "30 days", "Current monthly salary": "LKR 450,000", "Expected salary": "600,000" },
);
eq("a real question is not mistaken for a standard one", standardFieldOf("Do you have a valid driving licence?"), null);

const details = detailsToCollect("Head of Finance", ["Valid driving licence?"]);
eq("checklist: role, the three details, then the opening's questions", details.length, 5);
has("checklist confirms the role", details[0], "Head of Finance");
has("checklist asks current salary", details[1], "current monthly salary");
has("checklist asks expected salary", details[2], "expected monthly salary");
has("checklist asks notice period", details[3], "notice period");
eq("checklist ends with the opening's question", details[4], "Valid driving licence?");

// ── The brief ───────────────────────────────────────────────────────────────
has("brief names the client", callBrief({ title: "CFO", clientName: "Hayleys", jobDescription: "Lead finance." }), "Hiring company: Hayleys");
const secret = callBrief({ title: "CFO", clientName: "Hayleys", clientIndustry: "Conglomerate", isConfidential: true });
eq("confidential brief never names the client", secret.includes("Hayleys"), false);
has("confidential brief says so", secret, "confidential client in Conglomerate");

// ── Aura's prompt, from the room metadata the backend writes ────────────────
const brief = readBrief(
  JSON.stringify({
    candidateName: "Nimal Perera",
    companyName: "Career141",
    jobTitle: "Head of Finance",
    jobDescription: callBrief({ title: "Head of Finance", clientName: "Hayleys", jobDescription: "Lead finance." }),
    detailsToCollect: details,
  }),
);
eq("first name only", firstName(brief.candidateName), "Nimal");
eq("a name in capitals is said normally", firstName("RANJITHA SILVA"), "Ranjitha");
has("opening says hi by name", openingInstruction(brief), "say hi to Nimal");
has("opening says Aura from Career141", openingInstruction(brief), "Aura calling from Career141");
has("opening names the role", openingInstruction(brief), "Head of Finance role");
const prompt = systemPrompt(brief);
for (const d of details) has(`prompt carries: ${d.slice(0, 40)}`, prompt, d);
has("prompt carries the job brief", prompt, "Lead finance.");
has("prompt asks for all items before closing", prompt, "Only when every item has been asked");
eq("bad metadata falls back safely", readBrief("{not json").companyName, "Career141");
eq("no checklist falls back to the standard four", readBrief("{}").detailsToCollect.length, 4);

// ── The transcript ──────────────────────────────────────────────────────────
const lines = [
  { who: "agent" as const, text: "Hi Nimal, this is Aura calling from Career141 about the Head of Finance role." },
  { who: "candidate" as const, text: "Yes, go ahead." },
];
eq("candidate spoke", candidateSpoke(lines), true);
eq("only Aura spoke: no answer", candidateSpoke([lines[0], { who: "candidate", text: " . " }]), false);
eq("transcript text", transcriptText(lines).split("\n")[1], "Candidate: Yes, go ahead.");
has("extraction prompt lists the opening's questions", extractionPrompt(["Valid driving licence?"], "x"), '"Valid driving licence?"');

// ── What a model returns, made safe ─────────────────────────────────────────
const raw = parseJsonObject(
  'Here you go:\n```json\n{"interested": true, "currentSalary": "450,000", "currentSalaryCurrency": "lkr", "expectedSalary": 600000, "expectedSalaryCurrency": "LKR", "noticePeriodDays": 30, "answers": {"valid driving licence?": "Yes, light vehicles", "Something not asked": "x", "Willing to travel?": "null"}}\n```',
);
const a = normaliseCallAnswers(raw, ["Valid driving licence?", "Willing to travel?"]);
eq("current salary read from a string", a.currentSalary, 450000);
eq("currency upper-cased", a.currentSalaryCurrency, "LKR");
eq("expected salary", a.expectedSalary, 600000);
eq("notice period", a.noticePeriodDays, 30);
eq("interested", a.interested, true);
eq("answers only to questions asked, matched regardless of case, no 'null'", a.answers, { "Valid driving licence?": "Yes, light vehicles" });
const junk = normaliseCallAnswers({ currentSalary: -5, noticePeriodDays: 9000, currentSalaryCurrency: "rupees" }, []);
eq("out-of-range figures dropped", [junk.currentSalary, junk.noticePeriodDays, junk.currentSalaryCurrency], [null, null, null]);
eq("no JSON in a reply", parseJsonObject("sorry, I cannot"), null);

// ── WhatsApp and email pressed together are one follow-up ───────────────────
const now = 1_000_000_000;
eq("first send is never a same round", sameRoundAs({ attempts: 0, channel: "whatsapp", now }), false);
eq(
  "email two minutes after WhatsApp: same round",
  sameRoundAs({ attempts: 1, lastManualSendAt: now - 120_000, lastManualChannels: ["whatsapp"], channel: "email", now }),
  true,
);
eq(
  "WhatsApp again: next round",
  sameRoundAs({ attempts: 1, lastManualSendAt: now - 120_000, lastManualChannels: ["whatsapp"], channel: "whatsapp", now }),
  false,
);
eq(
  "email after the window: next round",
  sameRoundAs({ attempts: 1, lastManualSendAt: now - ROUND_WINDOW_MS - 1, lastManualChannels: ["whatsapp"], channel: "email", now }),
  false,
);
eq("both channels at once is its own round", sameRoundAs({ attempts: 1, lastManualSendAt: now, channel: "both", now }), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
