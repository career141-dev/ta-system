import fs from "node:fs";
import path from "node:path";
try { process.loadEnvFile(path.join(process.cwd(), ".env.local")); } catch {}
const { repo } = await import("@/data/store");
const { dataDir } = await import("@/data/dataDir");
const { askDesk } = await import("@/lib/deskAssistant");
const { spentSoFar } = await import("@/lib/spend");
const user = repo.users().find((u) => u.id === "u_nuha")!;
const qs = [
  "How many CVs do I have for the Procurement Manager job?",
  "Which of my jobs has the most database matches?",
  "Which job has the fewest database matches?",
  "Who are the top 3 matches for the Business Analyst role and why?",
  "Top 5 matches for Head of Engineering",
  "How many people are waiting for me to review across all my jobs?",
  "Is there anyone with NEBOSH among the EHS Manager matches?",
  "Any ACCA or CIMA among the accountant matches?",
  "Which jobs have fewer than 10 strong matches?",
  "Which jobs have more than 20 strong matches?",
  "How many strong matches does the Marketing Executive job have?",
  "How many database matches in total across my jobs?",
  "What's the status of the Group Chief Supply Chain job?",
  "Who is the best match for the Pricing Manager role?",
  "Do we have anyone with MBA for the Group Chief Supply Chain role?",
  "Which client is the Fabric Sourcing job for?",
  "How many interviews do I have coming up?",
  "Any follow-ups pending?",
  "How many jobs am I working on?",
  "Is the JD approved for the Marketing Executive job?",
];
const out = [];
for (const q of qs) {
  const t = Date.now();
  const r = await askDesk(user, q, []);
  out.push({ q, ok: r.ok, instant: r.ok ? r.instant : null, answer: r.ok ? r.answer : r.reason, ms: Date.now() - t });
  console.log(`\nQ: ${q}\n${r.ok ? `${r.instant ? "[instant] " : ""}${r.answer}` : `FAILED ${r.reason}`}  (${Date.now() - t} ms)`);
}
fs.writeFileSync(path.join(dataDir(), "judging", "ask.json"), JSON.stringify(out, null, 1));
console.log(`\n$${spentSoFar().toFixed(4)} spent`);
