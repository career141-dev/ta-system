// convex/communications/demoSend.ts
//
// Settings → Follow-up demo: send each automatic follow-up message once, to a
// number or address the admin types, so the desk can see exactly what a
// candidate receives (29 Oct, for the owner's demonstration).
//
// Nothing is written to any candidate or application: the messages are about a
// made-up candidate and role. They take the same road as the real ones —
// do-not-contact, the outreach gate, the outbound lock — so with OUTREACH_LIVE
// off a demo goes to the test number or mailbox, and the answer says so.
//
// WhatsApp goes from the main Career141 number (META_PHONE_NUMBER_ID, +94 74
// 219 7476), the account the two templates are approved on.

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { refuseIfDoNotContact } from "../lib/doNotContact";
import { phoneAllowed, suppressed } from "../lib/outboundGuard";
import { resolveRecipient } from "../lib/outreachSafety";
import { dailyTemplateCap, startOfUtcDay, withinTemplateBudget } from "../lib/templateBudget";
import { isEmail, sendFollowUpMail } from "../lib/graphMail";
import { STANDARD_ASKS, TEMPLATE_NAME, demoTemplateParams, templatePayload } from "../lib/whatsappTemplates";
import { buildStructuredEmailHtml, initialReachOutEmail } from "./emailHtml";
import { getGraphToken } from "./emailAgent";
import { DEFAULT_META_PHONE_ID } from "./metaTemplateSender";

type DemoResult = { ok: boolean; message: string };

const sample = (o: { candidateName?: string; jobTitle?: string }) => ({
  candidateName: o.candidateName?.trim() || "Kamal Perera",
  jobTitle: o.jobTitle?.trim() || "Accountant",
});

export const sendDemoWhatsApp = internalAction({
  args: {
    to: v.string(),
    template: v.union(v.literal("initial_outreach"), v.literal("reengagement")),
    candidateName: v.optional(v.string()),
    jobTitle: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<DemoResult> => {
    const token = process.env.META_ACCESS_TOKEN;
    if (!token) return { ok: false, message: "Not sent — META_ACCESS_TOKEN is not set on this deployment." };

    const refusal = await refuseIfDoNotContact(ctx, "demo WhatsApp", { phone: args.to });
    if (refusal) return { ok: false, message: `Not sent — ${refusal}` };
    const decision = resolveRecipient("whatsapp", args.to);
    if (!decision.ok) return { ok: false, message: `Not sent — ${decision.reason}` };
    if (!phoneAllowed(decision.to)) return { ok: false, message: suppressed("demo WhatsApp", decision.to) };

    const cap = dailyTemplateCap(process.env.C141_WHATSAPP_TEMPLATE_DAILY_CAP);
    if (cap !== null) {
      const sentToday = await ctx.runQuery(internal.communications.metaTemplateSender.countBillableTemplatesToday, {
        since: startOfUtcDay(Date.now()),
      });
      if (!withinTemplateBudget(sentToday, cap)) {
        return { ok: false, message: `Not sent — the daily WhatsApp template limit of ${cap} has been reached.` };
      }
    }

    const phoneId = process.env.META_PHONE_NUMBER_ID || DEFAULT_META_PHONE_ID;
    const params = demoTemplateParams(args.template, sample(args));
    let error = "";
    // `en` first, as the real sender does: both templates are approved in `en`.
    for (const lang of ["en", "en_US"]) {
      try {
        const res = await fetch(`https://graph.facebook.com/v19.0/${phoneId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(templatePayload(args.template, decision.to, params, lang)),
        });
        const text = await res.text();
        if (res.ok) {
          console.log(`[Demo] WhatsApp ${TEMPLATE_NAME[args.template]} sent to +${decision.to}${decision.note}`);
          try {
            await ctx.runMutation(internal.communications.metaTemplateSender.logDemoTemplateSent, {});
          } catch (e) {
            // Meta already accepted it. Never tell the admin to retry this send.
            console.error("[Demo] Could not record accepted template in the daily count", e);
            return { ok: true, message: `Sent “${TEMPLATE_NAME[args.template]}” to +${decision.to}.${decision.note} WARNING: daily-limit recording failed. Do not resend.` };
          }
          return { ok: true, message: `Sent “${TEMPLATE_NAME[args.template]}” to +${decision.to}.${decision.note}` };
        }
        error = `Meta answered ${res.status}: ${text.slice(0, 300)}`;
        if (!text.includes("132001")) break;
      } catch (e) {
        error = `Meta could not be reached: ${(e as Error).message}`;
        break;
      }
    }
    return { ok: false, message: `Not sent — ${error}` };
  },
});

export const sendDemoEmail = internalAction({
  args: {
    to: v.string(),
    kind: v.union(v.literal("initial"), v.literal("reminder")),
    candidateName: v.optional(v.string()),
    jobTitle: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<DemoResult> => {
    if (!isEmail(args.to)) return { ok: false, message: "Not sent — that is not an email address." };
    const refusal = await refuseIfDoNotContact(ctx, "demo email", { email: args.to });
    if (refusal) return { ok: false, message: `Not sent — ${refusal}` };

    const { candidateName, jobTitle } = sample(args);
    // The receiver is entered in Settings; the sender is deployment-owned.
    const from = process.env.OUTBOUND_EMAIL_SENDER || process.env.MS_SENDER_EMAIL;
    const mail =
      args.kind === "initial"
        ? initialReachOutEmail({
            candidateName,
            taEmail: from,
            jobTitle,
            clientIndustry: "apparel",
            country: "Sri Lanka",
            asks: STANDARD_ASKS,
          })
        : {
            subject: `Action Required: Missing info for your ${jobTitle} application`,
            text: "",
            html: buildStructuredEmailHtml({
              candidateName,
              jobTitle,
              prelude: `This is a friendly reminder that your application for ${jobTitle} is still missing a few details.`,
              remainingMissing: STANDARD_ASKS,
            }),
          };

    const result = await sendFollowUpMail(
      { from, to: args.to, subject: mail.subject, html: mail.html, text: mail.text, replyTo: [from ?? ""] },
      getGraphToken,
    );
    if (!result.ok) return { ok: false, message: `Not sent — ${result.error}` };
    console.log(`[Demo] Email "${mail.subject}" sent from ${result.from} to ${result.to}${result.note}`);
    return { ok: true, message: `Sent “${mail.subject}” from ${result.from} to ${result.to}.${result.note}` };
  },
});
