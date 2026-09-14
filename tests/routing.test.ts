import { addressOf, autoFile, classifyInbound, makeCampaignCode, routeByCampaignCode, routeInbound, titleCandidates } from "@/lib/routing";
import type { JobPost, User } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const user = (id: string, name: string, routingEmail: string | null, role = "ta"): User =>
  ({ id, name, email: `${name.toLowerCase()}@career141.com`, phone: null, routingEmail,
     role: role as User["role"], initials: "XX", isActive: true });

const post = (id: string, openingId: string, title: string, taId: string, aliasKeywords: string[] = [], status = "live"): JobPost =>
  ({ id, openingId, title, previousTitles: [], campaignCode: "", aliasKeywords, country: "Sri Lanka", city: null, channel: "linkedin",
     routingEmailAlias: "", assignedTaId: taId, externalUrl: null, postedAt: 0,
     status: status as JobPost["status"], cvCountToday: 0, createdAt: 0 });

const users = [user("u_nuha", "Nuha", "nuha.jobs@career141.com"), user("u_zainab", "Zainab", "zainab.jobs@career141.com"), user("u_dir", "Director", null, "director")];
// Nuha runs three live jobs, two of them under the SAME opening.
const posts = [
  post("p1", "op_brand", "Brand Manager", "u_nuha"),
  post("p2", "op_brand", "Assistant Brand Manager", "u_nuha"),
  post("p3", "op_mkt", "Marketing Executive", "u_nuha", ["Marketing Officer", "Exec - Marketing"]),
  post("p4", "op_hof", "Head of Finance", "u_zainab"),
  post("p5", "op_old", "Brand Manager", "u_nuha", [], "closed"),
  post("p6", "op_ops", "Operations Executive", "u_nuha", [], "paused"),
];
const R = (to: string, subject: string) => routeInbound({ to, subject }, users, posts);

console.log("\naddresses");
eq("display name stripped", addressOf('"Nuha Jobs" <NUHA.JOBS@Career141.com>'), "nuha.jobs@career141.com");
eq("plain", addressOf("nuha.jobs@career141.com"), "nuha.jobs@career141.com");
eq("rubbish", addressOf("not an address"), null);

console.log("\nthe subjects LinkedIn actually sends");
for (const [subj, want] of [
  ["New application: Brand Manager from Nimal Perera", "p1"],
  ["Nimal Perera applied to Brand Manager at Delmo", "p1"],
  ["Your applicant for: Brand Manager", "p1"],
  ["Brand Manager - Nimal Perera | LinkedIn", "p1"],
  ["New application: Assistant Brand Manager from Kasun Silva", "p2"],
  ["Application for Marketing Executive", "p3"],
] as const) {
  eq(`"${subj.slice(0, 46)}"`, R("nuha.jobs@career141.com", subj).postId, want);
}

console.log("\ntwo jobs, one opening — the case the shared inbox could not do");
eq("Brand Manager → p1, not p2", R("nuha.jobs@career141.com", "New application: Brand Manager from A").postId, "p1");
eq("Assistant Brand Manager → p2", R("nuha.jobs@career141.com", "New application: Assistant Brand Manager from B").postId, "p2");
eq("and it carries the opening", R("nuha.jobs@career141.com", "Brand Manager").openingId, "op_brand");

console.log("\nthe alias keywords a TA sets on the post");
eq("advert headed differently", R("nuha.jobs@career141.com", "New application: Marketing Officer from C").postId, "p3");
eq("and says what it matched", R("nuha.jobs@career141.com", "New application: Marketing Officer from C").matchedOn, "Marketing Officer");
eq("confidence is keyword", R("nuha.jobs@career141.com", "Marketing Officer").confidence, "keyword");

console.log("\nscoping to the TA and to live jobs");
eq("another TA's job is not routed here", R("nuha.jobs@career141.com", "Head of Finance").postId, null);
eq("but it does route on her own mailbox", R("zainab.jobs@career141.com", "Head of Finance").postId, "p4");
eq("a closed job takes nothing", R("nuha.jobs@career141.com", "Brand Manager").postId !== "p5", true);
eq("an advert that is not up on LinkedIn is not filed against",
  R("nuha.jobs@career141.com", "Operations Executive").postId, null);
eq("but the TA is still known, so it lands in their queue",
  R("nuha.jobs@career141.com", "Operations Executive").taId, "u_nuha");
eq("an address we do not own", R("someone@gmail.com", "Brand Manager").taId, null);
eq("a director has no routing mailbox", R("director@career141.com", "Brand Manager").taId, null);

console.log("\nwhen it should not guess");
const none = R("nuha.jobs@career141.com", "Query about your advertisement");
eq("no job matched → TA known, job not", [none.taId, none.postId], ["u_nuha", null]);
eq("and it is not auto-filed", autoFile(none), false);
eq("exact match is auto-filed", autoFile(R("nuha.jobs@career141.com", "Brand Manager")), true);
eq("a partial match is filed but flagged",
  autoFile(R("nuha.jobs@career141.com", "Head Finance")), false);

console.log("\nwhich drop box it landed in");
eq("the jobs inbox is an application",
  classifyInbound("nuha.jobs@career141.com", users), { kind: "application", taId: "u_nuha" });
eq("the one shared shortlist box is a reply",
  classifyInbound("shortlists@career141.com", users), { kind: "review_reply", taId: null });
eq("the TA's own working mailbox is never read",
  classifyInbound("nuha@career141.com", users), { kind: "not_ours", taId: null });
