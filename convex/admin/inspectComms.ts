import { query } from "../_generated/server";

export const getAllWhatsappComms = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("communications").collect();
    const whatsappOnly = all.filter(c => c.channel === "whatsapp");
    whatsappOnly.sort((a, b) => Number(b.sentAt || 0) - Number(a.sentAt || 0));
    return whatsappOnly.slice(0, 30);
  }
});
