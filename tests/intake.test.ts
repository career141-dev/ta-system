import { buildSeed } from "@/data/seed";
const db = buildSeed();
for (const i of db.intake) {
  const p = i.parsed!;
  console.log(`\n${i.id}  ${i.source.padEnd(9)} ${i.status.padEnd(13)} verdict=${i.match?.verdict}`);
  console.log(`   file    ${i.fileName}`);
  console.log(`   parsed  name=${p.fullName ?? "—"} | email=${p.email ?? "—"} | phone=${p.phone ?? "—"}`);
  console.log(`           title=${p.currentTitle ?? "—"} | employer=${p.currentEmployer ?? "—"} | loc=${p.location ?? "—"} | yrs=${p.totalExperienceYears ?? "—"} | skills=${p.skills.length}`);
  if (i.match?.candidateName) console.log(`   matched ${i.match.candidateName}  [${i.match.evidence.map(e=>e.key+(e.strong?"*":"")).join(", ")}]`);
  if (i.match?.reason) console.log(`   reason  ${i.match.reason}`);
  if (i.problems.length) console.log(`   problem ${i.problems.join(" / ")}`);
}
