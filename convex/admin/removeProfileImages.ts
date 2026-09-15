import { mutation } from "../_generated/server";

export const removeBatch = mutation({
  args: {},
  handler: async (ctx) => {
    const candidates = await ctx.db
      .query("candidates")
      .order("desc")
      .take(1659);
      
    let deletedCount = 0;
    for (const c of candidates) {
      if ((c as any).profileImageId) {
        try {
          await ctx.storage.delete((c as any).profileImageId);
        } catch (e) {
          console.error("Failed to delete storage id", (c as any).profileImageId, e);
        }
        await ctx.db.patch(c._id, { profileImageId: undefined } as any);
        deletedCount++;
      }
    }
    
    return {
      message: `Processed ${candidates.length}, removed ${deletedCount} images.`
    };
  }
});
