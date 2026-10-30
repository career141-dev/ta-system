/**
 * The WhatsApp assistant answers like a person (30 Oct): one reply to a burst,
 * duplicates dropped by Meta's id, no answering its own echo, a daily ceiling,
 * and no reminders at night. The rules themselves are tested in
 * followupwindow.test.ts; this checks they are the ones wired in.
 */
import fs from "node:fs";
import path from "node:path";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");

const webhook = read("convex/communications/whatchimp.ts");
eq("the webhook passes Meta's message id", /checkAndRecordFollowUpReply, \{[^}]*messageId: typeof message\.id === "string"/.test(webhook), true);

const outbound = read("convex/communications/whatsappOutbound.ts");
const record = outbound.slice(outbound.indexOf("export const checkAndRecordFollowUpReply"), outbound.indexOf("export const recordLocalWhatsappOutbound"));
eq("a message id seen before is dropped", record.includes('withIndex("by_externalMessageId"'), true);
eq("the inbound row keeps the id", record.includes("externalMessageId: args.messageId"), true);
eq("our own message coming back is not answered", record.includes("isEchoOfOurs(args.textBody, recentOutbound"), true);
eq("a reply waits for the pause", record.includes("runAfter(REPLY_PAUSE_MS, internal.communications.inboundExtraction.answerWhatsAppTurn"), true);
eq("no reply is started at once any more", record.includes("runAfter(0, internal.communications.inboundExtraction.extractDetailsFromText"), false);

const local = outbound.slice(outbound.indexOf("export const recordLocalWhatsappOutbound"));
eq("assistant replies stop at the daily ceiling and flag a TA",
  local.includes("today.length >= MAX_BOT_REPLIES_PER_DAY") && local.includes("flaggedForTaReview: true"), true);

const extraction = read("convex/communications/inboundExtraction.ts");
eq("a turn answers the whole burst", extraction.includes("burstToAnswer(recent as any, args.inboundAt)"), true);

const crons = read("convex/crons.ts");
eq("reminders wait for sending hours", crons.includes("if (!inSendingHours(now)) continue;"), true);

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
