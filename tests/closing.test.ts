import { feeFor, guaranteeFor, esaStanding, placementTasks, placementStanding } from "@/lib/closing";
import type { EsaRecord, Placement } from "@/data/types";

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log(`${ok ? "  ok  " : "  FAIL"} ${l}${ok ? "" : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
};
const DAY = 86_400_000;
const now = new Date(2026, 8, 14, 11, 0).getTime(); // Mon 14 Sep 2026

console.log("\nfee — monthly salaries, annual fees");
const f1 = feeFor({ salary: 850_000, salaryBasis: "monthly", currency: "LKR", feePercent: 12, flatFee: null });
eq("12% of 850k/month", f1.amount, 1_224_000);
eq("basis is annualised", f1.basisAmount, 10_200_000);
eq("workings show the ×12", /× 12/.test(f1.workings), true);
const f2 = feeFor({ salary: 10_200_000, salaryBasis: "annual", currency: "LKR", feePercent: 12, flatFee: null });
eq("annual basis gives the same fee", f2.amount, f1.amount);
eq("annual basis does not claim a ×12", /× 12/.test(f2.workings), false);
const f3 = feeFor({ salary: 850_000, salaryBasis: "monthly", currency: "LKR", feePercent: 12, flatFee: 900_000 });
eq("flat fee wins over the rate", [f3.amount, f3.flat], [900_000, true]);

console.log("\nguarantee");
const base: Placement = {
  id: "pl1", offerId: "of1", applicationId: "a1", openingId: "o1", candidateId: "c1",
  clientId: "cl1", placedBy: "u1", sourcingChannel: "HH",
  salary: 850_000, salaryBasis: "monthly", currency: "LKR",
  joinDate: now - 30 * DAY, joinConfirmedAt: now - 30 * DAY,
  feePercent: 12, flatFee: null,
  invoiceSentAt: now - 28 * DAY, invoiceNumber: "INV-1", invoicePaidAt: now - 10 * DAY,
  guaranteeDays: 90, fellThroughAt: null, fellThroughReason: null,
  notes: null, createdAt: now - 40 * DAY,
};
eq("30 days in on a 90-day guarantee → running", guaranteeFor(base, now).state, "running");
eq("60 days left", guaranteeFor(base, now).daysLeft, 60);
eq("80 days in → ending soon", guaranteeFor({ ...base, joinDate: now - 80 * DAY }, now).state, "ending_soon");
eq("91 days in → passed", guaranteeFor({ ...base, joinDate: now - 91 * DAY }, now).state, "passed");
eq("passed says the fee is safe", /safe/.test(guaranteeFor({ ...base, joinDate: now - 91 * DAY }, now).note), true);
eq("not started", guaranteeFor({ ...base, joinDate: now + 10 * DAY }, now).state, "not_started");
const broke = guaranteeFor({ ...base, fellThroughAt: now - 5 * DAY }, now);
eq("left inside → broken, fee repayable", [broke.state, /repayable|re-run/.test(broke.note)], ["broken", true]);
const late = guaranteeFor({ ...base, joinDate: now - 200 * DAY, fellThroughAt: now - 5 * DAY }, now);
eq("left after the window → fee stands", /fee stands/.test(late.note), true);

console.log("\nESA");
const esa: EsaRecord = {
  id: "e1", clientId: "cl1", openingId: null, status: "sent", feePercent: 12,
  guaranteeDays: 90, sentAt: now - 20 * DAY, signedAt: null, signedBy: null,
  dueAt: now - 7 * DAY, documentName: null, notes: null, createdAt: now - 20 * DAY,
};
const od = esaStanding(esa, now);
eq("sent, past due → overdue", od.state, "overdue");
eq("counted in working days, not calendar", od.overdueBy, 5);
eq("overdue is not collectable", od.collectable, false);
eq("signed is collectable", esaStanding({ ...esa, status: "signed" }, now).collectable, true);
eq("not required is collectable", esaStanding({ ...esa, status: "not_required" }, now).collectable, true);
eq("expired is not", esaStanding({ ...esa, status: "expired" }, now).collectable, false);
eq("within the date → awaiting", esaStanding({ ...esa, dueAt: now + 3 * DAY }, now).state, "awaiting");

console.log("\nwhat needs doing");
const tasks = (p: Partial<Placement>, e: EsaRecord | null = null) =>
  placementTasks({ ...base, ...p }, e ? esaStanding(e, now) : null, now).map((t) => t.key);
eq("all settled → nothing", tasks({}), []);
eq("join date passed, unconfirmed", tasks({ joinConfirmedAt: null, joinDate: now - 5 * DAY }), ["confirm_join"]);
eq("started but never invoiced", tasks({ invoiceSentAt: null, invoicePaidAt: null }), ["send_invoice"]);
eq("invoice out 45 days", tasks({ invoicePaidAt: null, invoiceSentAt: now - 45 * DAY }), ["chase_payment"]);
eq("guarantee closing", tasks({ joinDate: now - 80 * DAY }), ["guarantee_check"]);
eq("no signed agreement is first and urgent",
  placementTasks(base, esaStanding(esa, now), now)[0].key, "no_agreement");
eq("the case the live system cannot see: joined, uninvoiced, guarantee closing",
  tasks({ joinDate: now - 80 * DAY, joinConfirmedAt: now - 80 * DAY, invoiceSentAt: null, invoicePaidAt: null }),
  ["send_invoice", "guarantee_check"]);

console.log("\nfell through — the money, not the chase");
eq("fallen through raises no forward work",
  tasks({ fellThroughAt: now - 2 * DAY, joinConfirmedAt: null, invoiceSentAt: null, invoicePaidAt: null }, esa), []);
eq("invoiced then collapsed inside the guarantee → credit it",
  tasks({ fellThroughAt: now - 2 * DAY, invoicePaidAt: null }), ["credit_invoice"]);
eq("paid then collapsed inside the guarantee → refund owed",
  tasks({ fellThroughAt: now - 2 * DAY }), ["refund_due"]);
eq("left after the guarantee closed → nothing owed back",
  tasks({ joinDate: now - 200 * DAY, fellThroughAt: now - 2 * DAY }), []);

console.log("\nstanding");
eq("settled", placementStanding({ ...base, joinDate: now - 91 * DAY }, now), "Closed");
eq("unconfirmed", placementStanding({ ...base, joinConfirmedAt: null }, now), "Join unconfirmed");
eq("fell through", placementStanding({ ...base, fellThroughAt: now }, now), "Fell through");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
