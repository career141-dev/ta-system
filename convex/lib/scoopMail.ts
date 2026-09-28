// convex/lib/scoopMail.ts
//
// Scoops by email (the desk, 27 September): the Director, a TA Lead or Ops
// mail CVs for a job straight to a TA's own mailbox. The mail intake reads
// those mailboxes for that and nothing else. These are the two decisions it
// makes — whose mail counts, and which of the TA's jobs it is for — kept pure
// so they can be tested without Graph or a database.

/** The roles whose CVs count as a scoop. Another TA's do not (the desk, 27 Sep). */
const SENDER_ROLES = new Set(["director", "ops", "ta_manager", "senior_ta"]);
const SENDER_TA_ROLES = new Set(["director", "ta_lead", "ops"]);

export function isScoopSender(user: { role?: string | null; taRole?: string | null; isActive?: boolean | null } | null | undefined): boolean {
  if (!user || user.isActive === false) return false;
  // An explicit taRole wins, as in the app's own mapping (src/data/convex/map.ts).
  if (user.taRole) return SENDER_TA_ROLES.has(user.taRole);
  return SENDER_ROLES.has(user.role ?? "");
}

export type ScoopOpening = { id: string; title: string; clientName?: string | null };

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Which of the TA's open jobs a scoop is for.
 *
 * One open job: that one — there is nothing else it could be. Otherwise the
 * subject and body have to name the job title; where two jobs share a title,
 * the client's name has to be there too. Anything short of one clear answer is
 * null, and the TA is told to place the CVs by hand rather than have them
 * filed on the wrong job.
 */
export function pickScoopOpening(openings: ScoopOpening[], subject: string, body: string): ScoopOpening | null {
  if (openings.length === 0) return null;
  if (openings.length === 1) return openings[0];

  const text = ` ${norm(`${subject} ${body}`)} `;
  const named = (s: string | null | undefined) => {
    const n = s ? norm(s) : "";
    return n.length > 0 && text.includes(` ${n} `);
  };
  const byTitle = openings.filter((o) => named(o.title));
  if (byTitle.length === 1) return byTitle[0];
  if (byTitle.length === 0) return null;

  // "Brand Manager" and "Senior Brand Manager" both named: the longer title is the one meant.
  const longest = Math.max(...byTitle.map((o) => norm(o.title).length));
  const longer = byTitle.filter((o) => norm(o.title).length === longest);
  if (longer.length === 1 && longer.some((o) => byTitle.every((b) => norm(o.title).includes(norm(b.title))))) return longer[0];

  const byClient = byTitle.filter((o) => named(o.clientName));
  return byClient.length === 1 ? byClient[0] : null;
}
