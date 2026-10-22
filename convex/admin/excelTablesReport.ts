/**
 * Why one job's Excel Tables show different rows to a TA and to the desk
 * (22 Oct: Hassan saw L1 1 + L2 31 on Customer Service Manager, Akbar
 * Brothers; admin and the TA Lead saw 14). Read only — it changes nothing.
 *
 * Run through the production release pipeline (run_function
 * admin/excelTablesReport:run, run_args {"client":"akbar","title":"customer service"}).
 * The result lands in the Actions log, so it carries counts, IDs, dates and
 * staff names only — never a candidate's name, profile link or phone.
 */
import { v } from "convex/values";
import { internalQuery } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";

const day = (ms: number) => new Date(ms).toLocaleString("en-GB", { timeZone: "Asia/Colombo", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const run = internalQuery({
  args: { client: v.string(), title: v.string() },
  handler: async (ctx, args) => {
    const client = args.client.trim().toLowerCase();
    const title = args.title.trim().toLowerCase();
    if (client.length < 3 || title.length < 3) throw new Error("Give at least three letters of the client and the title.");

    // Every job for the client, by its record and by the legacy free text, so
    // a second copy of the opening under another spelling is found too.
    const clients = (await ctx.db.query("clients").collect()).filter(c => c.name.toLowerCase().includes(client));
    const byId = (await Promise.all(clients.map(c => ctx.db.query("jobs").withIndex("by_clientId", q => q.eq("clientId", c._id)).collect()))).flat();
    const byName = (await Promise.all([...new Set(clients.map(c => c.name))].map(name => ctx.db.query("jobs").withIndex("by_client", q => q.eq("clientName", name)).collect()))).flat();
    const jobs = [...new Map([...byId, ...byName].map(j => [j._id, j])).values()].filter(j => j.title.toLowerCase().includes(title));
    if (!jobs.length) return { clientsMatched: clients.map(c => c.name), openings: [] };

    const users = new Map((await ctx.db.query("users").collect()).map(u => [u._id, u]));
    const who = (id: Id<"users">) => { const u = users.get(id); return u ? `${u.fullName} (${u.role})` : `unknown ${id}`; };

    const openings = [];
    for (const job of jobs) {
      const locations = job.workLocations ?? [];
      const place = (id?: string) => id ? locations.find(l => l.id === id)?.name ?? `unknown location ${id}` : "Location not assigned";
      const rows = await ctx.db.query("linkVault").withIndex("by_opening", q => q.eq("openingId", job._id)).collect();

      // What each tab can show: rows per person, location and L.
      const groups = new Map<string, { addedBy: string; location: string; level: number | null; rows: number; first: number; last: number }>();
      for (const r of rows) {
        const key = `${r.addedBy}|${r.workLocationId ?? ""}|${r.level ?? ""}`;
        const g = groups.get(key) ?? { addedBy: who(r.addedBy), location: place(r.workLocationId), level: r.level ?? null, rows: 0, first: r._creationTime, last: r._creationTime };
        g.rows++;
        g.first = Math.min(g.first, r._creationTime);
        g.last = Math.max(g.last, r._creationTime);
        groups.set(key, g);
      }

      // The L-sheets each person holds, per location ("" is the job before
      // it had locations). The tab label comes from these.
      const people = new Set<Id<"users">>([...rows.map(r => r.addedBy), ...[...users.values()].filter(u => u.isActive && ["admin", "director", "ta_manager"].includes(u.role)).map(u => u._id)]);
      const sheets = [];
      for (const userId of people) for (const loc of ["", ...locations.map(l => l.id)]) {
        const held = await ctx.db.query("taSettings").withIndex("by_key", q => q.eq("key", `link_levels:${job._id}:${userId}${loc ? `:${loc}` : ""}`)).first();
        if (!held) continue;
        let levels: { at?: number; name?: string; deleted?: boolean; importedFrom?: string }[] = [];
        try { levels = JSON.parse(held.value); } catch { /* reported as empty */ }
        sheets.push({ user: who(userId), location: place(loc || undefined), sheets: levels.map((l, i) => ({
          n: i + 1, started: typeof l === "number" ? day(l) : l.at ? day(l.at) : null,
          ...(typeof l === "object" && l.name ? { name: l.name } : {}), ...(typeof l === "object" && l.deleted ? { deleted: true } : {}),
          ...(typeof l === "object" && l.importedFrom ? { importedFrom: l.importedFrom } : {}),
        })) });
      }

      const activity = (await ctx.db.query("activityLog").withIndex("by_entityType_entityId", q => q.eq("entityType", "job").eq("entityId", job._id)).collect())
        .filter(a => Date.parse(a.occurredAt) > Date.now() - 7 * 86400000)
        .map(a => ({ at: day(Date.parse(a.occurredAt)), by: a.actorName, action: a.action,
          ...(a.action === "work_location_assigned" ? { to: place((a.metadata as { locationId?: string })?.locationId), rows: ((a.metadata as { links?: unknown[] })?.links ?? []).length } : {}) }));

      openings.push({
        jobId: job._id, title: job.title, client: job.clientName, status: (job as Doc<"jobs"> & { status?: string }).status ?? null, created: day(job._creationTime),
        workLocations: locations.map(l => ({ id: l.id, name: l.name, vacancies: l.vacancies, ...(l.archived ? { archived: true } : {}) })),
        rowsTotal: rows.length,
        rows: [...groups.values()].sort((a, b) => a.addedBy.localeCompare(b.addedBy) || a.location.localeCompare(b.location) || (a.level ?? 0) - (b.level ?? 0))
          .map(g => ({ ...g, first: day(g.first), last: day(g.last) })),
        sheets,
        activityLast7Days: activity,
      });
    }
    return { clientsMatched: clients.map(c => c.name), openings };
  },
});
