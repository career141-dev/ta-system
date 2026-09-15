import { mutation } from "../_generated/server";
import { deriveTotalExperienceYears } from "./derivations";

export default mutation({
  handler: async (ctx) => {
    const candidates = await ctx.db.query("candidates").collect();
    let updatedCount = 0;

    for (const candidate of candidates) {
      if ((candidate as any).jobHistory && Array.isArray((candidate as any).jobHistory)) {
        const correctExp = deriveTotalExperienceYears((candidate as any).jobHistory, undefined);
        if (correctExp !== undefined && correctExp !== candidate.totalExperienceYears) {
          await ctx.db.patch(candidate._id, { totalExperienceYears: correctExp });
          updatedCount++;
        }
      }
    }
    return { updatedCount };
  }
});
