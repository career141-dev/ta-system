// convex/communications/contactGuard.ts
//
// The do-not-contact lookup every candidate send asks before it goes (2 Oct).
//
// outreachSafety.ts and outboundGuard.ts decide WHERE a message may go from the
// environment alone, with no database. Whether this person asked us to stop is
// in the database, so it lives here: one query, given whatever the sender
// knows about the recipient — the candidate id, the email it is writing to,
// the phone it is messaging. The rule itself is `doNotContactRefusal` in
// outreachSafety.ts.
//
// Senders call it through `refuseIfDoNotContact` (lib/doNotContact.ts) — from
// the senders themselves (sendGraphEmail, sendFollowUpEmail, replyToMessage,
// sendMetaFreeText, sendMetaTemplate), not from the paths that schedule them,
// so a new path into a sender cannot route around it.

import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import { doNotContactRefusal } from "../lib/outreachSafety";
import { candidatesWithPhone } from "./whatsappOutbound";

export const contactRefusal = internalQuery({
  args: {
    candidateId: v.optional(v.id("candidates")),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<string | null> => {
    const records: any[] = [];
    if (args.candidateId) records.push(await ctx.db.get(args.candidateId));
    const email = (args.email ?? "").trim();
    if (email) {
      // Emails are stored as typed; the address we write to may differ in case.
      for (const e of new Set([email, email.toLowerCase()])) {
        records.push(...(await ctx.db.query("candidates").withIndex("by_email", (q) => q.eq("email", e)).take(20)));
      }
    }
    if (args.phone) records.push(...(await candidatesWithPhone(ctx, args.phone)));
    return doNotContactRefusal(records);
  },
});
