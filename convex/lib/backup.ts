// convex/lib/backup.ts
//
// Who a newly shortlisted CV is a backup for (the desk, 28 Sep). Once a role
// has someone at interview or offer — the final interview is today — any
// other profile brought up for it, from the TA's hunt or a follow-up, is a
// backup: cover in case the front-runner falls through. The TA can take the
// tag off, or put it on by hand.
//
// One rule, called by both copies of the shortlist: convex/ta/applications.ts
// (live) and src/data/store.ts (the local store), like convex/lib/sets.ts.

/** Stages that make someone the one to back up, furthest along first. */
export const BACKED_UP_STAGES = ["offer", "interview"] as const;

/**
 * The application a CV would be backing up: the opening's candidate furthest
 * along, at offer before interview, never the CV itself. Null when nobody on
 * the role is that far yet.
 */
export function backupPrimary(apps: readonly { id: string; stage: string }[], selfId: string): string | null {
  for (const stage of BACKED_UP_STAGES) {
    const primary = apps.find((a) => a.id !== selfId && a.stage === stage);
    if (primary) return primary.id;
  }
  return null;
}
