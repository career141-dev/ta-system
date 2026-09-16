"use client";

import { useCallback, useState } from "react";
import { NewClientDialog } from "./NewClientDialog";
import type { User } from "@/data/types";

/**
 * Adding a client — spec §4.1.
 *
 * Closed until asked for: a TA reads the Clients page every day and adds to it
 * once a month. Opens a pop-up that saves the client and, where the person may
 * create openings, carries straight on into the first opening for them.
 */
export function AddClient({
  tas,
  isLead,
  canCreateOpening,
}: {
  tas: User[];
  isLead: boolean;
  canCreateOpening: boolean;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-full border border-brand-line px-4 py-2 text-[13px] font-medium text-brand transition-colors hover:bg-brand-soft"
      >
        <span className="text-[15px] leading-none">+</span>
        Add a client
      </button>
      {open && <NewClientDialog onClose={close} withOpening={canCreateOpening} tas={tas} isLead={isLead} />}
    </>
  );
}
