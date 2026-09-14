import { mutation } from "../_generated/server";

export default mutation({
  handler: async (ctx) => {
    const ACTIVE_JOBS = [
      "m17dhspq4653q094kwet2nng4d8a31e7", // Tech Lead – Frontend (React.js / Vue.js)
      "m170pg8bem9h6g60rdva2385hh8a2jdz", // Manager/ Senior Manager - Group Procurement
    ];

    const allJobs = await ctx.db.query("jobs").collect();
    let activated = 0;
    let disabled = 0;

    for (const job of allJobs) {
      if (ACTIVE_JOBS.includes(job._id)) {
        await ctx.db.patch(job._id, { status: "active", updatedAt: new Date().toISOString() });
        activated++;
      } else {
        await ctx.db.patch(job._id, { status: "on_hold", updatedAt: new Date().toISOString() });
        disabled++;
      }
    }

    return `Done. Activated: ${activated} jobs. Disabled: ${disabled} jobs.`;
  }
});
