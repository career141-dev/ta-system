import Link from "next/link";
import type { Opening, User } from "@/data/types";
import { repo } from "@/data/store";
import { isTa, must } from "@/lib/auth";
import { effortRow } from "@/lib/eod";
import { effortColumns, type EffortRow } from "@/lib/eod-format";
import { convexQuery } from "@/lib/convexServer";
import { isConvex } from "@/data/mode";
import { workdayDate } from "@/lib/workday";
import { DAILY_EMAIL_LABEL } from "@/lib/dailyEmail";
import type { SupportEodPage } from "@/lib/supportEod";

function EffortReadOnly({ effort }: { effort: EffortRow }) {
  const columns = effortColumns(effort.hundredOrFollowUp);
  return <div className="overflow-x-auto"><table className="w-full text-left text-xs">
    <thead><tr>{columns.map(c => <th key={c.key} className="whitespace-nowrap border border-rule p-2">{c.label}</th>)}</tr></thead>
    <tbody><tr>{columns.map(c => <td key={c.key} className="whitespace-nowrap border border-rule p-2">{effort[c.key as keyof EffortRow] == null ? "—" : String(effort[c.key as keyof EffortRow])}</td>)}</tr>
      {effort.targets && Object.keys(effort.targets).length > 0 && <tr>{columns.map((c, i) => <td key={c.key} className="border border-rule p-2">{i === 0 ? "Target" : String(effort.targets?.[c.key as keyof typeof effort.targets] ?? "")}</td>)}</tr>}
    </tbody>
  </table></div>;
}

export async function SupportEodView({ opening, user, taId, date, cursor }: {
  opening: Opening; user: User; taId?: string; date: string; cursor?: string;
}) {
  must(user, "tables.readAll");
  const users = repo.users();
  const names = new Map(users.map(u => [u.id, u.name]));
  const actorIds = new Set([...opening.assignedTaIds, ...repo.linkVault(opening.id).map(r => r.addedBy)]);
  const tas = users.filter(u => isTa(u) && (taId ? u.id === taId : actorIds.has(u.id)));
  const locations = opening.workLocations?.length ? [{ id: "", name: "Unassigned location" }, ...opening.workLocations] : [{ id: "", name: "" }];
  let saved: SupportEodPage | null = null;
  let failed = false;
  if (isConvex()) {
    try { saved = await convexQuery<SupportEodPage>("ta/supportViews:eod", { actorId: user.id, jobId: opening.id, date, taId: taId || undefined, cursor: cursor || undefined }); }
    catch { failed = true; }
  }
  const href = (nextCursor = "") => `/support-tables?${new URLSearchParams({ position: opening.id, view: "eod", date, ...(taId ? { ta: taId } : {}), ...(nextCursor ? { cursor: nextCursor } : {}) })}`;
  return <div className="space-y-6">
    {date === workdayDate(Date.now()) && <section className="space-y-3">
      <h3 className="font-semibold">Today’s calculated L-sheet effort</h3>
      <p className="text-sm text-ink-soft">Calculated from saved activity using the EOD page’s rules. Counts edited in a submitted email appear in its saved copy below.</p>
      {!tas.length && <p>No TA activity or assignment was found for this selection.</p>}
      {tas.flatMap(ta => locations.map(location => <div key={`${ta.id}:${location.id}`} className="space-y-2 rounded-lg border border-rule p-3">
        <h4 className="font-medium">{ta.name}{location.name ? ` · ${location.name}` : ""}</h4>
        <EffortReadOnly effort={effortRow(opening.id, ta, new Date(), location.id)} />
      </div>))}
    </section>}
    <section className="space-y-3"><h3 className="font-semibold">Saved EOD emails · {date}</h3>
      {failed ? <p role="alert">Could not load saved EOD emails. <Link href={href()} className="text-brand underline">Retry</Link></p>
        : !saved?.emails.length ? <p>No saved EOD emails were found for this selection.</p> : saved.emails.map(email => <details key={email.id} className="rounded-lg border border-rule p-3">
          <summary className="cursor-pointer font-medium">{names.get(email.userId) ?? "Unavailable user"} · {email.workLocationName ?? "Position"} · {DAILY_EMAIL_LABEL[email.status]} · Revision {email.revision}</summary>
          <div className="mt-3 space-y-3">{email.effort && <EffortReadOnly effort={email.effort} />}
            {email.html ? <iframe title={`EOD: ${names.get(email.userId) ?? "TA"} ${email.date} revision ${email.revision}`} sandbox="" referrerPolicy="no-referrer"
              srcDoc={`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><body style="font-family:Arial,sans-serif;padding:16px">${email.html}`}
              className="h-[560px] w-full bg-white" /> : <p>The saved content is no longer retained, or this email has no saved preview.</p>}
          </div>
        </details>)}
      <div className="flex gap-4 text-sm">{cursor && <Link href={href()} className="text-brand underline">Latest emails</Link>}{saved?.nextCursor && <Link href={href(saved.nextCursor)} className="text-brand underline">More emails</Link>}</div>
    </section>
  </div>;
}
