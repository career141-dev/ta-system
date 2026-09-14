/** Builds the reviewer test set: every blind-judged person with the job and their CV, no names or contacts. */
import fs from "node:fs";
import path from "node:path";
const { repo } = await import("@/data/store");
const { dataDir } = await import("@/data/dataDir");
const D = path.join(dataDir(), "judging");
const labels: Record<string, number> = JSON.parse(fs.readFileSync(path.join(D, "labels-all.json"), "utf8"));
const live = JSON.parse(fs.readFileSync(path.join(dataDir(), "live-jobs.json"), "utf8"));
const openings = repo.openings();
const jobs = openings.map((o, i) => {
  const j = live[i];
  return {
    n: i + 1, title: o.title, location: o.locations.join(", "), level: String(j.seniority ?? "").replace(/_/g, " "), minYears: j.expMin,
    mustHaves: (j.skills ?? []).slice(0, 12), niceToHave: (j.nice ?? []).slice(0, 6), industry: j.industry, education: j.edu ?? null,
    jd: String(j.jd ?? "").replace(/\s+/g, " ").slice(0, 2500),
  };
});
const items = Object.entries(labels).map(([key, fit]) => {
  const [n, id] = key.split("|");
  const c = repo.candidate(id);
  if (!c) return null;
  const cv = (repo.cvTextFor(id) ?? "").split("\n").filter((l) => !/@|\+?\d[\d\s-]{7,}|linkedin\.com/i.test(l)).join(" ").replace(/\s+/g, " ");
  // The name is not needed to judge fit; take it out of the text too.
  const nameParts = (c.fullName ?? "").split(/\s+/).filter((w) => w.length > 2);
  const clean = nameParts.reduce((t, w) => t.replace(new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), "[name]"), cv);
  return {
    job: Number(n), id, fit,
    profile: {
      currentTitle: c.currentTitle, employer: c.currentEmployer, years: c.totalExperienceYears, location: c.location,
      history: c.workHistory.slice(0, 6).map((h) => `${h.title} — ${h.employer} (${h.fromYear || "?"}–${h.toYear ?? "now"})`),
      skills: c.skills.slice(0, 15), education: [c.educationDegree, c.educationInstitution].filter(Boolean).join(", "),
      cv: clean.slice(0, 3000),
    },
  };
}).filter(Boolean);
fs.writeFileSync(path.join(D, "reviewset.json"), JSON.stringify({ jobs, items }));
console.log("items", items.length);
