"use client";

import { RowCheck } from "./BulkSelect";
import { useEffect, useState } from "react";
import { CLIENTS_TOGGLE_ALL } from "./ClientsToolbar";
import Link from "next/link";
import { ClientDeleteButton, ClientEditor, ClientMenu, type Contact, type Pane } from "./ClientEditor";

export interface ClientOpening {
  id: string;
  title: string;
  priorityTier: string;
  status: string;
  locations: string[];
  taNames: string[];
  followUp: number;
  setsClosed: number;
  days: number;
  target: number;
}

/**
 * A client and the work under it — spec §4.1.
 *
 * The client is the row; the openings are folded away behind it. A desk with a
 * dozen clients and forty openings cannot read a page that prints all forty at
 * once, and the question being asked here is almost always "what is going on at
 * this client", not "show me every role".
 *
 * Open by default where there is live work, because that is the answer to the
 * question most of the time.
 */
/** Which rows the TA left open, per browser. Reloading a page should not undo
 *  a tidy-up: a desk with a dozen clients closes the ones it is not working on
 *  and expects them to stay closed. */
const OPEN_KEY = "c141.clients.open";

function readOpenMap(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

/**
 * Column widths as inline styles, not Tailwind arbitrary values.
 *
 * `grid-cols-[68px_76px_112px]` only exists if the scanner saw that exact
 * string and wrote the rule into the bundle. When it does not — a stale build,
 * a class assembled from a variable — the element keeps `display: grid` and
 * loses its columns, so three stat blocks stack vertically down the right of
 * every row. Inline styles cannot be purged and cannot go stale.
 */
const STAT_COLS = { display: "grid", gridTemplateColumns: "72px 76px 116px" } as const;
const TRAILING = { width: 64 } as const;

export function ClientCard({
  clientId,
  name,
  status,
  esaSignedAt,
  researchNotes,
  contacts,
  canDelete,
  industry,
  contactTitle,
  openCount,
  allTime,
  value,
  openings,
  selectForm,
}: {
  clientId: string;
  name: string;
  status: string;
  esaSignedAt: number | null;
  researchNotes: string;
  contacts: Contact[];
  canDelete: boolean;
  industry: string;
  contactTitle: string | null;
  openCount: number;
  allTime: number;
  value: string;
  openings: ClientOpening[];
  /** The page's bulk bar (components/BulkSelect), for those who may delete. */
  selectForm?: string;
}) {
  // Starts on the server default so the first paint matches the markup, then
  // takes whatever this browser last chose.
  const [open, setOpen] = useState(openCount > 0);
  const [pane, setPane] = useState<Pane>(null);

  useEffect(() => {
    const remembered = readOpenMap()[clientId];
    if (typeof remembered === "boolean") setOpen(remembered);
  }, [clientId]);

  const remember = (next: boolean) => {
    try {
      const map = readOpenMap();
      map[clientId] = next;
      localStorage.setItem(OPEN_KEY, JSON.stringify(map));
    } catch {
      // Private browsing, or storage turned off. The row still toggles.
    }
  };

  const toggle = () =>
    setOpen((was) => {
      remember(!was);
      return !was;
    });

  // "Open all" / "Close all" on the Clients page.
  useEffect(() => {
    const onAll = (e: Event) => {
      const next = Boolean((e as CustomEvent<{ open: boolean }>).detail?.open);
      setOpen(next);
      remember(next);
    };
    window.addEventListener(CLIENTS_TOGGLE_ALL, onAll);
    return () => window.removeEventListener(CLIENTS_TOGGLE_ALL, onAll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  return (
    <section className="group/card rounded-xl border border-rule bg-surface">
      {/* The row expands, and the menu sits on top of it — a button inside a
          button is invalid, and the editing controls were a permanent strip
          across the card before this. */}
      <div
        className={`relative flex flex-wrap items-center gap-x-5 gap-y-3 rounded-t-xl px-4 py-4 transition-colors sm:flex-nowrap sm:px-7 sm:py-5 hover:bg-paper/50 ${open ? "" : "rounded-b-xl"}`}
      >
        <button
          onClick={toggle}
          aria-expanded={open}
          aria-label={`${open ? "Collapse" : "Expand"} ${name}`}
          className="absolute inset-0 z-0"
        />
        {selectForm && (
          <span className="pointer-events-auto relative z-10">
            <RowCheck form={selectForm} name="clientId" value={clientId} label={name} />
          </span>
        )}
        <div className="pointer-events-none relative min-w-0 flex-1">
          <h2 className="text-[17px] font-semibold tracking-tight">{name}</h2>
          <p className="mt-1 text-[12.5px] text-ink-soft">
            {industry}
            {contactTitle && ` · ${contactTitle}`}
          </p>
        </div>

        {canDelete && (
          <div className="pointer-events-auto relative z-10">
            <ClientDeleteButton clientId={clientId} name={name} openingCount={openings.length} />
          </div>
        )}

        {/*
          One grid, sized to the widest LABEL rather than to the numbers.

          The previous version set column widths from the figures — 74px each —
          and the labels underneath are far wider than that, so "Open", "All
          time" and "In progress" overflowed their cells and ran together into
          "OPENALL TIME IN PROGRESS". The label is the wider of the two things
          in the column, so the label has to set the width.
        */}
        <div className="pointer-events-none relative order-last w-full shrink-0 items-baseline text-left sm:order-none sm:w-auto sm:text-right" style={STAT_COLS}>
          {([
            [String(openCount), "Open"],
            [String(allTime), "All time"],
            [value, "In progress"],
          ] as const).map(([n, l]) => (
            <div key={l} className="px-2">
              <div className="tabular whitespace-nowrap text-[17px] font-semibold leading-none">{n}</div>
              <div className="mt-1.5 whitespace-nowrap text-[11px] text-ink-faint">{l}</div>
            </div>
          ))}
        </div>

        {/*
          Chevron and menu in one fixed slot at the trailing edge.
          They were separate children of a wrapping, space-between row, which
          is why the three dots ended up floating on their own halfway across
          the card with nothing near them. TRAILING_W is the same width the
          opening rows reserve, so the number columns line up.
        */}
        <div className="flex shrink-0 items-center justify-end gap-2" style={TRAILING}>
          <svg
            width={16}
            height={16}
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="pointer-events-none relative shrink-0 text-ink-faint"
          >
            <path
              d={open ? "M4 10L8 6L12 10" : "M4 6L8 10L12 6"}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>

          <div className="pointer-events-auto relative z-10">
          <ClientMenu
            clientId={clientId}
            name={name}
            industry={industry}
            status={status}
            esaSignedAt={esaSignedAt}
            contacts={contacts}
            openingCount={openings.length}
            canDelete={canDelete}
            onPane={setPane}
            pane={pane}
          />
        </div>
        </div>
      </div>

      {pane && (
        <ClientEditor
          clientId={clientId}
          name={name}
          industry={industry}
          status={status}
          esaSignedAt={esaSignedAt}
          researchNotes={researchNotes}
          contacts={contacts}
          pane={pane}
          onClose={() => setPane(null)}
        />
      )}

      {open &&
        (openings.length === 0 ? (
          <p className="border-t border-rule px-4 py-8 text-[13px] text-ink-faint sm:px-7">
            No openings yet.
          </p>
        ) : (
          <div className="divide-y divide-rule border-t border-rule">
            {openings.map((o) => (
              <Link
                key={o.id}
                href={`/openings/${o.id}`}
                className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-4 hover:bg-paper/60 sm:flex-nowrap sm:px-7"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2.5">
                    <span className="text-[14px] font-medium">{o.title}</span>
                    <span className="text-[11px] text-ink-faint">{o.priorityTier}</span>
                    {o.status !== "open" && (
                      <span className="rounded bg-tag px-1.5 py-px text-[11px] text-ink-soft">
                        {o.status.replace("_", " ")}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-[12px] text-ink-faint">
                    {o.locations.join(", ")} · {o.taNames.join(", ")}
                  </p>
                </div>
                {/* The same three columns as the client row above, so the
                    numbers line up down the card. */}
                <div className="w-full shrink-0 items-baseline text-left sm:w-auto sm:text-right" style={STAT_COLS}>
                  <span className="px-2">
                    <span className="tabular block whitespace-nowrap text-[14px]">{o.followUp}</span>
                    <span className="mt-1 block whitespace-nowrap text-[11px] text-ink-faint">Follow-up</span>
                  </span>
                  <span className="px-2">
                    <span className="tabular block whitespace-nowrap text-[14px]">{o.setsClosed}</span>
                    <span className="mt-1 block whitespace-nowrap text-[11px] text-ink-faint">Sets</span>
                  </span>
                  <span className="px-2">
                    <span
                      className={`tabular block whitespace-nowrap text-[14px] ${o.days > o.target ? "text-danger" : ""}`}
                    >
                      {o.days} of {o.target}
                    </span>
                    <span className="mt-1 block whitespace-nowrap text-[11px] text-ink-faint">Days</span>
                  </span>
                </div>
                <span className="hidden shrink-0 sm:block" style={TRAILING} aria-hidden="true" />
              </Link>
            ))}
          </div>
        ))}
    </section>
  );
}
