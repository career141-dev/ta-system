import { query } from "../_generated/server";
export const getRecentWhatsAppCVs = query(async (ctx) => {
  const uploads = await ctx.db.query("cvUploads")
    .filter(q => q.eq(q.field("source"), "whatsapp"))
    .order("desc")
    .take(5);
  
  const configRow = await ctx.db.query("appSettings").withIndex("by_key", q => q.eq("key", "system")).first();
  return {
    toggles: configRow?.channel_toggles,
    recentUploads: uploads.map(u => ({ id: u._id, status: u.status, from: u.uploadedBy, date: new Date(u._creationTime).toISOString() }))
  };
});
