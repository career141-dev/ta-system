// convex/lib/doNotContact.ts
//
// The one call every candidate sender makes before it sends (2 Oct): asks
// communications/contactGuard.ts whether any record matching the recipient is
// marked do-not-contact. No Convex function definitions here, so "use node"
// actions (graphEmail.ts) can import it as well as the plain ones.

import { internal } from "../_generated/api";

type Who = { candidateId?: any; email?: string | null; phone?: string | null };

/**
 * The refusal reason, logged, or null when the send may go. `channel` is only
 * for the log line, so a refused send can be found and counted.
 */
export async function refuseIfDoNotContact(
  ctx: { runQuery: (ref: any, args: any) => Promise<any> },
  channel: string,
  who: Who,
): Promise<string | null> {
  const reason: string | null = await ctx.runQuery(internal.communications.contactGuard.contactRefusal, {
    candidateId: who.candidateId ?? undefined,
    email: who.email || undefined,
    phone: who.phone || undefined,
  });
  if (reason) {
    console.warn(`[DoNotContact] Refused ${channel} to candidate ${who.candidateId ?? "(matched by address)"}: ${reason}`);
  }
  return reason;
}
