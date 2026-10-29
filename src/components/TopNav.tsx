"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { ROLE_LABEL } from "@/data/types";
import type { User } from "@/data/types";
import { SignOut } from "./SignOut";
import { AppVersion } from "./AppVersion";
import { HEADER_H } from "@/lib/chrome";
import { SearchIcon } from "./icons";
import { searchScopeFor } from "@/lib/searchScope";
import { NotificationBell } from "./NotificationBell";
import { ThemeToggle } from "./ThemeToggle";
import { allows, isTa } from "@/lib/auth";

const NAV = [
  { href: "/clients", label: "Clients" },
  { href: "/openings", label: "Openings" },
  { href: "/support-tables", label: "Excel Tables" },
  // TA Leads give the TAs strategies per job (8 Oct); shown only to those who may.
  { href: "/strategy", label: "Strategy Planner" },
  { href: "/database", label: "Database" },
  // Intake, follow-ups and placements are deliberately NOT here.
  //
  // Both were screens for work that should not need a screen: a CV arriving
  // should land on its job, and a chase should go out on its own. A tab for
  // each turned two background jobs into two more places a TA has to remember
  // to look. When either needs a person, it raises an alert instead.
  //
  // Placements is not a daily destination either — it is the commercial record
  // behind a client, so it is reached from Clients, where the fee terms and
  // the agreement already live.
  // Finding 04 — a complete alerts page that nothing linked to. Every alert the
  // system raised was invisible.
  { href: "/alerts", label: "Alerts" },
  { href: "/reports", label: "Reports" },
  { href: "/ta-track", label: "TA Track" },
  // Practice calls with the AI screening agent (as the CV platform's Aura page).
  { href: "/voice", label: "Voice agent" },
  { href: "/feedback", label: "Feedback" },
  // Deleted clients and openings, restorable for seven days (28 Sep).
  { href: "/bin", label: "Bin" },
];



