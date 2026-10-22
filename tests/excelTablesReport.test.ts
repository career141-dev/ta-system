import assert from "node:assert/strict";
import { run } from "../convex/admin/excelTablesReport";

type Row = Record<string, any>;
const data = new Map<string, Row[]>();
const rows = (name: string) => data.get(name) ?? (data.set(name, []), data.get(name)!);
const put = (name: string, row: Row) => rows(name).push(row);
const db = {
  get: async (id: string) => [...data.values()].flat().find(row => row._id === id) ?? null,
  query: (name: string) => {
    const conditions: Array<(row: Row) => boolean> = [];
    const query = {
      withIndex: (_index: string, build: (q: any) => unknown) => {
        const q = { eq: (field: string, value: unknown) => (conditions.push(row => row[field] === value), q) };
        build(q);
        return query;
      },
      collect: async () => rows(name).filter(row => conditions.every(check => check(row))),
      first: async () => rows(name).find(row => conditions.every(check => check(row))) ?? null,
    };
    return query;
  },
};
const execute = (args: { client: string; title: string }) => (run as any)._handler({ db }, args);

const at = Date.parse("2026-10-21T05:00:00.000Z");
put("clients", { _id: "c1", name: "Akbar Brothers" });
put("clients", { _id: "c2", name: "Other Co" });
put("users", { _id: "hassan", fullName: "Hassan", role: "recruiter", isActive: true });
put("users", { _id: "admin", fullName: "Admin", role: "admin", isActive: true });
put("jobs", { _id: "job", title: "Customer Service Manager", clientName: "Akbar Brothers", clientId: "c1", status: "active", _creationTime: at,
  workLocations: [{ id: "col", name: "colombo , Sri Lanka", vacancies: 1 }] });
// The same title under the legacy free text only: a second copy is reported too.
put("jobs", { _id: "copy", title: "Customer Service Manager", clientName: "Akbar Brothers", status: "active", _creationTime: at });
put("jobs", { _id: "elsewhere", title: "Customer Service Manager", clientName: "Other Co", clientId: "c2", _creationTime: at });
for (let i = 0; i < 31; i++) put("linkVault", { _id: `old${i}`, openingId: "job", addedBy: "hassan", level: 2, _creationTime: at + i, name: `Candidate ${i}`, linkedinUrl: `https://linkedin.com/in/c${i}` });
put("linkVault", { _id: "old-l1", openingId: "job", addedBy: "hassan", level: 1, _creationTime: at, name: "Candidate L1", linkedinUrl: "https://linkedin.com/in/l1" });
for (let i = 0; i < 14; i++) put("linkVault", { _id: `col${i}`, openingId: "job", addedBy: "hassan", workLocationId: "col", level: 1, _creationTime: at + 86400000, name: `Colombo ${i}`, linkedinUrl: `https://linkedin.com/in/col${i}` });
put("taSettings", { _id: "s1", key: "link_levels:job:hassan", value: JSON.stringify([{ at }, { at }]) });
put("taSettings", { _id: "s2", key: "link_levels:job:admin:col", value: JSON.stringify([{ at: at + 86400000 }]) });
put("activityLog", { _id: "a1", entityType: "job", entityId: "job", actorName: "Admin", action: "work_location_assigned", occurredAt: new Date().toISOString(), metadata: { locationId: "col", links: [{ id: "col0" }] } });

const report = await execute({ client: "akbar", title: "customer service" });
assert.deepEqual(report.clientsMatched, ["Akbar Brothers"]);
assert.deepEqual(report.openings.map((o: Row) => o.jobId).sort(), ["copy", "job"], "both copies of the opening, nothing from another client");
const job = report.openings.find((o: Row) => o.jobId === "job");
assert.equal(job.rowsTotal, 46);
const group = (location: string, level: number) => job.rows.find((g: Row) => g.location === location && g.level === level)?.rows;
assert.equal(group("Location not assigned", 2), 31, "rows from before the location are reported as not assigned");
assert.equal(group("Location not assigned", 1), 1);
assert.equal(group("colombo , Sri Lanka", 1), 14);
assert.equal(job.rows[0].addedBy, "Hassan (recruiter)");
assert.deepEqual(job.sheets.map((s: Row) => [s.user, s.location, s.sheets.length]), [
  ["Hassan (recruiter)", "Location not assigned", 2],
  ["Admin (admin)", "colombo , Sri Lanka", 1],
]);
assert.deepEqual(job.activityLast7Days.map((a: Row) => [a.action, a.to, a.rows]), [["work_location_assigned", "colombo , Sri Lanka", 1]]);

// The result is printed in the Actions log: no candidate details in it.
const printed = JSON.stringify(report);
assert.ok(!printed.includes("Candidate") && !printed.includes("Colombo 0") && !printed.includes("linkedin.com"), "no candidate names or profile links");

await assert.rejects(execute({ client: "ak", title: "customer" }), /three letters/);
assert.deepEqual((await execute({ client: "nobody", title: "manager" })).openings, []);
console.log("Excel tables report tests passed.");
