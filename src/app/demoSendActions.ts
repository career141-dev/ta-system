"use server";

import { primeStore } from "@/data/prime";
import { getCurrentUser } from "@/lib/session";
import { can } from "@/lib/auth";
import { convexAction } from "@/lib/convexServer";
import { isConvex } from "@/data/mode";
import { safeErrorMessage } from "@/lib/userError";
import type { ActionResult } from "@/lib/inlineResult";

/**
 * Settings → Follow-up demo: send one of the four automatic follow-up messages
 * (two WhatsApp templates, two emails) to a number or address the admin types.
 * About a made-up candidate; nothing is written to anyone's record
 * (convex/communications/demoSend.ts). Admins only, like the rest of Settings.
 */

const WHATSAPP = { initial: "initial_outreach", reminder: "reengagement" } as const;

const answer = (r: { ok: boolean; message: string }): ActionResult => ({
  ok: r.ok,
  message: r.message,
  // A send the gate redirected went, but not where it was asked to: say so in amber.
  tone: !r.ok ? "error" : /TEST MODE|WARNING:/.test(r.message) ? "warn" : "ok",
  at: Date.now(),
});

export async function sendFollowUpDemo(_: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await primeStore();
  const user = await getCurrentUser();
  const allowed = can(user, "user.manage");
  if (!allowed.ok) return answer({ ok: false, message: allowed.message });
  if (!isConvex()) return answer({ ok: false, message: "The demo needs the Convex backend; this build is running on the file store." });

  // "whatsapp:initial", "whatsapp:reminder", "email:initial", "email:reminder" — the button pressed.
  const [channel, kind] = String(formData.get("send") ?? "").split(":");
  if (kind !== "initial" && kind !== "reminder") return answer({ ok: false, message: "Choose which message to send." });
  const candidateName = String(formData.get("candidateName") ?? "").trim().slice(0, 80);
  const jobTitle = String(formData.get("jobTitle") ?? "").trim().slice(0, 120);

  try {
    if (channel === "whatsapp") {
      const to = String(formData.get("phone") ?? "").trim();
      if (to.replace(/\D/g, "").length < 9) return answer({ ok: false, message: "Type the WhatsApp number to send to." });
      return answer(
        await convexAction<{ ok: boolean; message: string }>("communications/demoSend:sendDemoWhatsApp", {
          to,
          template: WHATSAPP[kind],
          candidateName,
          jobTitle,
        }),
      );
    }
    if (channel === "email") {
      const to = String(formData.get("email") ?? "").trim();
      if (!to.includes("@")) return answer({ ok: false, message: "Type the email address to send to." });
      return answer(
        await convexAction<{ ok: boolean; message: string }>("communications/demoSend:sendDemoEmail", {
          to,
          kind,
          candidateName,
          jobTitle,
        }),
      );
    }
    return answer({ ok: false, message: "Choose which message to send." });
  } catch (e) {
    return answer({ ok: false, message: safeErrorMessage(e, "The message could not be sent. Try again.") });
  }
}
