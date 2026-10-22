/**
 * shortlists@: telling the Director's mail from a client's, finding the opening
 * a Director's subject names, and inferring the opening for a client's mail.
 * Pure — no Graph, no database.
 */
import { DIRECTOR_MAILBOXES, inferOpening, matchHouseSubject, parseHouseSubject, shouldMove, stripReplyPrefixes, type OpeningLite } from "../convex/lib/shortlistMail";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};

// ── the subject ─────────────────────────────────────────────────────────────
eq("director subject", parseHouseSubject("LANKA HOSPITAL > PA TO CFO > SET 01"), { client: "LANKA HOSPITAL", position: "PA TO CFO", setNumber: 1, cvCount: null });
eq("reply prefixes stripped", parseHouseSubject("RE: FW: Lanka Hospital > PA to CFO > Set 2")?.setNumber, 2);
eq("app's own subject", parseHouseSubject("SET 1 - DELMO - BRAND MANAGER - 3 CVs"), { client: "DELMO", position: "BRAND MANAGER", setNumber: 1, cvCount: 3 });
eq("hyphen inside a title survives", parseHouseSubject("SET 2 - DELMO - Sales-Retail Lead - 1 CV")?.position, "Sales-Retail Lead");
eq("client subject is not a director subject", parseHouseSubject("CVs for the CFO assistant role"), null);
// 22 Oct: "REVISED" was read as the client, so the resent email named no opening.
eq("a revised email names the same opening", parseHouseSubject("RE: REVISED - SET 2 - DELMO - BRAND MANAGER - 3 CVs"), { client: "DELMO", position: "BRAND MANAGER", setNumber: 2, cvCount: 3 });
eq("empty subject", parseHouseSubject(""), null);
eq("set with no client and position", parseHouseSubject("SET 01"), null);
eq("strip prefixes", stripReplyPrefixes("Re: RE: fwd: hi"), "hi");

// ── a Director's subject → the opening ──────────────────────────────────────
const o = (id: string, clientName: string, title: string, clientContactEmail?: string): OpeningLite => ({ id, clientName, title, clientContactEmail });
const openings = [
  o("o1", "Lanka Hospitals (Pvt) Ltd", "PA to CFO", "hr@lankahospitals.com"),
  o("o2", "Lanka Hospitals (Pvt) Ltd", "Finance Manager"),
  o("o3", "Delmo", "Brand Manager", "amal@delmo.lk"),
  o("o4", "Kandy Foods", "Brand Manager"),
];
const h = (s: string) => matchHouseSubject(parseHouseSubject(s)!, openings);
eq("client + title, exact", h("LANKA HOSPITAL > PA TO CFO > SET 01").opening?.id, "o1");
eq("same title, told apart by client", h("DELMO > BRAND MANAGER > SET 1").opening?.id, "o3");
eq("same title, other client", h("KANDY FOODS > BRAND MANAGER > SET 1").opening?.id, "o4");
eq("unknown client is not filed", h("NOBODY LTD > BRAND MANAGER > SET 1").opening, null);
eq("right client, wrong title is not filed", h("DELMO > CFO > SET 1").opening, null);
const twin = matchHouseSubject(parseHouseSubject("DELMO > BRAND MANAGER > SET 1")!, [...openings, o("o5", "Delmo", "Brand Manager")]);
eq("two identical openings are a tie, not a pick", [twin.opening, twin.near.map((x) => x.id).sort()], [null, ["o3", "o5"]]);

// ── a client's mail → inferred opening ──────────────────────────────────────
const app = (candidateId: string, openingId: string, stage: string) => ({ candidateId, openingId, stage });
const infer = (p: Partial<Parameters<typeof inferOpening>[0]>) =>
  inferOpening({ subject: "", body: "", fromAddress: "someone@gmail.com", applications: [], candidateCount: 0, openings, ...p });

const mostlyShortlisted = infer({
  subject: "Shortlist", fromAddress: "x@nowhere.lk", candidateCount: 3,
  applications: [app("c1", "o3", "director_shortlist"), app("c2", "o3", "director_shortlist"), app("c3", "o4", "matched_candidates")],
});
eq("candidates already at Director Shortlist decide it", [mostlyShortlisted.opening?.id, mostlyShortlisted.confidence], ["o3", "high"]);

const contact = infer({
  subject: "Selected CVs", fromAddress: "hr@lankahospitals.com", candidateCount: 2,
  applications: [app("c1", "o1", "director_shortlist"), app("c2", "o1", "director_shortlist")],
});
eq("client contact plus overlap", [contact.opening?.id, contact.confidence], ["o1", "high"]);

const named = infer({ subject: "Delmo — Brand Manager shortlist", fromAddress: "amal@delmo.lk" });
eq("client and role named, sender is the contact", [named.opening?.id, named.confidence], ["o3", "high"]);

const nothing = infer({ subject: "Hello", body: "Please see attached" });
eq("nothing to go on", [nothing.opening, nothing.confidence], [null, "none"]);

const roleOnly = infer({ subject: "Brand Manager shortlist", fromAddress: "x@gmail.com" });
eq("a title two clients share is held", [roleOnly.opening, roleOnly.confidence], [null, "low"]);

const split = infer({
  subject: "Shortlist", candidateCount: 2,
  applications: [app("c1", "o3", "director_shortlist"), app("c2", "o4", "director_shortlist")],
});
eq("candidates split across two openings are held", [split.opening, split.confidence], [null, "low"]);

const oneCandidate = infer({ subject: "cv", candidateCount: 1, applications: [app("c1", "o3", "matched_candidates")] });
eq("one candidate merely on an opening is not enough", oneCandidate.confidence, "low");

const freeMail = infer({ subject: "cv", fromAddress: "someone@gmail.com", openings: [o("g1", "Gmail Co", "Analyst", "boss@gmail.com")] });
eq("a shared free-mail domain is not a client domain", freeMail.confidence, "none");

// ── moving forward only ─────────────────────────────────────────────────────
eq("new CV → director shortlist", shouldMove("new_cvs", "director_shortlist"), true);
eq("follow-up → client review", shouldMove("follow_up", "client_review"), true);
eq("already there", shouldMove("director_shortlist", "director_shortlist"), false);
eq("director → client", shouldMove("director_shortlist", "client_review"), true);
eq("client review is not pulled back", shouldMove("client_review", "director_shortlist"), false);
eq("interview is not pulled back", shouldMove("interview", "client_review"), false);
eq("rejected is left for a person", shouldMove("rejected", "director_shortlist"), false);
eq("dropped out is left for a person", shouldMove("unresponsive", "client_review"), false);
eq("no stage counts as new", shouldMove(undefined, "director_shortlist"), true);
// 22 Oct: the Director replies from these and is not on People.
eq("the Director's mailboxes", [...DIRECTOR_MAILBOXES], ["joborders@career141.com", "shamra@career141.com"]);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
