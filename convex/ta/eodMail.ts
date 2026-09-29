"use node";

// convex/ta/eodMail.ts
//
// Sending the end-of-day email through Microsoft Graph.
//
// The TA System builds the email (src/app/actions.ts `sendEod`): from the TA's
// own mailbox, to the job-orders box (plus anyone the TA adds), copying the
// desk's fixed Cc list (lib/eod-format EOD_CC_DEFAULTS), anyone the TA adds, and
// the shortlist inbox that watches for the reply, with the day's two tables and the prepared
// CVs attached. This only carries it, through the one Graph sender every email
// uses (lib/graphMail.ts), so the test-mode and outbound-lock gates apply here
// too. The Graph credentials live on the backend, which is why this is here and
// not in the Next server.

import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { getGraphToken } from "../lib/graphClient";
import { sendFollowUpMail, type MailResult } from "../lib/graphMail";

export const send = internalAction({
  args: {
    from: v.string(),
    to: v.string(),
    alsoTo: v.optional(v.array(v.string())),
    cc: v.array(v.string()),
    replyTo: v.array(v.string()),
    subject: v.string(),
    html: v.string(),
    attachments: v.array(v.object({ name: v.string(), contentType: v.string(), base64: v.string() })),
  },
  handler: async (_ctx, args): Promise<MailResult> => {
    const systemInbox = process.env.MS_SENDER_EMAIL || process.env.OUTBOUND_EMAIL_SENDER || "job@career141.com";
    const result = await sendFollowUpMail(
      {
        from: args.from,
        fallbackFrom: systemInbox,
        to: args.to,
        alsoTo: args.alsoTo,
        cc: args.cc,
        replyTo: args.replyTo,
        subject: args.subject,
        html: args.html,
        attachments: args.attachments,
        testInbox: "EOD_TEST_EMAIL",
      },
      getGraphToken,
    );
    console.log(
      result.ok
        ? `[End of day] Sent via Microsoft Graph from ${result.from} to ${[result.to, ...(result.alsoTo ?? [])].join(", ")}, cc ${result.cc.join(", ") || "nobody"}${result.note}`
        : `[End of day] Not sent: ${result.error}`,
    );
    return result;
  },
});
