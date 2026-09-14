/**
 * The commercial end of a placement: what the fee is, whether it is safe yet,
 * and whether there is paper behind it.
 *
 * The live system holds offers, placements and ESA records, but only as
 * bookkeeping — `invoiceAmount` is a bare number, `joinDate` is a string, and
 * nothing anywhere records when a guarantee period ends. That last one is the
 * gap that costs money: every fee on this desk is repayable if the candidate
 * leaves inside the guarantee, which is exactly why `placed` is not a terminal
 * stage in this platform's pipeline, and nothing in the live schema can tell
 * you which placements are still exposed.
 *
 * Pure module: no store, no I/O. Everything is derived from the records and a
 * clock, so none of it can go stale — the same rule the SLA alerts follow.
 */

import type { EsaRecord, Placement, SalaryBasis } from "@/data/types";
import { annualise } from "@/data/types";
import { isWorkingDay } from "./calendar";

const DAY = 86_400_000;

/** What the desk falls back on when a client has no agreed terms on file.
 *  Shown as a default everywhere it is used, never quietly applied as fact. */
export const DEFAULT_FEE_PERCENT = 12;
export const DEFAULT_GUARANTEE_DAYS = 90;

// ───────────────────────────────────────────────────────────────────── fee ──

export interface Fee {
  amount: number;
  currency: string;
  /** The annual figure the percentage was taken on. */
  basisAmount: number;
  /** How it was arrived at, in words, so an invoice can be checked rather than
   *  trusted. */
  workings: string;
  /** True when the fee was agreed as a lump rather than a rate. */
  flat: boolean;
}

/**
 * Fee from the placed salary.
 *
 * Salaries on this desk are quoted monthly and fees are charged on the year,
 * which is a twelve-times error waiting to happen. The basis travels with the
 * number so the multiplication happens once, here, where it can be seen.
 */
export function feeFor(p: {
  salary: number;
  salaryBasis: SalaryBasis;
  currency: string;
  feePercent: number | null;
  flatFee: number | null;
}): Fee {
  const basisAmount = annualise(p.salary, p.salaryBasis);
  if (p.flatFee !== null) {
    return {
      amount: p.flatFee,
      currency: p.currency,
      basisAmount,
      workings: `Flat fee agreed — ${p.currency} ${p.flatFee.toLocaleString()}`,
      flat: true,
    };
  }
  const pct = p.feePercent ?? DEFAULT_FEE_PERCENT;
  const amount = Math.round((basisAmount * pct) / 100);
  return {
    amount,
    currency: p.currency,
    basisAmount,
    workings:
      `${pct}% of ${p.currency} ${basisAmount.toLocaleString()} a year` +
      (p.salaryBasis === "monthly"
        ? ` (${p.currency} ${p.salary.toLocaleString()} a month × 12)`
        : ""),
    flat: false,
  };
}

// ─────────────────────────────────────────────────────────────── guarantee ──

export type GuaranteeState =
  | "not_started" // join date has not come round yet
  | "running" // inside the window, fee still repayable
  | "ending_soon" // inside the window with two weeks or less to go
  | "passed" // window closed, fee is safe
  | "broken"; // they left inside it

export interface Guarantee {
  state: GuaranteeState;
  endsAt: number;
  daysLeft: number;
  /** What it means for the money, said plainly. */
  note: string;
}

const ENDING_SOON_DAYS = 14;

export function guaranteeFor(p: Placement, now = Date.now()): Guarantee {
  const endsAt = p.joinDate + p.guaranteeDays * DAY;
  const daysLeft = Math.ceil((endsAt - now) / DAY);

  if (p.fellThroughAt) {
    const inside = p.fellThroughAt <= endsAt;
    return {
      state: "broken",
      endsAt,
      daysLeft: 0,
      note: inside
        ? `Left inside the ${p.guaranteeDays}-day guarantee — the fee is repayable or the role is re-run.`
        : `Left after the guarantee closed. The fee stands.`,
    };
  }
  if (now < p.joinDate) {
    return {
      state: "not_started",
      endsAt,
      daysLeft: p.guaranteeDays,
      note: `The ${p.guaranteeDays} days start on the join date.`,
    };
  }
  if (daysLeft <= 0) {
    return { state: "passed", endsAt, daysLeft: 0, note: "Guarantee passed. The fee is safe." };
  }
  if (daysLeft <= ENDING_SOON_DAYS) {
    return {
      state: "ending_soon",
      endsAt,
      daysLeft,
      note: `${daysLeft} ${daysLeft === 1 ? "day" : "days"} of guarantee left. Worth a check-in call.`,
    };
  }
  return {
    state: "running",
    endsAt,
    daysLeft,
    note: `${daysLeft} days of guarantee left — the fee is still repayable.`,
  };
}

// ────────────────────────────────────────────────────────────────── the ESA ──

export type EsaState = "not_required" | "draft" | "awaiting" | "overdue" | "signed" | "expired";

export interface EsaStanding {
  state: EsaState;
  /** Working days past the due date. Zero unless overdue. */
  overdueBy: number;
  note: string;
  /** Whether a fee raised under this agreement is on solid ground. */
  collectable: boolean;
}

