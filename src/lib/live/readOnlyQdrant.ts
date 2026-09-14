/**
 * A read-only link to the current system's Qdrant (13 September).
 *
 * Only read calls exist here: collection info, count, scroll, and search.
 * Qdrant can also be given a key that is read-only on its side
 * (`read_only_api_key`); use that one, so even a mistake here could not write.
 */

export const QDRANT_COLLECTION = "candidate_vectors";

export interface LiveQdrantConfig {
  url: string;
  apiKey: string | null;
  fetchImpl?: typeof fetch;
}

export function liveQdrantConfigFromEnv(env = process.env): LiveQdrantConfig | null {
  const url = (env.C141_LIVE_QDRANT_URL ?? "").trim().replace(/\/+$/, "");
  if (!url) return null;
  return { url, apiKey: (env.C141_LIVE_QDRANT_READ_KEY ?? "").trim() || null };
}

type ReadCall = { method: "GET" | "POST"; path: string };
/** Every call this client can make. POST here is Qdrant's way of sending a search, not a write. */
const READ_CALLS = (c: string) => ({
  info: { method: "GET", path: `/collections/${c}` },
  count: { method: "POST", path: `/collections/${c}/points/count` },
  scroll: { method: "POST", path: `/collections/${c}/points/scroll` },
  search: { method: "POST", path: `/collections/${c}/points/search` },
}) satisfies Record<string, ReadCall>;

export class ReadOnlyQdrant {
  private readonly config: LiveQdrantConfig;
  private readonly collection: string;
  constructor(config: LiveQdrantConfig, collection = QDRANT_COLLECTION) {
    this.config = config;
    this.collection = collection;
  }

  private async call<T>(which: keyof ReturnType<typeof READ_CALLS>, body?: unknown): Promise<T> {
    const { method, path } = READ_CALLS(this.collection)[which];
    const res = await (this.config.fetchImpl ?? fetch)(`${this.config.url}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(this.config.apiKey ? { "api-key": this.config.apiKey } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = (await res.json().catch(() => null)) as { result?: T; status?: unknown } | null;
    if (!res.ok || !json) throw new Error(`Qdrant refused ${which}: HTTP ${res.status}`);
    return json.result as T;
  }

  info() {
    return this.call<{ points_count?: number; config?: { params?: { vectors?: { size?: number; distance?: string } } } }>("info");
  }
  count() {
    return this.call<{ count: number }>("count", { exact: true });
  }
  scroll(limit: number, offset: string | number | null = null, withVector = false, filter?: unknown) {
    return this.call<{ points: { id: string | number; payload?: Record<string, unknown>; vector?: number[] }[]; next_page_offset: string | number | null }>("scroll", {
      limit, offset, with_payload: true, with_vector: withVector, ...(filter ? { filter } : {}),
    });
  }
  search(vector: number[], limit: number, filter?: unknown) {
    return this.call<{ id: string | number; score: number; payload?: Record<string, unknown> }[]>("search", {
      vector, limit, with_payload: true, ...(filter ? { filter } : {}),
    });
  }
}
