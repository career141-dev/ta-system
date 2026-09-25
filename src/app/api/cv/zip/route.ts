import { NextResponse, type NextRequest } from "next/server";
import { primeStore } from "@/data/prime";
import { isConvex } from "@/data/mode";
import { currentUser } from "@/lib/session";
import { repo } from "@/data/store";
import { cvBytes, mayOpenCv } from "@/lib/cvAccess";
import { cvFileName, zipStore } from "@/lib/zip";

/**
 * Several candidates' CVs as one ZIP, each named after the person (25 Sep).
 *
 * POST `{ appIds }` from a list on an opening, or `{ candidateIds }` from a
 * database search. Each one passes the same access test as opening that CV on
 * its own (lib/cvAccess); anyone refused or without a file is left out and
 * named in `X-Missing-Cvs`, so the person knows whose CV is not in it.
 *
 * ponytail: built in memory — fine for the cap below; stream it if people need
 * whole shortlists of hundreds.
 */
const MAX = 100;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { appIds?: unknown; candidateIds?: unknown } | null;
  const list = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === "string" && x.length > 0))] : []);
  const appIds = list(body?.appIds);
  const candidateIds = list(body?.candidateIds);
  const count = appIds.length + candidateIds.length;
  if (count === 0) return text("Tick at least one candidate.", 400);
  if (count > MAX) return text(`Download at most ${MAX} CVs at a time — ${count} are ticked.`, 400);

  await primeStore(appIds.length ? { allApplications: true, candidateIds } : { candidateIds });
  // The people behind the applications, for their names.
  const viaApps = appIds.map((id) => repo.application(id)?.candidateId).filter((id): id is string => !!id && !repo.candidate(id));
  if (viaApps.length) await primeStore({ candidateIds: viaApps });
  const user = await currentUser();
  if (!user) return text("Sign in to download CVs.", 401);
  if (!isConvex()) return text("CV files are held by the candidate database, which this build is not connected to.", 404);

  // Each wanted CV as (candidate, the application it was reached through).
  const wanted = [
    ...appIds.map((appId) => ({ candidateId: repo.application(appId)?.candidateId ?? "", appId })),
    ...candidateIds.map((candidateId) => ({ candidateId, appId: null as string | null })),
  ];

  const used = new Set<string>();
  const files: { name: string; data: Uint8Array }[] = [];
  const missing: string[] = [];
  // A few at a time: fast enough for a shortlist, gentle on the storage.
  for (let i = 0; i < wanted.length; i += 6) {
    const batch = await Promise.all(
      wanted.slice(i, i + 6).map(async (w) => {
        const name = repo.candidate(w.candidateId)?.fullName?.trim() || "Unnamed candidate";
        if (!w.candidateId || !mayOpenCv(user, w.candidateId, w.appId)) return { name, cv: null };
        const cv = await cvBytes(w.candidateId).catch(() => null);
        return { name, cv: cv?.ok ? cv : null };
      }),
    );
    for (const { name, cv } of batch) {
      if (cv) files.push({ name: cvFileName(name, cv.fileName, used), data: cv.bytes });
      else missing.push(name);
    }
  }

  if (files.length === 0) {
    return text(`None of the selected people has a CV that can be downloaded${missing.length ? `: ${missing.join(", ")}` : ""}.`, 404);
  }
  return new NextResponse(new Uint8Array(zipStore(files)), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="CVs.zip"`,
      "Cache-Control": "private, no-store",
      "X-Cv-Count": String(files.length),
      "X-Missing-Cvs": encodeURIComponent(JSON.stringify(missing)),
    },
  });
}

function text(message: string, status: number) {
  return new NextResponse(message, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
