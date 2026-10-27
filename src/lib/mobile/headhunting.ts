import { repo } from "@/data/store";
import type { User } from "@/data/types";
import type { HeadhuntingNextStep, HeadhuntingPayload } from "@/lib/mobile/headhuntingTypes";
import { seatFor } from "@/lib/visibility";

const reachedCv = (outcome: string) => outcome === "cv_received" || outcome === "shortlisted";

/** The website's sourcing overview, expressed as phone-ready data. */
export function mobileHeadhunting(user: User, openingId: string): HeadhuntingPayload | null {
  const opening = repo.opening(openingId);
  const client = opening ? repo.client(opening.clientId) : null;
  if (!opening || !client) return null;
  const assignment = repo.assignmentFor(openingId, user.id) ?? null;
  const onStrategy = repo.strategyAssignments(openingId).some((row) => row.doneBy.includes(user.id));
  if (!seatFor(user, assignment?.role ?? null, onStrategy).canSeeSourcing) return null;

  const vault = repo.linkVault(openingId);
  const eye = vault.filter((row) => row.isEyeMarked);
  const reached = vault.filter((row) => reachedCv(row.outcome));
  const eyeReached = eye.filter((row) => reachedCv(row.outcome));
  const notApproached = vault.filter((row) => row.outcome === "no_contact").length;
  const next: HeadhuntingNextStep[] = [];
  if (notApproached > 0) next.push({
    key: "approach",
    title: `${notApproached} links not yet approached`,
    detail: "Pasted but no outreach logged against them",
    action: "Open vault",
    href: `/openings/${openingId}/hh/links`,
  });
  if (eye.length < 3) next.push({
    key: "eye_mark",
    title: `${eye.length} of 3 eye-marked`,
    detail: "The high-conviction profiles this role is measured on",
    action: "Mark profiles",
    href: `/openings/${openingId}/hh/links`,
  });
  next.push({
    key: "benchmark",
    title: "Benchmark not yet chosen",
    detail: "Pick who to benchmark against on Research — it steers the next suggestions round",
    action: "Choose",
    href: `/openings/${openingId}/hh/research`,
  });

  return {
    apiVersion: 1,
    context: { openingId, title: opening.title, clientName: client.name },
    stats: {
      links: vault.length,
      approached: vault.length - notApproached,
      reachedCv: reached.length,
    },
    next,
    eyeMarkYield: {
      eyeMarked: eye.length,
      eyeMarkedReachedCv: eyeReached.length,
      eyeMarkedRate: eye.length ? Math.round((eyeReached.length / eye.length) * 100) : null,
      allLinksRate: vault.length ? Math.round((reached.length / vault.length) * 100) : null,
    },
  };
}
