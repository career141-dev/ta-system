import Link from "next/link";

/**
 * The two ways into the Database (8 Oct): candidates, and the referees named on
 * their CVs. Plain links, so each tab is its own page and its own URL.
 */
export function DbTabs({ active }: { active: "candidates" | "match" | "referral" }) {
  const tab = (on: boolean) =>
    `rounded-full px-4 py-1.5 text-[12.5px] font-medium transition-colors ${
      on ? "bg-navactive text-white" : "text-ink-soft hover:bg-tag hover:text-ink"
    }`;
  return (
    <nav aria-label="Database search" className="mx-auto mb-6 flex w-fit gap-1 rounded-full border border-rule bg-surface p-1">
      <Link href="/database" className={tab(active === "candidates")} aria-current={active === "candidates" ? "page" : undefined}>
        Candidate Search
      </Link>
      <Link href="/database/match" className={tab(active === "match")} aria-current={active === "match" ? "page" : undefined}>
        Match by CV
      </Link>
      <Link href="/database/referral" className={tab(active === "referral")} aria-current={active === "referral" ? "page" : undefined}>
        Referral Search
      </Link>
    </nav>
  );
}

