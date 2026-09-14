/**
 * Reading the current system's CVs over the read-only link: a check that only
 * reports, and a sync that copies into this build (13 September). Neither
 * writes to the current system — the client they use cannot.
 */
import { repo } from "@/data/store";
import { candidateEmbedText, cosine, ensureVectors, forgetLiveVectors, putLiveVectors } from "@/lib/embed";
import { READ_FUNCTIONS, type ReadOnlyConvex } from "./readOnlyConvex";
import { liveId, mapCandidate, textSource, type LiveCandidate, type LiveResume } from "./mapLive";

type Page = { page: LiveResume[]; isDone: boolean; continueCursor: string | null };

/** Pages through CVs that have a vector, oldest cursor first, until done or `maxPages`. */
export async function* resumePages(client: ReadOnlyConvex, pageSize: number, maxPages: number) {
  let cursor: string | null = null;
  for (let n = 0; n < maxPages; n++) {
    const r: Page = await client.query(READ_FUNCTIONS.resumesPage, { limit: pageSize, cursor });
    yield r.page ?? [];
    if (r.isDone || !r.continueCursor) return;
    cursor = r.continueCursor;
  }
}

export interface CheckReport {
  resumesRead: number;
  pages: number;
  requests: number;
  complete: boolean;
  text: { inDatabase: number; onlyInR2: number; none: number };
  vectorWidths: Record<string, number>;
  /** Groups of CVs sharing exactly the same vector — the placeholder shows up as the largest. */
  identicalVectorGroups: { size: number; exampleHasText: boolean }[];
  cvsInIdenticalGroups: number;
  placeholder: { checked: boolean; matches: number };
  sameModel: { checked: number; agree: number; disagree: number; lowest: number | null };
  sampleCandidates: { read: number; withTitle: number; withSkills: number; withHistory: number };
}

export type EmbedFn = (texts: string[]) => Promise<Float32Array[] | null>;

/**
 * Reads CVs and reports — nothing is stored. With `embed` (the same model the
 * live system uses) it also tells whether stored vectors really came from that
 * model, and how many are the empty-CV placeholder.
 */
export async function checkLive(
  client: ReadOnlyConvex,
  opts: { pageSize?: number; maxPages?: number; embed?: EmbedFn; sameModelSample?: number } = {},
): Promise<CheckReport> {
  const pageSize = opts.pageSize ?? 25;
  const maxPages = opts.maxPages ?? 40;
  const report: CheckReport = {
    resumesRead: 0, pages: 0, requests: 0, complete: false,
    text: { inDatabase: 0, onlyInR2: 0, none: 0 },
    vectorWidths: {},
    identicalVectorGroups: [],
    cvsInIdenticalGroups: 0,
    placeholder: { checked: false, matches: 0 },
    sameModel: { checked: 0, agree: 0, disagree: 0, lowest: null },
    sampleCandidates: { read: 0, withTitle: 0, withSkills: 0, withHistory: 0 },
  };
  const groups = new Map<string, { size: number; exampleHasText: boolean }>();
  const placeholderRef = opts.embed ? (await opts.embed(["Empty resume profile placeholder"]))?.[0] ?? null : null;
  report.placeholder.checked = Boolean(placeholderRef);
  const toCompare: { text: string; vector: number[] }[] = [];

  let lastPageFull = true;
  for await (const page of resumePages(client, pageSize, maxPages)) {
    report.pages++;
    lastPageFull = page.length === pageSize;
    for (const r of page) {
      report.resumesRead++;
      const src = textSource(r);
      if (src === "db") report.text.inDatabase++;
      else if (src === "r2") report.text.onlyInR2++;
      else report.text.none++;
      const v = r.embedding ?? [];
      report.vectorWidths[String(v.length)] = (report.vectorWidths[String(v.length)] ?? 0) + 1;
      if (v.length) {
        const key = v.slice(0, 32).map((x) => x.toFixed(5)).join(",");
        const g = groups.get(key) ?? { size: 0, exampleHasText: src === "db" };
        g.size++;
        groups.set(key, g);
        if (placeholderRef && placeholderRef.length === v.length && cosine(placeholderRef, Float32Array.from(v)) > 0.999) report.placeholder.matches++;
        if (src === "db" && toCompare.length < (opts.sameModelSample ?? 0)) toCompare.push({ text: r.rawText!, vector: v });
      }
    }
    if (report.sampleCandidates.read < 50 && page.length) {
      const docs = await client.query<LiveCandidate[]>(READ_FUNCTIONS.candidatesByIds, { candidateIds: page.slice(0, 10).map((r) => r.candidateId) });
      for (const d of docs) {
        const c = mapCandidate(d, null);
        report.sampleCandidates.read++;
        if (c.currentTitle) report.sampleCandidates.withTitle++;
        if (c.skills.length) report.sampleCandidates.withSkills++;
        if (c.workHistory.length) report.sampleCandidates.withHistory++;
      }
    }
  }
  report.complete = report.pages < maxPages || !lastPageFull;
  report.identicalVectorGroups = [...groups.values()].filter((g) => g.size > 1).sort((a, b) => b.size - a.size).slice(0, 5);
  report.cvsInIdenticalGroups = [...groups.values()].filter((g) => g.size > 1).reduce((n, g) => n + g.size, 0);

  // Re-embed a sample the way the live system does — first 15,000 characters,
  // then its clean-up, same model, cut to the stored width — and compare. Well below 1 means that
  // vector came from another model (or the text changed since).
  if (opts.embed && toCompare.length) {
    const fresh = await opts.embed(toCompare.map((t) => t.text.trim().slice(0, 15000).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uFFFD]/g, "").replace(/\s+/g, " ").trim()));
    if (fresh) {
      toCompare.forEach((t, i) => {
        const sim = cosine(fresh[i], Float32Array.from(t.vector));
        report.sameModel.checked++;
        if (sim >= 0.97) report.sameModel.agree++;
        else report.sameModel.disagree++;
        report.sameModel.lowest = report.sameModel.lowest === null ? sim : Math.min(report.sameModel.lowest, sim);
      });
    }
  }
  report.requests = client.requests;
  return report;
}

