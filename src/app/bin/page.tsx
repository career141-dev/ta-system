import { repo } from "@/data/store";
import type { BinItem } from "@/data/types";
import { primeStore } from "@/data/prime";
import { isConvex } from "@/data/mode";
import { binItems } from "@/data/convex/backend";
import { getCurrentUser } from "@/lib/session";
import { isDeskWide, isReadOnly } from "@/lib/auth";
import { relDays } from "@/lib/format";
import { BIN_DAYS, daysLeft, purgeDateLabel } from "@/lib/bin";
import { Confirm } from "@/components/Confirm";
import { deleteFromBinNow, restoreFromBin } from "@/app/actions";

/**
 * The Bin (28 Sep): clients and openings someone deleted, kept seven days so a
 * mistaken delete can be undone. Anyone on the desk can restore; only a lead,
 * director or admin can delete for good before the seven days are up.
 */
export default async function BinPage() {
  await primeStore();
  const user = await getCurrentUser();
  // Clients and viewers see the desk's work, not its deletes.
  if (isReadOnly(user) || user.role === "client") {
    const { notFound } = await import("next/navigation");
    notFound();
  }
  const items: BinItem[] = isConvex() ? await binItems({ id: user.id }) : repo.bin();
  const openings = items.filter((i) => i.kind === "opening");
  const clients = items.filter((i) => i.kind === "client");
  const mayPurge = isDeskWide(user);

  return (
    <main className="mx-auto max-w-[1180px] px-4 sm:px-8 py-6 sm:py-9">
      <div className="mb-8">
        <h1 className="text-[24px] font-semibold tracking-tight">Bin</h1>
        <p className="mt-1.5 text-[13px] text-ink-soft">
          Deleted clients and openings stay here for {BIN_DAYS} days, then are deleted for good. Restore
          puts one back exactly as it was. Candidates are never deleted.
        </p>
      </div>

      <Section title="Openings" empty="No openings in the Bin." rows={openings} mayPurge={mayPurge} />
      <Section title="Clients" empty="No clients in the Bin." rows={clients} mayPurge={mayPurge} />
    </main>
  );
}

function Section({ title, empty, rows, mayPurge }: { title: string; empty: string; rows: BinItem[]; mayPurge: boolean }) {
  const now = Date.now();
  return (
    <section className="mb-10">
      <h2 className="mb-3 text-[14px] font-semibold">
        {title} <span className="font-normal text-ink-faint">{rows.length}</span>
      </h2>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-rule bg-surface px-5 py-6 text-[13px] text-ink-soft">{empty}</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-rule bg-surface">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-rule text-left text-[11.5px] uppercase tracking-wide text-ink-faint">
                <th className="px-5 py-2.5 font-medium">Name</th>
                <th className="px-5 py-2.5 font-medium">Deleted</th>
                <th className="px-5 py-2.5 font-medium">Deleted for good</th>
                <th className="px-5 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const left = daysLeft(r.binnedAt, now);
                return (
                  <tr key={r.id} className="border-b border-rule last:border-0">
                    <td className="px-5 py-3">
                      <div className="font-medium">{r.name}</div>
                      {r.clientName && <div className="text-[12px] text-ink-soft">{r.clientName}</div>}
                    </td>
                    <td className="px-5 py-3 text-ink-soft">
                      {relDays(r.binnedAt)}
                      {r.binnedBy && ` by ${r.binnedBy}`}
                    </td>
                    <td className="px-5 py-3 text-ink-soft">
                      {purgeDateLabel(r.binnedAt)}{" "}
                      <span className={left <= 1 ? "text-danger" : "text-ink-faint"}>
                        ({left <= 0 ? "today" : `${left} day${left === 1 ? "" : "s"} left`})
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-3">
                        <form action={restoreFromBin}>
                          <input type="hidden" name="kind" value={r.kind} />
                          <input type="hidden" name="id" value={r.id} />
                          <button className="rounded-full border border-rule px-3 py-1 text-[12px] font-medium hover:border-brand/40 hover:text-brand">
                            Restore
                          </button>
                        </form>
                        {mayPurge && (
                          <form action={deleteFromBinNow}>
                            <input type="hidden" name="kind" value={r.kind} />
                            <input type="hidden" name="id" value={r.id} />
                            <Confirm
                              label="Delete now"
                              question={
                                r.kind === "opening"
                                  ? `Delete "${r.name}" for good now? Its pipeline, calls and messages go and cannot be restored. Its candidates stay.`
                                  : `Delete ${r.name} for good now? It cannot be restored.`
                              }
                              confirmLabel="Delete for good"
                              className="text-[12px] text-ink-soft hover:text-danger"
                            />
                          </form>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
