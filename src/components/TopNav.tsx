"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useState } from "react";
import { ROLE_LABEL } from "@/data/types";
import type { User } from "@/data/types";
import { SignOut } from "./SignOut";
import { HEADER_H } from "@/lib/chrome";
import { SearchIcon } from "./icons";
import { searchScopeFor } from "@/lib/searchScope";

const NAV = [
  { href: "/clients", label: "Clients" },
  { href: "/openings", label: "Openings" },
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
];



export function TopNav({
  user,
  alertCount = 0,
}: {
  user: User;
  /** Unactioned alerts for this person — the reason to look. */
  alertCount?: number;
}) {
  const path = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  // The box searches the list on this page — clients on Clients, the stage's
  // candidates on a stage — keeping the page's own filters and tab.
  const scope = searchScopeFor(path);
  const onThisPage = scope.action !== "/search" || path === "/search";
  const current = onThisPage ? params.get("q") ?? "" : "";

  return (
    <header
      className="sticky top-0 z-40 flex items-center border-b border-rule bg-surface px-8"
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
      <Link href="/" className="flex shrink-0 items-center">
        <Image
          src="/career141-lockup-v2.png"
          alt="Career141 — 20 years of excellence"
          width={483}
          height={152}
          priority
          unoptimized
          className="w-auto"
          style={{ height: 54 }}
        />
      </Link>

      <nav className="flex items-center gap-1" style={{ marginLeft: 56 }}>
        {NAV.map((n) => {
          const active = path.startsWith(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-[14px] transition-colors ${
                active ? "bg-paper font-semibold text-ink" : "text-ink-soft hover:bg-paper hover:text-ink"
              }`}
            >
              {n.label}
              {n.href === "/alerts" && alertCount > 0 && (
                <span className="tabular grid h-[18px] min-w-[18px] place-items-center rounded-full bg-danger px-1 text-[10.5px] font-semibold text-white">
                  {alertCount}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="ml-auto flex items-center gap-4">
        <form action={scope.action} method="GET" className="relative hidden md:block">
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
            className="w-[300px] rounded-full border border-rule bg-paper py-2 pl-9 pr-4 text-[13px] outline-none transition-colors placeholder:text-ink-faint focus:border-brand-line focus:bg-surface"
          />
        </form>

        <span className="hidden items-center gap-1.5 text-[11.5px] text-ink-faint lg:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-ink-faint/60" />
          Test data
        </span>

        <div className="relative">
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-paper"
          >
            <span className="grid h-8 w-8 place-items-center rounded-full bg-brand text-[10.5px] font-bold text-white">
              {user.initials}
            </span>
            <span className="hidden text-left leading-tight sm:block">
              <span className="block text-[12.5px] font-semibold">{user.name}</span>
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
              {user.role === "admin" && (
                <Link
                  href="/settings"
                  onClick={() => setOpen(false)}
                  className="block px-3 py-2 text-[12.5px] hover:bg-paper"
                >
                  Settings
                </Link>
              )}
              <div className="border-t border-rule">
                <SignOut className="block w-full px-3 py-2 text-left text-[12.5px] hover:bg-paper" />
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
