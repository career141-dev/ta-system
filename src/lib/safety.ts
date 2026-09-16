import "server-only";
import { convexQuery } from "@/lib/convexServer";

/**
 * The app will not run against a backend that can act on the world by itself,
 * unless this is the production deployment and says so.
 *
 * A restored copy of production holds real candidates' phone numbers and email
 * addresses and real job mailboxes. With its scheduled jobs on, it polls those
 * mailboxes (marking live CVs read, so production never sees them) and chases
 * candidates; with outbound unlocked, a test click messages a real person. So
 * before the first read, the backend is asked, and a backend that is not in
 * the safe state is refused with a message saying which switch to set.
 *
 * `C141_DEPLOYMENT=production` is the only way past it, and is set only on the
 * production server.
 */
let checked: Promise<void> | null = null;

export function assertSafeBackend(): Promise<void> {
  if (process.env.C141_DEPLOYMENT === "production") return Promise.resolve();
  checked ??= convexQuery<{ cronsDisabled: boolean; outboundLocked: boolean }>("ta/storage:safetyState", {})
    .then((s) => {
      const missing = [
        !s.cronsDisabled && "C141_DISABLE_CRONS=true",
        !s.outboundLocked && "C141_OUTBOUND_LOCK=true",
      ].filter(Boolean);
      if (missing.length > 0) {
        throw new Error(
          `Refusing to use this Convex backend: it is not marked safe for testing. Set ${missing.join(" and ")} ` +
            `on the deployment (npx convex env set …), or set C141_DEPLOYMENT=production on the production server only.`,
        );
      }
    })
    .catch((e) => {
      checked = null; // ask again next time rather than remembering a failure
      throw e;
    });
  return checked;
}