export function TopNav({
  user,
  alertCount = 0,
  feedbackBadgeCount = 0,
}: {
  user: User;
  /** Unactioned alerts for this person — the reason to look. */
  alertCount?: number;
  /** Unreviewed feedback items requiring action/attention. */
  feedbackBadgeCount?: number;
}) {
  const path = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  // Below 1280px the links and the search fold into one menu button (5 Oct,
  // mobile): seven links and a 300px box do not fit a phone or a tablet.
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [path]);
  // The box searches the list on this page — clients on Clients, the stage's
  // candidates on a stage — keeping the page's own filters and tab.
  const scope = searchScopeFor(path);
  const onThisPage = scope.action !== "/search" || path === "/search";
  const current = onThisPage ? params.get("q") ?? "" : "";

  const links = NAV.filter(
    (n) =>
      (n.href !== "/workday" || ["ta", "ta_support", "ta_lead", "admin"].includes(user.role)) &&
      (n.href !== "/voice" || allows(user, "voice.practice")) &&
      (n.href !== "/strategy" || allows(user, "strategy.assign")) &&
      (n.href !== "/ta-track" || user.role === "admin" || user.role === "ta_lead") &&
      (n.href !== "/support-tables" || allows(user, "tables.readAll")) &&
      (n.href !== "/feedback" || !isTa(user)),
  );
  const badge = alertCount > 0 && (
    <span className="tabular grid h-[18px] min-w-[18px] place-items-center rounded-full bg-danger px-1 text-[10.5px] font-semibold text-white">
      {alertCount}
    </span>
  );
  const feedbackBadge = feedbackBadgeCount > 0 && (
    <span className="tabular grid h-[18px] min-w-[18px] place-items-center rounded-full bg-danger px-1 text-[10.5px] font-semibold text-white">
      {feedbackBadgeCount}
    </span>
  );
  const searchBox = (where: string, width: string) => (
    <form action={scope.action} method="GET" className={`relative ${where}`}>
      {scope.keep.map((k) => {
        const v = params.get(k);
        return v ? <input key={k} type="hidden" name={k} value={v} /> : null;
      })}
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint"><SearchIcon /></span>
      <input
        key={`${scope.action}|${current}`}
        name="q"
        defaultValue={current}
        aria-label={scope.placeholder}
        placeholder={scope.placeholder}
        className={`${width} rounded-full border border-rule bg-paper py-2 pl-9 pr-4 text-[13px] outline-none transition-all placeholder:truncate placeholder:text-ink-faint focus:border-brand-line focus:bg-surface`}
      />
    </form>
  );

  return (
    <header
      className="sticky top-0 z-40 flex w-full max-w-full items-center border-b border-rule bg-surface px-3 sm:px-5 xl:px-4 2xl:px-8"
      style={{ height: HEADER_H }}
    >
      {/*
        The mark, recovered from the Canva artwork.

        `career141-logo.png` as supplied is a bad crop — the S of YEARS runs off
        its right edge and OF EXCELLENCE is sliced through the middle. The same
        logo sits on all five snippet plates at 1080px over five different flat
        grounds, which makes the alpha solvable exactly rather than keyed by
        eye: one mark over two known colours gives
        P_A - P_B = (1-a)(bg_A - bg_B), and that solves for the transparency and
        then for the mark's own colour. Matted off the orange and turquoise
        plates, the two furthest apart.

        The filename carries a version because the broken bytes were cached
        under the old one, and a logo that looks fixed to whoever cleared their
        cache is not fixed.

        `unoptimized` because Next re-encodes to WebP at q75 by default, and the
        strapline under YEARS is a few pixels tall at this size — nothing to
        gain on a 38KB file, and the fine print to lose.
      */}
      <Link href="/" className="c141-logo flex shrink-0 items-center">
        <Image
          src="/career141-lockup-v2.png"
          alt="Career141 — 20 years of excellence"
          width={483}
          height={152}
          priority
          unoptimized
          className="h-[36px] w-auto xl:h-[40px] 2xl:h-[48px]"
        />
      </Link>

      <nav className="ml-2 hidden items-center gap-0.5 xl:ml-3 xl:flex 2xl:ml-6 2xl:gap-1">
        {links.map((n) => (
          <Link
            key={n.href}
            href={n.href}
            className={`flex items-center gap-1 whitespace-nowrap rounded-lg px-2 py-1.5 text-[12.5px] transition-colors 2xl:gap-1.5 2xl:px-3 2xl:py-2 2xl:text-[13.5px] ${
              path.startsWith(n.href) ? "bg-paper font-semibold text-ink" : "text-ink-soft hover:bg-paper hover:text-ink"
            }`}
          >
            {n.label}
            {n.href === "/alerts" && badge}
            {n.href === "/feedback" && feedbackBadge}
          </Link>
        ))}
      </nav>

      <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2 xl:gap-2.5 2xl:gap-3.5">
        {searchBox(
          "hidden xl:block",
          "w-[140px] xl:w-[155px] 2xl:w-[250px] focus:w-[210px] focus:2xl:w-[290px] transition-all duration-200"
        )}

        <NotificationBell />

        <div className="relative shrink-0">
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg px-1.5 py-1.5 hover:bg-paper 2xl:gap-2.5 2xl:px-2"
          >
            <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand text-[10.5px] font-bold text-white">
              {user.initials}
            </span>
            <span className="hidden text-left leading-tight sm:block">
              <span className="block max-w-[95px] truncate text-[12px] font-semibold 2xl:max-w-[130px] 2xl:text-[12.5px]">
                {user.name}
              </span>
              <span className="block text-[10.5px] text-ink-faint">{ROLE_LABEL[user.role]}</span>
            </span>
          </button>
          {open && (
            <div className="absolute right-0 top-full z-50 mt-1 w-60 rounded-lg border border-rule bg-surface py-1 shadow-lg">
              <Link
                href="/people"
                onClick={() => setOpen(false)}
                className="block px-3 py-2 text-[12.5px] hover:bg-paper"
              >
                People and roles
              </Link>
              {!isTa(user) && (
                <Link
                  href="/feedback"
                  onClick={() => setOpen(false)}
                  className="block px-3 py-2 text-[12.5px] hover:bg-paper"
                >
                  Feedback & Support
                </Link>
              )}
              {["admin", "director", "ta_lead", "ops"].includes(user.role) && (
                <Link
                  href="/shortlist-decisions"
                  onClick={() => setOpen(false)}
                  className="block px-3 py-2 text-[12.5px] hover:bg-paper"
                >
                  Shortlist decisions
                </Link>
              )}
              {user.role === "admin" && (
                <Link
                  href="/settings"
                  onClick={() => setOpen(false)}
                  className="block px-3 py-2 text-[12.5px] hover:bg-paper"
                >
                  Settings
                </Link>
              )}
              <ThemeToggle className="block w-full px-3 py-2 text-left text-[12.5px] hover:bg-paper" />
              <div className="border-t border-rule">
                <SignOut className="block w-full px-3 py-2 text-left text-[12.5px] hover:bg-paper" />
                <AppVersion className="block px-3 pb-2" />
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={() => setMenu((v) => !v)}
          aria-expanded={menu}
          aria-label={menu ? "Close menu" : "Open menu"}
          className="relative grid h-[40px] w-[40px] place-items-center rounded-lg text-ink hover:bg-paper xl:hidden"
        >
          <svg width={20} height={20} viewBox="0 0 20 20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
            {menu ? <path d="M5 5l10 10M15 5L5 15" /> : <path d="M3 5.5h14M3 10h14M3 14.5h14" />}
          </svg>
          {!menu && alertCount > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-danger" />}
        </button>
      </div>

      {menu && (
        <div className="absolute inset-x-0 top-full max-h-[calc(100dvh-var(--header-h))] overflow-y-auto border-b border-rule bg-surface px-4 pb-4 pt-3 shadow-lg sm:px-6 xl:hidden">
          {searchBox("mb-3", "w-full")}
          <nav className="grid gap-0.5">
            {links.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className={`flex items-center justify-between rounded-lg px-3 py-2.5 text-[14px] ${
                  path.startsWith(n.href) ? "bg-paper font-semibold text-ink" : "text-ink-soft hover:bg-paper hover:text-ink"
                }`}
              >
                {n.label}
                {n.href === "/alerts" && badge}
                {n.href === "/feedback" && feedbackBadge}
              </Link>
            ))}
          </nav>
        </div>
      )}
    </header>
  );
}
