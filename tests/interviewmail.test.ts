/**
 * Reading the mail at interviews@ (convex/lib/interviewMail.ts, 24 Oct).
 * Subjects are the real ones from the mailbox.
 */
import { readAnswer, readInterviewMail, roleOverlap, sameClient } from "../convex/lib/interviewMail";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const ta = "haifa@career141.com", cand = "someone@gmail.com";
const read = (subject: string, fromAddress: string, body = "") => readInterviewMail({ subject, fromAddress, body });

console.log("\nthe TA's invitation");
eq("client > role > candidate", read("Q COLLECTION (SL) > MERCHANDISER > VIKUM SHRINATH", ta),
  { kind: "invite", client: "Q COLLECTION (SL)", role: "MERCHANDISER", candidate: "VIKUM SHRINATH" });
eq("INTERVIEW(S) dropped from the client", read("DELMO INTERVIEWS > SENIOR MANAGER - IT OPERATIONS > CANDIDATE LAHIRU", ta).client, "DELMO");
eq("CANDIDATE dropped from the name", read("DELMO INTERVIEWS > SENIOR MANAGER - IT OPERATIONS > CANDIDATE LAHIRU", ta).candidate, "LAHIRU");
eq("MELWA INTERVIEW", read("MELWA INTERVIEW > HEAD OF HR > AKALANKA", ta).kind, "invite");

console.log("\nnot a client's invitation");
eq("Career141's own hiring", read("CAREER141 INTERVIEW > HR > OSHALI ALWIS", ta).kind, "ignore");
eq("the day's schedule", read("INTERVIEW SCHEDULE > 23/10/2026", ta).kind, "ignore");
eq("a TA's follow-up", read("RE: MELWA INTERVIEW > HEAD OF HR > SAMEERA", ta).kind, "ignore");
eq("a free-form subject", read("INTERVIEW INVITATION - OFFICE ADMINISTRATOR AT BANARANAIKE ACADEMY", ta).kind, "ignore");

console.log("\ncancelled");
eq("Canceled:", read("Canceled: DAMAD INTERVIEW > EHS MANAGER > MAAZ ALI", ta).kind, "cancel");
eq("Canceled: Career141's own", read("Canceled: CAREER141 INTERVIEW > HR > ISURINI PERERA", ta).kind, "ignore");

console.log("\nthe candidate's answer");
eq("confirms", read("Re: MELWA INTERVIEW > HEAD OF HR > AKALANKA", cand, "Dear Zainab, Thank you for the invitation. I confirm my availability").answer, "confirmed");
eq("will attend", readAnswer("Dear Rakshana, I will be attending the interview. Regards"), "confirmed");
eq("declines", readAnswer("Thank you so much for the invitation. I would like to inform you that, after careful consideration, I have decided"), "declined");
eq("quoted invitation not read", readAnswer("Noted. On Fri, Oct 16, 2026 at 9:50 PM Rakshana wrote: please confirm your availability"), "replied");
eq("a reply is a reply", read("Re: DAMAD INTERVIEW > EHS MANAGER > MAAZ ALI", cand, "ok").kind, "reply");

console.log("\nthe opening");
eq("Q COLLECTION ~ Q COLLECTION (SL)", sameClient("Q COLLECTION", "Q COLLECTION (SL)"), true);
eq("DELMO ~ DELMO - HOLDING", sameClient("DELMO", "DELMO - HOLDING"), true);
eq("MELWA ≠ MELWIRE", sameClient("MELWA", "Melwire"), false);
eq("role words", roleOverlap("SENIOR MANAGER - IT OPERATIONS", "Senior Manager IT Operations"), 3);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
