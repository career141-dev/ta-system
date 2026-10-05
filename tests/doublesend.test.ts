// 2 Oct — a follow-up pressed twice on one candidate (two TAs, or a double click)
// must not send a second "reminder" straight behind the first (scenario C1).
import { DOUBLE_PRESS_MS, justSent } from "../convex/lib/followUpScope";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const now = 1_000_000_000;
const sent = (channels: string[], agoMs: number, attempts = 1) => ({ attempts, lastManualSendAt: now - agoMs, lastManualChannels: channels });

eq("nothing sent yet: allowed", justSent({ attempts: 0, channel: "both", now }), false);
eq("both just sent, both pressed again: blocked", justSent({ ...sent(["whatsapp", "email"], 5_000), channel: "both", now }), true);
eq("both just sent, WhatsApp pressed again: blocked", justSent({ ...sent(["whatsapp", "email"], 5_000), channel: "whatsapp", now }), true);
eq("WhatsApp just sent, WhatsApp again: blocked", justSent({ ...sent(["whatsapp"], 5_000), channel: "whatsapp", now }), true);
eq("WhatsApp just sent, email next: allowed (same round)", justSent({ ...sent(["whatsapp"], 5_000), channel: "email", now }), false);
eq("WhatsApp just sent, both pressed: allowed (email still to go)", justSent({ ...sent(["whatsapp"], 5_000), channel: "both", now }), false);
eq("after the window the next round is allowed", justSent({ ...sent(["whatsapp", "email"], DOUBLE_PRESS_MS + 1), channel: "both", now }), false);
eq("just inside the window is still blocked", justSent({ ...sent(["whatsapp", "email"], DOUBLE_PRESS_MS), channel: "both", now }), true);
eq("no send time recorded: allowed", justSent({ attempts: 1, channel: "both", now }), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
