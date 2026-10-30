import { v } from "convex/values";
import { internalAction, internalQuery, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { numberReadiness, type MetaNumberState } from "../lib/senderRouting";

export const list = internalQuery({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("whatsappNumbers").collect();
  },
});

export const isTaNumber = internalQuery({
  args: { phone: v.string() },
  handler: async (ctx, args) => {
    const cleanPhone = args.phone.startsWith('+') ? args.phone : `+${args.phone.replace(/[^0-9]/g, '')}`;
    const existing = await ctx.db
      .query("whatsappNumbers")
      .withIndex("by_phone", (q) => q.eq("phone", cleanPhone))
      .first();
    return !!existing;
  }
});

export const add = internalMutation({
  args: {
    name: v.string(),
    phone: v.string(),
    whatchimpPhoneId: v.string(),
    wabaId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Basic formatting for phone
    const cleanPhone = args.phone.startsWith('+') ? args.phone : `+${args.phone.replace(/[^0-9]/g, '')}`;
    
    // Check if it already exists
    const existing = await ctx.db
      .query("whatsappNumbers")
      .withIndex("by_phone", (q) => q.eq("phone", cleanPhone))
      .first();

    if (existing) {
      throw new Error("This WhatsApp number is already registered.");
    }

    return await ctx.db.insert("whatsappNumbers", {
      name: args.name,
      phone: cleanPhone,
      whatchimpPhoneId: args.whatchimpPhoneId,
      wabaId: args.wabaId,
      createdAt: new Date().toISOString(),
    });
  },
});

export const remove = internalMutation({
  args: {
    id: v.id("whatsappNumbers"),
  },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.id);
  },
});

export const removeNumberByPattern = internalMutation({
  args: { pattern: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db.query("whatsappNumbers").collect();
    let removed = 0;
    for (const num of all) {
      if (
        num.phone.includes(args.pattern) ||
        num.whatchimpPhoneId.includes(args.pattern) ||
        num.name.toLowerCase().includes(args.pattern.toLowerCase())
      ) {
        await ctx.db.delete(num._id);
        removed++;
      }
    }
    return { removed };
  },
});


/** Settings → WhatsApp numbers: every sending number, with its TA and readiness. */
export const listForSettings = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("whatsappNumbers").collect();
    return await Promise.all(
      rows.map(async (n) => ({
        id: n._id,
        name: n.name,
        phone: n.phone,
        phoneId: n.whatchimpPhoneId,
        wabaId: n.wabaId ?? null,
        taName: n.userId ? ((await ctx.db.get(n.userId))?.fullName ?? null) : null,
        ready: n.ready ?? null,
        readyNote: n.readyNote ?? null,
        checkedAt: n.checkedAt ?? null,
      })),
    );
  },
});

export const getNumber = internalQuery({
  args: { id: v.id("whatsappNumbers") },
  handler: async (ctx, args) => await ctx.db.get(args.id),
});

export const setReadiness = internalMutation({
  args: { id: v.id("whatsappNumbers"), ready: v.boolean(), note: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { ready: args.ready, readyNote: args.note, checkedAt: Date.now() });
  },
});

/**
 * "Check with Meta" (30 Oct): a TA's number sends their candidates' messages
 * only after Meta confirms it is on the Cloud API, both templates are approved
 * in its WhatsApp account, and its replies are sent to us. Reads only — nothing
 * is sent to anyone.
 */
export const checkWithMeta = internalAction({
  args: { id: v.id("whatsappNumbers") },
  handler: async (ctx, args): Promise<{ ok: boolean; message: string }> => {
    const token = process.env.META_ACCESS_TOKEN;
    if (!token) return { ok: false, message: "Not checked — META_ACCESS_TOKEN is not set on this deployment." };
    const row = await ctx.runQuery(internal.settings.whatsappNumbers.getNumber, { id: args.id });
    if (!row) return { ok: false, message: "That number is no longer listed." };
    if (!row.wabaId) return { ok: false, message: `Not checked — ${row.name}'s WhatsApp account ID is missing.` };

    // Each part is the answer, or Meta's error as text for the note.
    const get = async (path: string): Promise<any> => {
      try {
        const r = await fetch(`https://graph.facebook.com/v19.0/${path}`, { headers: { Authorization: `Bearer ${token}` } });
        const body = await r.json().catch(() => ({}));
        return r.ok ? body : String(body?.error?.message ?? `HTTP ${r.status}`).slice(0, 160);
      } catch (e: any) {
        return String(e?.message ?? e).slice(0, 160);
      }
    };
    const [phone, templates, apps] = await Promise.all([
      get(`${row.whatchimpPhoneId}?fields=status,platform_type,display_phone_number`),
      get(`${row.wabaId}/message_templates?fields=name,status&limit=200`),
      get(`${row.wabaId}/subscribed_apps`),
    ]);
    const state: MetaNumberState = {
      phone,
      templates: typeof templates === "string" ? templates : templates.data ?? [],
      subscribedApps: typeof apps === "string" ? apps : apps.data ?? [],
    };
    const { ready, note } = numberReadiness(row.phone, state);
    await ctx.runMutation(internal.settings.whatsappNumbers.setReadiness, { id: args.id, ready, note });
    return { ok: ready, message: `${row.name} (${row.phone}) — ${note}` };
  },
});
