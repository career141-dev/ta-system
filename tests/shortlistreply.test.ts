import { matchReplyRound, parseShortlistReply, placement, reviewToken } from "../convex/lib/shortlistReply";

let pass = 0, fail = 0;
const ok = (label: string, condition: boolean) => {
  condition ? pass++ : fail++;
  console.log(`${condition ? "  ok  " : "  FAIL"} ${label}`);
};

const roster = [
  { applicationId: "a1", name: "Nimal Perera" },
  { applicationId: "a2", name: "Kasun Silva" },
  { applicationId: "a3", name: "Dilani Fernando" },
];

const all = parseShortlistReply("All shortlisted", roster);
ok("all shortlisted is a safe whole-roster decision", all.autoSafe && all.decisions.length === 3 && all.decisions.every((d) => d.outcome === "shortlisted"));

const both = parseShortlistReply("Both shortlisted", roster.slice(0, 2));
ok("both shortlisted selects exactly the two-person roster", both.autoSafe && both.decisions.length === 2);

const bareNumbers = parseShortlistReply("1, 3", roster);
ok("a bare candidate-number list is shortlisted", bareNumbers.autoSafe && bareNumbers.decisions.map((d) => d.applicationId).join(",") === "a1,a3");

const time = parseShortlistReply("Interview at 2 pm", roster);
ok("a time is not mistaken for candidate number 2", !time.autoSafe && time.decisions.length === 0);

const mixedTime = parseShortlistReply("Shortlist 1. Interview at 2 pm", roster);
ok("an incidental time does not add another candidate", !mixedTime.decisions.some((d) => d.applicationId === "a2"));

const names = parseShortlistReply("Nimal and Dilani are shortlisted", roster);
ok("unique names are matched", names.decisions.map((d) => d.applicationId).sort().join(",") === "a1,a3");
ok("unmentioned candidates are not rejected", !names.decisions.some((d) => d.applicationId === "a2"));

const others = parseShortlistReply("Kasun is not shortlisted. Others shortlisted.", roster);
ok("others shortlisted requires review", !others.autoSafe && others.reviewReasons.some((reason) => reason.includes("Others")));
ok("the explicit rejection remains a proposal", others.decisions.some((d) => d.applicationId === "a2" && d.outcome === "rejected"));

const optional = parseShortlistReply("Nimal optional shortlisted", roster);
ok("optional is held for review", !optional.autoSafe && optional.decisions.some((d) => d.applicationId === "a1" && d.outcome === "hold"));

const conflict = parseShortlistReply("Shortlist 1. Reject 1.", roster);
ok("conflicting decisions require review", !conflict.autoSafe && conflict.reviewReasons.some((reason) => reason.includes("Conflicting")));

const unknown = parseShortlistReply("Nimal and Ruwan are shortlisted", roster);
ok("an unknown name alongside a known name requires review", !unknown.autoSafe && unknown.reviewReasons.some((reason) => reason.includes("ruwan")));

const quoted = parseShortlistReply("Both shortlisted\n\n-----Original Message-----\nNone shortlisted", roster.slice(0, 2));
ok("quoted history is not parsed", quoted.decisions.every((d) => d.outcome === "shortlisted"));

// 22 Oct: replies the 19 Oct reader got wrong, each marked safe to apply on
// its own. Y = shortlisted, N = rejected, H = hold, - = not mentioned.
const verdicts = (reply: string) => {
  const read = parseShortlistReply(reply, roster);
  const by = new Map(read.decisions.map((d) => [d.applicationId, d.outcome]));
  return roster.map((row) => ({ shortlisted: "Y", rejected: "N", hold: "H" } as Record<string, string>)[by.get(row.applicationId) ?? ""] ?? "-").join("");
};
const reads = (reply: string, want: string, safe: boolean) => {
  const got = verdicts(reply);
  const autoSafe = parseShortlistReply(reply, roster).autoSafe;
  ok(`${JSON.stringify(reply)} reads ${want}${safe ? "" : ", for a person to check"} (got ${got}${autoSafe ? ", auto" : ""})`, got === want && autoSafe === safe);
};
reads("2 not selected", "-N-", true);
reads("Kasun is not selected", "-N-", true);
reads("Selected: 1, 3\nNot selected: 2", "YNY", true);
reads("Selected - Nimal\nNot Selected - Kasun", "YN-", true);
reads("Dear All\nKasun not selected", "-N-", true);
reads("Hi all,\n\nPlease proceed with 1 and 3.\n\nThanks", "Y-Y", true);
reads("Hi all, please proceed with 1 and 3", "Y-Y", true);
reads("Thanks all. Shortlist 1", "Y--", true);
reads("Hi, all shortlisted", "YYY", true);
reads("Proceed with 1, reject 2", "YN-", true);
reads("1 and 3 selected, 2 not suitable", "YNY", true);
reads("Proceed with Nimal and Dilani but not Kasun", "YNY", true);
reads("Do not proceed with 2", "-N-", true);
reads("Please don't shortlist Kasun", "-N-", true);
reads("Nimal - Yes\nKasun - No\nDilani - Yes", "YNY", true);
reads("Set 2: proceed with Nimal", "Y--", true);
reads("Do not reject 1", "---", false);
reads("Not approved", "---", false);
reads("Shortlist 5", "---", false);
reads("Shortlist all except Kasun", "YNY", false);

