import { matchReplyRound, parseShortlistReply, reviewToken } from "../convex/lib/shortlistReply";

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

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
