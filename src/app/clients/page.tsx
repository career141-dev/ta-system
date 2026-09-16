import Link from "next/link";
import { repo, stageCounts, setsForOpening } from "@/data/store";
import { PRIORITY_TARGET } from "@/data/types";
import { relDays } from "@/lib/format";
import { AddClient } from "@/components/AddClient";
import { ClientCard } from "@/components/ClientCard";
import { pageUser } from "@/lib/session";
import { primeStore } from "@/data/prime";
import { can } from "@/lib/auth";

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<{ held?: string }>;
}) {
  const { held } = await searchParams;
  await primeStore({ allApplications: true });
  const user = await pageUser("database.read");
  const clients = repo.clients();
  const openings = repo.openings();
  const users = repo.users();

  return (
    <main className="mx-auto max-w-[1180px] px-8 py-9">
      <div className="mb-8 flex items-end justify-between gap-6">
        <div>
          <h1 className="text-[24px] font-semibold tracking-tight">Clients</h1>
          <p className="mt-1.5 text-[13px] text-ink-soft">
            Business terms and contacts live here. Hiring assignments sit under each one.
          </p>
        </div>
        <div className="flex items-center gap-4">
          {can(user, "client.manage").ok && (
          <AddClient
            tas={users
              .filter((u) => u.isActive && (u.role === "ta" || u.role === "ta_lead" || u.role === "admin"))
              .sort((a, b) => a.name.localeCompare(b.name))}
            isLead={user.role === "ta_lead" || user.role === "admin"}
            canCreateOpening={can(user, "opening.create").ok}
          />
          )}
        </div>
      </div>

      {/* A refused delete says why rather than looking like a dead button. */}
      {held && (
        <p className="mb-6 rounded-xl border border-warn/35 bg-warn-soft px-5 py-3 text-[12.5px] text-warn">
          That client still has {held} opening{held === "1" ? "" : "s"} filed under it. Move or
          delete those first — deleting the client would take their candidates and outreach
          history with them.
        </p>
      )}

      <div className="flex flex-col gap-6">
        {clients.map((c) => {
          const mine = openings.filter((o) => o.clientId === c.id);
          const open = mine.filter((o) => o.status === "open");
          const value = mine.reduce((n, o) => n + (o.valueOnProgressing ?? 0), 0);
          const contact = c.contacts.find((x) => x.isPrimary);

          return (
            <ClientCard
              key={c.id}
              clientId={c.id}
              name={c.name}
              status={c.status}
              esaSignedAt={c.esaSignedAt}
              contacts={c.contacts}
              canDelete={user.role !== "ta"}
              industry={c.industry}
              contactTitle={contact?.title ?? null}
              openCount={open.length}
              allTime={mine.length}
              value={value ? `LKR ${(value / 1000).toFixed(0)}k` : "—"}
              openings={mine.map((o) => {
                const counts = stageCounts(o.id);
                return {
                  id: o.id,
                  title: o.title,
                  priorityTier: o.priorityTier,
                  status: o.status,
                  locations: o.locations,
                  taNames: o.assignedTaIds.map((t) => users.find((u) => u.id === t)?.name ?? "—"),
                  followUp: counts.follow_up ?? 0,
                  setsClosed: setsForOpening(o.id).filter((x) => x.status === "closed").length,
                  days: Math.floor((Date.now() - (o.assignedAt ?? Date.now())) / 86_400_000),
                  target: PRIORITY_TARGET[o.priorityTier].days,
                };
              })}
            />
          );
        })}
      </div>
    </main>
  );
}