eq("and neither is anything else",
  classifyInbound("someone@gmail.com", users), { kind: "not_ours", taId: null });

console.log("\nthe house subject line, for replies");
eq("CLIENT - TITLE - DATE picks the title out",
  titleCandidates("DELMO - BRAND MANAGER - 12 SEPTEMBER 2026").some((c) => c.toLowerCase() === "brand manager"), true);
eq("and routes", R("nuha.jobs@career141.com", "RE: DELMO - BRAND MANAGER - 12 SEPTEMBER 2026").postId, "p1");

// ─── The desk's four posting patterns (13 September) ─────────────────────────
const P = (id: string, openingId: string, title: string, taId: string, over: Partial<JobPost> = {}): JobPost =>
  ({ ...post(id, openingId, title, taId), ...over });
const users4 = [
  user("u_shamra", "Shamra", "shamra.jobs@career141.com"),
  user("u_azma", "Azma", "azma.jobs@career141.com"),
];
const Q = (to: string, subject: string, ps: JobPost[], body: string | null = null) =>
  routeInbound({ to, subject, body }, users4, ps);

console.log("\ntype 1: one job, several posts, one recruiter");
const t1 = [
  P("a", "op_hom", "Head of Manufacturing", "u_shamra", { postedAt: 100 }),
  P("b", "op_hom", "Head of Manufacturing", "u_shamra", { postedAt: 200 }),
];
const r1 = Q("shamra.jobs@career141.com", "New application: Head of Manufacturing", t1);
eq("filed to the job, not dropped as a tie", r1.openingId, "op_hom");
eq("on the advert posted most recently", r1.postId, "b");
eq("nothing ambiguous", r1.ambiguous.length, 0);

console.log("\ntype 2: one job, two recruiters, one region each");
const t2 = [
  P("sl", "op_hom", "Head of Manufacturing", "u_shamra", { country: "Sri Lanka" }),
  P("bd", "op_hom", "Head of Manufacturing", "u_azma", { country: "Bangladesh" }),
];
eq("Shamra's mailbox gets Shamra's post", Q("shamra.jobs@career141.com", "Head of Manufacturing", t2).postId, "sl");
eq("Azma's mailbox gets Azma's post", Q("azma.jobs@career141.com", "Head of Manufacturing", t2).postId, "bd");

console.log("\ntype 3: one job, several regions, one recruiter, one nationality");
const t3 = [
  P("qa", "op_hom", "Head of Manufacturing", "u_shamra", { country: "Qatar", postedAt: 300 }),
  P("ae", "op_hom", "Head of Manufacturing", "u_shamra", { country: "United Arab Emirates", postedAt: 200 }),
  P("om", "op_hom", "Head of Manufacturing", "u_shamra", { country: "Oman", postedAt: 100 }),
];
eq("the region in the message picks the post",
  Q("shamra.jobs@career141.com", "Head of Manufacturing", t3, "Location: Muscat, Oman").postId, "om");
eq("no region named still files to the job",
  Q("shamra.jobs@career141.com", "Head of Manufacturing", t3).openingId, "op_hom");

console.log("\ntype 4: the title edited on a live post");
const t4 = [P("ed", "op_hom", "Head of Production", "u_shamra", { previousTitles: ["Head of Manufacturing"] })];
eq("an applicant under the old title still lands", Q("shamra.jobs@career141.com", "Head of Manufacturing", t4).postId, "ed");
eq("and under the new one", Q("shamra.jobs@career141.com", "Head of Production", t4).postId, "ed");

console.log("\none recruiter, two clients, same title: the CV goes to both");
const clash = [
  P("x", "op_client_a", "Head of Manufacturing", "u_shamra", { postedAt: 200 }),
  P("y", "op_client_b", "Head of Manufacturing", "u_shamra", { postedAt: 100 }),
];
const rc = Q("shamra.jobs@career141.com", "Head of Manufacturing", clash);
eq("filed to the first opening", rc.openingId, "op_client_a");
eq("and to the other one too", rc.alsoTo, [{ postId: "y", openingId: "op_client_b" }]);
eq("nothing held back", rc.ambiguous.length, 0);

console.log("\ncampaign codes: Meta and email-campaign applicants");
const coded = [
  P("meta", "op_hom", "Head of Manufacturing", "u_shamra", { channel: "facebook", campaignCode: "HM-7K3" }),
  P("mail", "op_brand", "Brand Manager", "u_azma", { channel: "email_campaign", campaignCode: "BM-Q2X" }),
  P("off", "op_old", "Old Job", "u_azma", { campaignCode: "OJ-AAA", status: "closed" }),
];
eq("a WhatsApp message carrying the code finds the post", routeByCampaignCode("Hi, I'm applying for Head of Manufacturing (HM-7K3)", coded)?.id, "meta");
eq("lower case still counts", routeByCampaignCode("re: bm-q2x my cv attached", coded)?.id, "mail");
eq("a closed post's code routes nothing", routeByCampaignCode("OJ-AAA", coded), null);
eq("a code inside another word is not a match", routeByCampaignCode("XHM-7K3Y", coded), null);
eq("no code, no route", routeByCampaignCode("Hello, is this job still open?", coded), null);
const code = makeCampaignCode("Head of Manufacturing", ["HM-7K3"]);
eq("codes use the title's initials", code.startsWith("HM-"), true);
eq("and never repeat one in use", code !== "HM-7K3", true);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