/**
 * Where an agreement stands.
 *
 * Breach is worked out here rather than stored. The live table keeps a
 * `slaBreached` boolean, which is only true until somebody signs and nobody
 * clears the flag.
 */
export function esaStanding(e: EsaRecord, now = Date.now()): EsaStanding {
  if (e.status === "not_required") {
    return {
      state: "not_required",
      overdueBy: 0,
      note: "No agreement needed for this client.",
      collectable: true,
    };
  }
  if (e.status === "signed") {
    return { state: "signed", overdueBy: 0, note: "Signed and on file.", collectable: true };
  }
  if (e.status === "expired") {
    return {
      state: "expired",
      overdueBy: 0,
      note: "Lapsed. A new agreement is needed before the next placement.",
      collectable: false,
    };
  }
  if (e.status === "draft") {
    return {
      state: "draft",
      overdueBy: 0,
      note: "Drafted, not sent.",
      collectable: false,
    };
  }
  // Sent, and waiting.
  if (e.dueAt && now > e.dueAt) {
    let days = 0;
    const cursor = new Date(e.dueAt);
    while (cursor.getTime() < now) {
      cursor.setDate(cursor.getDate() + 1);
      if (isWorkingDay(cursor)) days++;
    }
    return {
      state: "overdue",
      overdueBy: days,
      note: `Sent and unsigned, ${days} working ${days === 1 ? "day" : "days"} past the date it was due back.`,
      collectable: false,
    };
  }
  return {
    state: "awaiting",
    overdueBy: 0,
    note: "Sent, waiting on signature.",
    collectable: false,
  };
}

// ──────────────────────────────────────────────── what needs doing about it ──

export interface PlacementTask {
  key:
    | "confirm_join"
    | "send_invoice"
    | "chase_payment"
    | "guarantee_check"
    | "no_agreement"
    | "credit_invoice"
    | "refund_due";
  label: string;
  urgent: boolean;
}

/** Days after which an unpaid invoice is worth chasing. */
const PAYMENT_TERMS_DAYS = 30;

/**
 * The open items on one placement, in the order they cost something.
 *
 * This is the list nothing in the live system produces: it holds each of these
 * facts in a column but never asks them together, so a placement that joined,
 * was never invoiced, and is three weeks from its guarantee closing looks
 * exactly like one that is finished.
 */
export function placementTasks(
  p: Placement,
  esa: EsaStanding | null,
  now = Date.now(),
): PlacementTask[] {
  const out: PlacementTask[] = [];
  const g = guaranteeFor(p, now);

  // A placement that has collapsed needs none of the forward work — chasing a
  // signature for a fee that is no longer owed is noise, and noise is what
  // stops a list like this being read. What it DOES need is the money put
  // right, which is the one case nothing in the live system can see: the fee
  // was billed or banked, and then the candidate left inside the guarantee.
  if (p.fellThroughAt) {
    if (g.state === "broken" && p.fellThroughAt <= g.endsAt) {
      if (p.invoicePaidAt) {
        out.push({
          key: "refund_due",
          label: "Fee already paid and they left inside the guarantee — a refund or a free re-run is owed",
          urgent: true,
        });
      } else if (p.invoiceSentAt) {
        out.push({
          key: "credit_invoice",
          label: "Invoiced, then they left inside the guarantee — the invoice needs crediting",
          urgent: true,
        });
      }
    }
    return out;
  }

  if (esa && !esa.collectable) {
    out.push({
      key: "no_agreement",
      label: `No signed agreement behind this fee — ${esa.note.toLowerCase()}`,
      urgent: true,
    });
  }
  if (!p.joinConfirmedAt && now >= p.joinDate) {
    const late = Math.floor((now - p.joinDate) / DAY);
    out.push({
      key: "confirm_join",
      label:
        late > 0
          ? `Join date was ${late} ${late === 1 ? "day" : "days"} ago and nobody has confirmed they started`
          : "Confirm they started",
      urgent: late >= 3,
    });
  }
  if (!p.invoiceSentAt && p.joinConfirmedAt) {
    out.push({ key: "send_invoice", label: "Started, not invoiced", urgent: true });
  }
  if (p.invoiceSentAt && !p.invoicePaidAt) {
    const age = Math.floor((now - p.invoiceSentAt) / DAY);
    if (age > PAYMENT_TERMS_DAYS) {
      out.push({
        key: "chase_payment",
        label: `Invoice unpaid after ${age} days`,
        urgent: age > PAYMENT_TERMS_DAYS * 2,
      });
    }
  }
  if (g.state === "ending_soon") {
    out.push({ key: "guarantee_check", label: g.note, urgent: false });
  }
  return out;
}

/** One line describing where a placement has got to, for a list. */
export function placementStanding(p: Placement, now = Date.now()): string {
  if (p.fellThroughAt) return "Fell through";
  if (!p.joinConfirmedAt) return now >= p.joinDate ? "Join unconfirmed" : "Awaiting start";
  if (!p.invoiceSentAt) return "Not invoiced";
  if (!p.invoicePaidAt) return "Invoice out";
  const g = guaranteeFor(p, now);
  return g.state === "passed" ? "Closed" : "Paid, in guarantee";
}
