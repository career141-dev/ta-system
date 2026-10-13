import { repo } from "@/data/store";
import type { User } from "@/data/types";
import { can, isDeskWide, seesEveryTaRow } from "@/lib/auth";
import { visibleEyeMarked } from "@/lib/eyeMarkedStore";
import { interestOf } from "@/lib/linkViews";
import { LinkRow } from "./LinkRow";
import { HhUpload } from "./HhUpload";

export function EyeMarkedSection({ openingId, user }: { openingId: string; user: User }) {
  const { rows, items } = visibleEyeMarked(openingId, user);
  const names = Object.fromEntries(repo.users().map((u) => [u.id, u.name]));
  const desk = new Set(repo.users().filter(isDeskWide).map((u) => u.id));
  return (
    <section id="eye-marked" className="mt-9 scroll-mt-24">
      <h2 className="text-[15px] font-semibold">Eye-marked <span className="text-ink-faint">{rows.length}</span></h2>
      <p className="mb-4 mt-2 text-[13px] text-ink-soft">
        Call these candidates and request their CVs. Once received, add them to TA Follow-up and prepare them for Director Review.
        Contacted candidates waiting for a CV remain pending and do not block the end-of-day email.
      </p>
      {can(user, "opening.act", { assignment: repo.assignmentFor(openingId, user.id) ?? null }).ok && <HhUpload openingId={openingId} />}
      {rows.length === 0 ? <p className="text-[13px] text-ink-faint">Eye-mark a profile in Excel Tables to see it here.</p> : (
        <div className="divide-y divide-rule overflow-hidden rounded-xl border border-rule bg-surface">
          {rows.map((row, index) => {
            const item = items[index];
            const app = item.applicationId ? repo.application(item.applicationId) : null;
            return (
              <div key={row.id} id={`eye-${row.id}`} className="scroll-mt-24">
                <p className={`px-5 pt-4 text-[12.5px] font-medium ${item.blocked ? "text-warn" : "text-ink-soft"}`}>{item.status}</p>
                <LinkRow entry={row} openingId={openingId} addedByName={names[row.addedBy] ?? "—"}
                  userNames={names} onPipeline={app} interest={interestOf(row, app)} viewerId={user.id}
                  canNote={can(user, "link.note").ok}
                  readOnly={seesEveryTaRow(user) && row.addedBy !== user.id && !desk.has(row.addedBy)} />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
