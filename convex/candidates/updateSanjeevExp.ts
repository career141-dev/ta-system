import { mutation } from "../_generated/server";
import { deriveTotalExperienceYears } from "./derivations";

export default mutation({
  handler: async (ctx) => {
    const candidate = await ctx.db.query("candidates")
      .filter(q => q.eq(q.field("email"), "sanjaysanjeev2000@gmail.com"))
      .first();

    if (candidate && (candidate as any).jobHistory && (candidate as any).jobHistory.length > 0) {
      const correctExp = deriveTotalExperienceYears((candidate as any).jobHistory, undefined);
      if (correctExp !== undefined) {
        await ctx.db.patch(candidate._id, { totalExperienceYears: correctExp });
        return { updated: true, newExp: correctExp };
      }
    }
    return { updated: false };
  }
});
