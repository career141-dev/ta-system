import "server-only";

/**
 * Nearest-by-meaning, against the real index.
 *
 * `embed.ts` keeps its own vectors in a file and scans them all. That was
 * right for 755 synthetic candidates and is not right for 77,000: the file
 * would be about 300 MB, and every search would read all of it to answer one
 * question. Qdrant already holds these vectors, with an HNSW index and payload
 * filters, so the work belongs there.
 *
 * Distinct from `lib/live/readOnlyQdrant.ts`, which reaches the OLD system's
 * Qdrant over a deliberately read-only link for the migration check. This one
 * talks to the index this platform searches.
 *
 * Read-only by construction: the only calls here are `search` and `count`.
 * Writing is the reindexer's job (`convex/matching/reindexVectors.ts`), and
 * nothing in the request path should ever be able to change the index.
 */

export const COLLECTION = "candidate_vectors";

/** The payload the reindexer writes, and the parts worth filtering on. */
export interface QdrantFilters {
  /** The city as the gazetteer resolved it, not as the CV spelled it. */
  locationCity?: string | null;
  locationCountry?: string | null;
  minExperience?: number | null;
  /** A ceiling on years (28 Oct). People with no years recorded still pass. */
  maxExperience?: number | null;
  seniorityLevel?: string | null;
  /** Every one of these must be present, so use it sparingly. */
  mustHaveSkills?: string[];
}

export interface QdrantHit {
  candidateId: string;
  /** Cosine similarity, 0–1. The index is built with the cosine metric. */
  score: number;
  payload: Record<string, unknown>;
}

function url(): string {
  return (process.env.QDRANT_URL || "http://127.0.0.1:6333").replace(/\/+$/, "");
}

function headers(): Record<string, string> {
  const key = (process.env.QDRANT_API_KEY ?? "").trim();
  return { "content-type": "application/json", ...(key ? { "api-key": key } : {}) };
}

function buildFilter(f: QdrantFilters): unknown | undefined {
  const must: unknown[] = [];
  const hasMax = f.maxExperience != null && f.maxExperience < 20;
  if (hasMax) {
    // "Unknown years" is not "too many": the range or an empty field.
    must.push({
      should: [
        { key: "totalExperienceYears", range: { ...(f.minExperience ? { gte: f.minExperience } : {}), lte: f.maxExperience } },
        { is_empty: { key: "totalExperienceYears" } },
      ],
    });
  } else if (f.minExperience != null && f.minExperience > 0) {
    must.push({ key: "totalExperienceYears", range: { gte: f.minExperience } });
  }
  if (f.locationCity?.trim()) must.push({ key: "locationCity", match: { value: f.locationCity.trim() } });
  if (f.locationCountry?.trim()) must.push({ key: "locationCountry", match: { value: f.locationCountry.trim() } });
  if (f.seniorityLevel?.trim()) must.push({ key: "seniorityLevel", match: { value: f.seniorityLevel.trim() } });
  for (const s of f.mustHaveSkills ?? []) must.push({ key: "skills", match: { value: s } });
  return must.length ? { must } : undefined;
}

export class QdrantUnavailable extends Error {}

/**
 * The nearest candidates to a vector.
 *
 * Throws rather than returning nothing when the index cannot be reached: an
 * empty result and a broken connection look identical on screen, and one of
 * them means "nobody matches" while the other means "we did not look".
 */
export async function searchVectors(
  vector: number[] | Float32Array,
  limit: number,
  filters: QdrantFilters = {},
): Promise<QdrantHit[]> {
  const v = Array.from(vector);
  let res: Response;
  try {
    res = await fetch(`${url()}/collections/${COLLECTION}/points/search`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ vector: v, limit, with_payload: true, filter: buildFilter(filters) }),
      cache: "no-store",
    });
  } catch (e) {
    throw new QdrantUnavailable(`Could not reach the vector index (${(e as Error).message}).`);
  }
  if (!res.ok) {
    throw new QdrantUnavailable(`The vector index refused the search: HTTP ${res.status}.`);
  }
  const body = (await res.json()) as { result?: { id: unknown; score: number; payload?: Record<string, unknown> }[] };
  return (body.result ?? [])
    .map((p) => ({
      candidateId: String(p.payload?.candidateId ?? p.id),
      score: p.score ?? 0,
      payload: p.payload ?? {},
    }))
    .filter((h) => h.candidateId);
}

/** How many vectors the index holds. Used to say plainly when it is behind. */
export async function indexedCount(): Promise<number> {
  try {
    const res = await fetch(`${url()}/collections/${COLLECTION}`, { headers: headers(), cache: "no-store" });
    if (!res.ok) return -1;
    const body = (await res.json()) as { result?: { points_count?: number } };
    return body.result?.points_count ?? -1;
  } catch {
    return -1;
  }
}
