import { matchReviewReply, DEFAULT_SHORTLIST_INBOX } from "@/lib/routing";
import type { Client, Opening, ReviewRound, User } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

const users = [
  { id: "u_dir", name: "Director", email: "director@career141.com", phone: null, routingEmail: null, role: "director", initials: "DR", isActive: true },
  { id: "u_nuha", name: "Nuha", email: "nuha@career141.com", phone: null, routingEmail: "nuha.jobs@career141.com", role: "ta", initials: "NU", isActive: true },
] as User[];

const clients = [
  { id: "cl_delmo", name: "Delmo", industry: "FMCG", contacts: [{ name: "Head of HR", title: "HR", email: "hr@delmo.example", isPrimary: true }], esaSignedAt: null, status: "active", createdAt: 0 },
  { id: "cl_ckdl", name: "CKDL", industry: "Apparel", contacts: [{ name: "People Dir", title: "PD", email: "people@ckdl.example", isPrimary: true }], esaSignedAt: null, status: "active", createdAt: 0 },
] as Client[];

const op = (id: string, clientId: string, title: string) => ({ id, clientId, title } as Opening);
const openings = [
  op("op_brand", "cl_delmo", "Brand Manager"),
  op("op_brand2", "cl_ckdl", "Brand Manager"),   // same title, different client
  op("op_hof", "cl_delmo", "Head of Finance"),
];

const round = (
  id: string, openingId: string, kind: "director" | "client", sentAt: number,
  status = "awaiting", subject = "", messageId: string | null = null,
) =>
  ({ id, openingId, kind, sentAt, status, applicationIds: ["a1", "a2"], token: "", messageId,
     setNumber: null, sentBy: "u_nuha", sentTo: "x", trackedAt: DEFAULT_SHORTLIST_INBOX,
     subject, dispatch: "held", returnedAt: null, replyBody: null, decisions: [] } as ReviewRound);

const rounds = [
  round("r_delmo_dir", "op_brand", "director", 1000),
  round("r_delmo_cli", "op_brand", "client", 2000),
  round("r_ckdl_dir", "op_brand2", "director", 1500),
  round("r_hof_dir", "op_hof", "director", 900),
];
const M = (from: string, subject: string, rs = rounds, inReplyTo: string | null = null) =>
  matchReviewReply({ from, subject, inReplyTo }, { rounds: rs, openings, clients, users });

console.log("\nthe house subject line");
eq("Director replying about Delmo Brand Manager",
  M("director@career141.com", "RE: DELMO - BRAND MANAGER - 12 SEPTEMBER 2026").round?.id, "r_delmo_dir");
eq("the client replying to the SAME subject goes to the client round",
  M("hr@delmo.example", "RE: DELMO - BRAND MANAGER - 12 SEPTEMBER 2026").round?.id, "r_delmo_cli");
eq("a different opening",
  M("director@career141.com", "Re: DELMO - HEAD OF FINANCE - 12 SEPTEMBER 2026").round?.id, "r_hof_dir");

console.log("\nthe same job title at two clients");
eq("Delmo's Brand Manager", M("director@career141.com", "DELMO - BRAND MANAGER - 1 OCT 2026").round?.id, "r_delmo_dir");
eq("CKDL's Brand Manager", M("director@career141.com", "CKDL - BRAND MANAGER - 1 OCT 2026").round?.id, "r_ckdl_dir");

console.log("\nthe client is the one who names themselves");
eq("CKDL's contact cannot answer Delmo's set",
  M("people@ckdl.example", "DELMO - BRAND MANAGER - 1 OCT 2026").round, null);

console.log("\nwhen it must not guess");
const stranger = M("someone@gmail.com", "DELMO - BRAND MANAGER - 1 OCT 2026");
eq("a sender we do not know is not applied", stranger.round, null);
eq("and says why", /not the Director and not a contact/.test(stranger.note), true);
eq("but it shows what it nearly matched", stranger.near.length > 0, true);

const noSubject = M("director@career141.com", "Re: your email");
eq("a subject naming no opening", noSubject.round, null);
eq("says so", /does not name any opening/.test(noSubject.note), true);

eq("nothing out at all",
  M("director@career141.com", "DELMO - BRAND MANAGER - 1 OCT 2026", []).note,
  "Nothing is out waiting on a reply.");

eq("a client replying where only a director set is out",
  M("hr@delmo.example", "DELMO - HEAD OF FINANCE - 1 OCT 2026").round, null);

console.log("\nthe same set sent twice");
const twice = [round("r_old", "op_hof", "director", 100), round("r_new", "op_hof", "director", 5000)];
eq("answers the latest one", M("director@career141.com", "DELMO - HEAD OF FINANCE - 1 OCT", twice).round?.id, "r_new");

console.log("\na round already answered is not reopened");
const done = [round("r_done", "op_hof", "director", 100, "returned")];
eq("returned rounds are out of scope", M("director@career141.com", "DELMO - HEAD OF FINANCE", done).round, null);



// ─── Finding 43: two sets out on one opening ─────────────────────────────────
// Before this, the newest outstanding round always won, so a reply about the
// 1 September set was applied to the 11 September set — different people, and
// the reply's numbers meant something else entirely.

const SUB_1 = "DELMO - BRAND MANAGER - 1 SEPTEMBER 2026";
const SUB_11 = "DELMO - BRAND MANAGER - 11 SEPTEMBER 2026";
const sept = (d: number) => new Date(2026, 8, d).getTime();

const twoSets = [
  round("r_sep1", "op_brand", "director", sept(1), "awaiting", SUB_1, "<eod-sep-1@career141.com>"),
  round("r_sep11", "op_brand", "director", sept(11), "awaiting", SUB_11, "<eod-sep-11@career141.com>"),
];
const D = (subject: string, inReplyTo: string | null = null) =>
  M("director@career141.com", subject, twoSets, inReplyTo);

console.log("\nwhich set is this reply answering");
eq("the subject names the 1 September set", D(`RE: ${SUB_1}`).round?.id, "r_sep1");
eq("the subject names the 11 September set", D(`RE: ${SUB_11}`).round?.id, "r_sep11");
eq("forwarded twice, still the 1st", D(`FW: Re: ${SUB_1}`).round?.id, "r_sep1");
eq("a rewritten subject still threads onto its mail",
  D("Re: your shortlist", "<eod-sep-1@career141.com>").round?.id, "r_sep1");
eq("the thread id beats a misleading subject",
  D(`RE: ${SUB_11}`, "<eod-sep-1@career141.com>").round?.id, "r_sep1");
eq("only the date survives the subject", D("Re: brand manager 1 September 2026").round?.id, "r_sep1");

// A subject naming no opening and no thread to follow is not guessed at — a
// wrong guess here moves the wrong people.
const blind = D("Re: shortlist");
eq("no opening in the subject and no thread: no match", blind.round, null);
eq("and it says why", /does not name any opening/.test(blind.note), true);

// The opening is clear but which of its two sets is not. Then it says so.
const ambiguous = D("RE: DELMO - BRAND MANAGER");
eq("ambiguous set falls back to the newest", ambiguous.round?.id, "r_sep11");
eq("and says it is a guess", /most recent/.test(ambiguous.note), true);
eq("and offers the other set", ambiguous.near.map((r) => r.id), ["r_sep1"]);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