// What a decision does to somebody, given where they already are (22 Oct).
ok("Director Review + selected moves", placement("director", "second_shortlist", "shortlisted", false) === "move");
ok("Director Review + not selected moves to rejected", placement("director", "second_shortlist", "rejected", false) === "move");
ok("already in Director Shortlist + selected is recorded, not moved", placement("director", "director_shortlist", "shortlisted", false) === "already");
ok("already in Director Shortlist + not selected, read by the reader alone, is left for a person", placement("director", "director_shortlist", "rejected", false) === "left");
ok("already in Director Shortlist + not selected, confirmed by a person, is corrected", placement("director", "director_shortlist", "rejected", true) === "correct");
ok("past Director Shortlist is never moved back by a reply", placement("director", "interview", "rejected", true) === "left");
ok("a rejected candidate is not brought back by a reply", placement("director", "rejected", "shortlisted", true) === "left");
ok("a client's no for somebody already in Client Shortlist is corrected only when confirmed", placement("client", "client_review", "rejected", true) === "correct" && placement("client", "client_review", "rejected", false) === "left");
ok("a reply to the revised email matches the round", matchReplyRound({ subject: "RE: REVISED - SET 1 - ACME" }, [{ id: "r9", token: "C141-MAIL-x", subject: "SET 1 - ACME", status: "awaiting" }]).round?.id === "r9");

ok("tracking token is found inside the subject", reviewToken("Re: Job [C141-ABC234]") === "C141-ABC234");

const rounds = [
  { id: "r1", token: "C141-ABC234", subject: "SET 1 - ACME [C141-ABC234]", status: "awaiting" as const, conversationId: "conversation-one", internetMessageId: "<original@career141.com>" },
  { id: "r2", token: "C141-XYZ567", subject: "SET 2 - ACME [C141-XYZ567]", status: "awaiting" as const, conversationId: "conversation-two", internetMessageId: "<other@career141.com>" },
];
ok("conversation identity has first priority", matchReplyRound({ subject: "rewritten", conversationId: "conversation-two", inReplyTo: "<original@career141.com>" }, rounds).round?.id === "r2");
ok("In-Reply-To works when the subject is rewritten", matchReplyRound({ subject: "rewritten", inReplyTo: "original@career141.com" }, rounds).round?.id === "r1");
ok("token works when thread headers are absent", matchReplyRound({ subject: "Re: changed [C141-XYZ567]" }, rounds).round?.id === "r2");
ok("legacy exact subject is a fallback", matchReplyRound({ subject: "Re: SET 1 - ACME" }, [{ ...rounds[0], subject: "SET 1 - ACME" }]).method === "subject");
ok("legacy subject fallback requires an authorized sender", matchReplyRound({ subject: "Re: SET 1 - ACME" }, [{ ...rounds[0], subject: "SET 1 - ACME", senderAuthorized: false }]).method === "none");
ok("ambiguous token matches are not guessed", matchReplyRound({ subject: "Re: [C141-ABC234]" }, [rounds[0], { ...rounds[1], token: "C141-ABC234" }]).method === "none");

// A clause never takes its verdict from a later clause about other people
// (22 Oct): "1 and 3, not 2" rejected all three, marked safe to apply.
const read = (text: string) => {
  const r = parseShortlistReply(text, roster);
  return { yn: ["a1", "a2", "a3"].map((id) => ({ shortlisted: "Y", rejected: "N", hold: "H" } as Record<string, string>)[r.decisions.find((d) => d.applicationId === id)?.outcome ?? ""] ?? "-").join(""), auto: r.autoSafe };
};
for (const text of ["1 and 3, not 2", "1 & 3, 2 no", "1, 3, but not 2", "Proceed with 1 and 3, not 2", "1 - yes, 2 - no, 3 - yes"]) {
  ok(`"${text}" shortlists 1 and 3 and rejects 2`, read(text).yn === "YNY");
}
for (const text of ["Nimal and Dilani, not Kasun", "1 and 3 please, not 2"]) {
  const r = read(text);
  ok(`"${text}" never rejects the people it named first`, r.yn[0] !== "N" && r.yn[2] !== "N");
  ok(`"${text}" goes to a person`, !r.auto);
}
for (const text of ["Hi Kasun, please shortlist 1", "Thanks Kasun, shortlist 1 and 3"]) {
  const r = read(text);
  ok(`"${text}" does not shortlist Kasun from the greeting`, r.yn[1] !== "Y");
  ok(`"${text}" goes to a person`, !r.auto);
}
ok("a greeting to all still reads the picks", read("Hi all, proceed with 1 and 3").yn === "Y-Y");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