/**
 * Copies CVs into this build: candidates (as `lv_…`) and their text, one save
 * per page. Returns what it did.
 *
 * Vectors: by default each CV is embedded HERE, with this platform's model.
 * The first live check (13 September) found the current system's stored
 * vectors come from a model that matches none of eleven candidates — including
 * the text-embedding-3-small its code names — so a search sentence embedded
 * with any known model would not compare with them. Re-embedding costs about
 * $0.00002 a CV. `useLiveVectors` keeps the old behaviour for when the model is
 * identified.
 */
export async function syncLive(
  client: ReadOnlyConvex,
  opts: { pageSize?: number; maxPages?: number; vectorWidth?: number; useLiveVectors?: boolean; skipVectors?: boolean; onPage?: (done: number) => void } = {},
) {
  const pageSize = opts.pageSize ?? 25;
  const width = opts.vectorWidth ?? 1024;
  let read = 0, added = 0, updated = 0, vectors = 0, skippedVectors = 0, embedTokens = 0;
  for await (const page of resumePages(client, pageSize, opts.maxPages ?? Number.MAX_SAFE_INTEGER)) {
    if (page.length === 0) continue;
    const docs = await client.query<LiveCandidate[]>(READ_FUNCTIONS.candidatesByIds, { candidateIds: page.map((r) => r.candidateId) });
    const byId = new Map(docs.map((d) => [d._id, d]));
    const rows = page
      .map((r) => ({ r, d: byId.get(r.candidateId) }))
      .filter((x): x is { r: LiveResume; d: LiveCandidate } => Boolean(x.d));
    const res = repo.upsertLiveCandidates(
      rows.map(({ r, d }) => ({
        candidate: mapCandidate(d, r),
        liveId: d._id,
        rawText: textSource(r) === "db" ? r.rawText!.slice(0, 150_000) : null,
        textSource: textSource(r),
      })),
    );
    if (opts.skipVectors) {
      // Copy only; embedding runs as its own step (refreshCandidateVectors).
    } else if (opts.useLiveVectors) {
      const vecs = rows.filter(({ r }) => (r.embedding?.length ?? 0) === width);
      skippedVectors += rows.length - vecs.length;
      if (vecs.length) putLiveVectors(vecs.map(({ r }) => ({ id: liveId(r.candidateId), vector: r.embedding! })));
      vectors += vecs.length;
    } else {
      forgetLiveVectors(rows.map(({ d }) => liveId(d._id)));
      const made = await ensureVectors(
        "candidates",
        rows.map(({ r, d }) => ({ id: liveId(d._id), text: candidateEmbedText(mapCandidate(d, r), textSource(r) === "db" ? r.rawText! : null) })),
      );
      if (!made.ok) throw new Error(`Embedding failed (${made.reason}) — nothing more was copied.`);
      vectors += made.embedded;
      embedTokens += made.tokens;
    }
    read += page.length;
    added += res.added;
    updated += res.updated;
    opts.onPage?.(read);
  }
  return { read, added, updated, vectors, skippedVectors, embedTokens, requests: client.requests };
}
