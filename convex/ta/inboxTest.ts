"use node";
// convex/ta/inboxTest.ts
//
// Read-only look at a mailbox, for the ingestion end-to-end test.
//
// Lists recent messages that carry a CV attachment, with each file's SHA-256
// and whether this deployment already holds that exact file. Nothing is
// changed in the mailbox: GET requests only, no read flag, no move. The test
// then sends the chosen messages through the real ingestion action.
//
// Internal, and refused outright on a deployment without the outbound lock:
// it exists for test deployments reading the live inbox, not for production.

import { createHash } from "node:crypto";
import { v } from "convex/values";
import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { getGraphToken } from "../lib/graphClient";
import { outboundLocked } from "../lib/outboundGuard";
import { getQdrantClient, deleteCandidateVector, candidateIdToPointId, QDRANT_CANDIDATE_COLLECTION } from "../lib/qdrant";

export interface InboxCvMessage {
  messageId: string; subject: string; from: string; receivedAt: string; isRead: boolean; preview: string;
  cvs: { id: string; name: string; contentType: string; size: number; fileHash: string; known: boolean }[];
}

const CV_TYPES = /\.(pdf|docx?|rtf)$/i;

export const listCvMessages = internalAction({
  args: { inbox: v.string(), days: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<InboxCvMessage[]> => {
    if (!outboundLocked()) throw new Error("inboxTest runs only on a test deployment (C141_OUTBOUND_LOCK=true).");
    const token = await getGraphToken();
    if (!token) throw new Error("No Microsoft Graph token: check MS_GRAPH_TENANT_ID, MS_GRAPH_CLIENT_ID and MS_GRAPH_CLIENT_SECRET.");
    const headers = { Authorization: `Bearer ${token}` };
    const box = encodeURIComponent(args.inbox);
    const since = new Date(Date.now() - (args.days ?? 30) * 86_400_000).toISOString();
    const url =
      `https://graph.microsoft.com/v1.0/users/${box}/mailFolders/inbox/messages` +
      `?$filter=receivedDateTime ge ${since} and hasAttachments eq true` +
      `&$select=id,subject,from,receivedDateTime,isRead,bodyPreview,hasAttachments&$orderby=receivedDateTime desc&$top=${Math.min(args.limit ?? 15, 50)}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Graph refused the message list: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const messages = ((await res.json()).value ?? []) as Array<{
      id: string; subject?: string; from?: { emailAddress?: { address?: string } }; receivedDateTime: string; isRead: boolean; bodyPreview?: string;
    }>;

    const out: InboxCvMessage[] = [];
    for (const m of messages) {
      const ar = await fetch(`https://graph.microsoft.com/v1.0/users/${box}/messages/${m.id}/attachments`, { headers });
      if (!ar.ok) continue;
      const atts = ((await ar.json()).value ?? []) as Array<{ id: string; name?: string; contentType?: string; size?: number; contentBytes?: string; "@odata.type"?: string }>;
      const cvs = [];
      for (const a of atts) {
        if (a["@odata.type"] !== "#microsoft.graph.fileAttachment" || !a.name || !CV_TYPES.test(a.name) || !a.contentBytes) continue;
        const fileHash = createHash("sha256").update(Buffer.from(a.contentBytes, "base64")).digest("hex");
        const known: boolean = await ctx.runQuery(internal.communications.emailAgent.checkFileHashExists, { fileHash });
        cvs.push({ id: a.id, name: a.name, contentType: a.contentType ?? "application/pdf", size: a.size ?? 0, fileHash, known: !!known });
      }
      if (cvs.length === 0) continue;
      out.push({
        messageId: m.id,
        subject: m.subject ?? "",
        from: m.from?.emailAddress?.address ?? "",
        receivedAt: m.receivedDateTime,
        isRead: m.isRead,
        preview: (m.bodyPreview ?? "").slice(0, 300),
        cvs,
      });
    }
    return out;
  },
});

/** Whether a candidate has a search vector, and removing the test ones. */
export const vectors = internalAction({
  args: { candidateIds: v.array(v.string()), remove: v.optional(v.boolean()) },
  handler: async (_ctx, args): Promise<Record<string, boolean>> => {
    if (!outboundLocked()) throw new Error("inboxTest runs only on a test deployment (C141_OUTBOUND_LOCK=true).");
    const client = getQdrantClient();
    const out: Record<string, boolean> = {};
    for (const id of args.candidateIds) {
      const found = await client.retrieve(QDRANT_CANDIDATE_COLLECTION, { ids: [candidateIdToPointId(id)], with_payload: false }).catch(() => []);
      out[id] = found.length > 0;
      if (args.remove && out[id]) await deleteCandidateVector(id);
    }
    return out;
  },
});
