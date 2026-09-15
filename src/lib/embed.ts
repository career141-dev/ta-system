/**
 * Search by meaning — agreed 13 September.
 *
 * Word search finds "Trade Marketing Manager" when you type those words and
 * misses the "Channel Activation Lead" who did the same job. An embedding turns
 * a CV and a search into points in the same space, where similar work sits
 * close together whatever it was called.
 *
 * Meaning only ever ranks. Location, nationality, experience, notice and salary
 * stay strict filters applied first (lib/match), because "close in meaning" is
 * exactly the wrong test for "lives in Colombo".
 *
 * Where vectors live: in this build, `.data/vectors.json` beside the database,
 * searched in memory — 755 candidates is nothing.
 *
 * **On the live system they already exist.** The current platform embeds every
 * CV as it arrives — openai/text-embedding-3-small through OpenRouter, cut to
 * the first 1,024 numbers — and keeps them in Qdrant (`candidate_vectors`,
 * cosine, filterable by city, country, experience, seniority and skills) and in
 * Convex (`candidateResumes.embedding`). Read from source, 7 September commit.
 * So when connected, candidate vectors are *read* from there, never made again;
 * this file only embeds the search sentence or the JD, and does it the same way
 * (same model, same 1,024) so the two sides compare.
 *
 * With no key, a word-hashing stand-in keeps every screen working. It is NOT
 * meaning-based and the screens say so; it exists so the no-key build is honest
 * rather than broken.
 */

import fs from "node:fs";
import path from "node:path";
import type { Candidate, Opening } from "@/data/types";
import { createHash } from "node:crypto";
import { dataDir } from "@/data/dataDir";
import { embedCost, embedMaxCost, reserve, SpendCapError } from "./spend";
import { isConvex as isConvexStore } from "@/data/mode";

const hashOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

export const LOCAL_MODEL = "local-words-v1";
const LOCAL_DIMS = 512;
const BATCH = 96;

function openaiKey() {
  return (process.env.OPENAI_API_KEY ?? "").trim();
}
function openrouterKey() {
  return (process.env.OPENROUTER_API_KEY ?? "").trim();
}

/** How many numbers are kept — the live system's Qdrant collection is 1,024 wide. */
export const LIVE_DIMS = 1024;

/**
 * The model in force, with its width. Changing either re-embeds this build's
 * vectors — vectors from two models, or two widths, do not compare.
 */
export function embedModel(): string {
  const override = (process.env.C141_EMBED_MODEL ?? "").trim();
  if (override) return override;
  if (openaiKey()) return `text-embedding-3-small@${LIVE_DIMS}`;
  if (openrouterKey()) return `openai/text-embedding-3-small@${LIVE_DIMS}`;
  return LOCAL_MODEL;
}

const [modelName, widthText] = [(m: string) => m.split("@")[0], (m: string) => Number(m.split("@")[1]) || null];

export const isMeaningBased = () => embedModel() !== LOCAL_MODEL;

// ─── Text ───────────────────────────────────────────────────────────────────

/** What a candidate is, for comparing against a job. Contact details never go in. */
export function candidateEmbedText(c: Candidate, cvText: string | null): string {
  const record = [
    [c.currentTitle, c.currentEmployer].filter(Boolean).join(" at "),
    ...c.workHistory.map((h) => `${h.title} at ${h.employer}`),
    c.skills.join(", "),
    c.industries.join(", "),
    [c.educationDegree, c.qualifications].filter(Boolean).join(", "),
  ].filter(Boolean).join("\n");
  // The CV body, minus the lines that identify the person.
  const body = (cvText ?? "")
    .split("\n")
    .filter((l) => !/@|\+?\d[\d\s-]{7,}|linkedin\.com/i.test(l))
    .join("\n")
    .slice(0, 6000);
  return `${record}\n${body}`.trim();
}

export function openingEmbedText(o: Pick<Opening, "title" | "jdMarkdown">, industry: string | null): string {
  return [o.title, industry ?? "", o.jdMarkdown.slice(0, 6000)].filter(Boolean).join("\n");
}

// ─── Vectors ────────────────────────────────────────────────────────────────

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const STOP = new Set("the and for with from that this have has was were are you your our their into over under of to in on at by an a or as is be".split(" "));

/** The no-key stand-in: words and word pairs hashed into a fixed-size vector. */
export function localVector(text: string): Float32Array {
  const v = new Float32Array(LOCAL_DIMS);
  const words = text.toLowerCase().split(/[^a-z0-9+#]+/).filter((w) => w.length > 2 && !STOP.has(w));
  const add = (tok: string, weight: number) => {
    const h = fnv(tok);
    v[h % LOCAL_DIMS] += (h & 0x80000000 ? -1 : 1) * weight;
  };
  words.forEach((w, i) => {
    add(w, 1);
    if (i > 0) add(`${words[i - 1]} ${w}`, 0.6);
  });
  return v;
}

/**
 * Search by meaning: at or above this similarity a CV counts as relevant.
 * A fixed bar, not one set against the best result — "within 0.12 of the
 * best" hid good people whenever one CV happened to be very close, and showed
 * weak ones when nobody was (13 September). Set from blind-judged live results;
 * `BELOW_BAR` is how far under it the "more below the bar" link reaches.
 */
export const RELEVANT_SIMILARITY = Number(process.env.C141_RELEVANT_SIMILARITY ?? "") || 0.3;
export const BELOW_BAR = 0.08;

export type EmbedResult =
  | { ok: true; vectors: Float32Array[]; model: string; tokens: number }
  | { ok: false; reason: string };

export async function embedTexts(texts: string[]): Promise<EmbedResult> {
  const model = embedModel();
  if (model === LOCAL_MODEL) return { ok: true, vectors: texts.map(localVector), model, tokens: 0 };

  const name = modelName(model);
  const width = widthText(model);
  const url = openaiKey() && !name.includes("/")
    ? "https://api.openai.com/v1/embeddings"
    : "https://openrouter.ai/api/v1/embeddings";
  const key = url.includes("openai.com") ? openaiKey() : openrouterKey();
  if (!key) return { ok: false, reason: "no_key" };

  const vectors: Float32Array[] = [];
  let tokens = 0;
  for (let i = 0; i < texts.length; i += BATCH) {
    const input = texts.slice(i, i + BATCH).map((t) => t.slice(0, 24_000) || " ");
    // The test's hard stop, per batch: reserve the most it could cost first.
    let settle: (usd: number) => void;
    try {
      settle = reserve(`embed ${input.length} · ${name}`, embedMaxCost(name, input.reduce((n, t) => n + t.length, 0)));
    } catch (e) {
      if (e instanceof SpendCapError) return { ok: false, reason: `spend_cap: ${e.message}` };
      throw e;
    }
    let res: Response | null = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        res = await fetch(url, {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          // Only providers that keep nothing and train on nothing (see lib/ai).
          body: JSON.stringify({
            model: name,
            input,
            // ASK for the width; do not cut one down to it.
            //
            // text-embedding-3-small returns 1,536 numbers. Taking the first
            // 1,024 of those is NOT the same vector as asking the model for
            // 1,024: the `dimensions` parameter truncates and then
            // RE-NORMALISES, so a requested vector has length 1 and a sliced
            // one has length ~0.82 and points somewhere else entirely.
            //
            // Every vector in the index was made the first way — measured, they
            // are all exactly 1.0 — so a query made the second way lands in a
            // different space and matches nothing. This was silently wrong: it
            // returns results, they are just the wrong results.
            ...(width ? { dimensions: width } : {}),
            ...(url.includes("openrouter") ? { provider: { zdr: true, data_collection: "deny" } } : {}),
          }),
        });
      } catch (e) {
        // Whether a request that got no answer was charged is unknown: keep the reservation.
        settle(Number.NaN);
        return { ok: false, reason: `network: ${String(e).slice(0, 120)}` };
      }
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    }
    if (!res || !res.ok) {
      settle(Number.NaN);
      return { ok: false, reason: `bad_response ${res?.status ?? ""}` };
    }
    let body: { data?: { embedding: number[]; index: number }[]; usage?: { total_tokens?: number } };
    try {
      body = await res.json();
    } catch (e) {
      // The response may have been billed even though it did not arrive whole.
      settle(embedMaxCost(name, input.reduce((n, t) => n + t.length, 0)));
      return { ok: false, reason: `network: ${String(e).slice(0, 120)}` };
    }
    settle(embedCost(name, body.usage?.total_tokens ?? 0) || embedMaxCost(name, input.reduce((n, t) => n + t.length, 0)));
    const rows = [...(body.data ?? [])].sort((a, b) => a.index - b.index);
    if (rows.length !== input.length) return { ok: false, reason: "bad_response: wrong count" };
    // Cut to the live index's width the same way the live system does, so a
    // query made here lands in the same space as the CVs it already holds.
    for (const r of rows) {
      // A provider that ignored `dimensions` has handed back a vector from a
      // different space. Slicing it here is what hid the problem before, so it
      // is refused instead: wrong results that look right are worse than none.
      if (width && r.embedding.length !== width) {
        return {
          ok: false,
          reason:
            `bad_response: asked ${name} for ${width} dimensions and got ${r.embedding.length}. ` +
            `Cutting it down would produce a vector that does not compare with the index.`,
        };
      }
      vectors.push(Float32Array.from(r.embedding));
    }
    tokens += body.usage?.total_tokens ?? 0;
  }
  return { ok: true, vectors, model, tokens };
}

/**
 * A search sentence's vector, remembered. Embedding the query is the one
 * network call in a search by meaning (about 0.8 s, measured 13 September), and
 * paging through results or changing a filter asks for the same sentence again.
 */
const queryCache = new Map<string, Float32Array>();
export async function embedQuery(text: string): Promise<EmbedResult> {
  const key = `${embedModel()}|${text.trim().toLowerCase().replace(/\s+/g, " ")}`;
  const hit = queryCache.get(key);
  if (hit) {
    queryCache.delete(key);
    queryCache.set(key, hit);
    return { ok: true, vectors: [hit], model: embedModel(), tokens: 0 };
  }
  const r = await embedTexts([text]);
  if (r.ok) {
    queryCache.set(key, r.vectors[0]);
    if (queryCache.size > 500) queryCache.delete(queryCache.keys().next().value!);
  }
  return r;
}

// ─── The vector file ────────────────────────────────────────────────────────

interface Row { h: string; v: string }
interface VectorFile { model: string; candidates: Record<string, Row>; openings: Record<string, Row> }

/*
 * Two files: candidates in one, jobs in another. Saving one job's vector used
 * to rewrite every candidate's too — about 100 MB at 115,000 candidates, once
 * per job, every night (13 September).
 */
const FILE = () => path.join(dataDir(), "vectors.json");
const JOB_FILE = () => path.join(dataDir(), "vectors-openings.json");
let cache: { file: VectorFile; decoded: Map<string, Float32Array> } | null = null;

const encode = (v: Float32Array) => Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
function decode(s: string): Float32Array {
  const b = Buffer.from(s, "base64");
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}

function loadFile(): VectorFile {
  if (cache && cache.file.model === embedModel()) return cache.file;
  let file: VectorFile = { model: embedModel(), candidates: {}, openings: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE(), "utf8")) as VectorFile;
    // Another model's vectors are useless here; start again rather than mix them.
    if (parsed.model === embedModel()) file = { ...parsed, openings: parsed.openings ?? {} };
  } catch {
    // Missing or unreadable: vectors are derived data and are rebuilt.
  }
  try {
    const jobs = JSON.parse(fs.readFileSync(JOB_FILE(), "utf8")) as { model: string; openings: Record<string, Row> };
    if (jobs.model === embedModel()) file.openings = { ...file.openings, ...jobs.openings };
  } catch {
    // None yet.
  }
  cache = { file, decoded: new Map() };
  return file;
}

function saveFile(file: VectorFile, kind: "candidates" | "openings") {
  const target = kind === "candidates" ? FILE() : JOB_FILE();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify(kind === "candidates" ? { model: file.model, candidates: file.candidates, openings: {} } : { model: file.model, openings: file.openings }),
  );
  fs.renameSync(tmp, target);
}

function get(kind: "candidates" | "openings", id: string): Float32Array | null {
  const file = loadFile();
  const row = file[kind][id];
  if (!row) return null;
  const key = `${kind}:${id}:${row.h}`;
  let v = cache!.decoded.get(key);
  if (!v) {
    v = decode(row.v);
    cache!.decoded.set(key, v);
  }
  return v;
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * Makes sure each item has a vector for its current text. Only new or changed
 * text is sent, so the nightly run costs what changed that day, not the whole
 * database again. Runs one at a time so two requests cannot overwrite each other.
 */
export function ensureVectors(
  kind: "candidates" | "openings",
  items: { id: string; text: string }[],
): Promise<{ ok: true; embedded: number; tokens: number } | { ok: false; reason: string }> {
  const run = queue.then(async () => {
    const file = loadFile();
    const stale = items.filter((it) => file[kind][it.id]?.h !== hashOf(it.text) && file[kind][it.id]?.h !== LIVE_ROW);
    if (stale.length === 0) return { ok: true as const, embedded: 0, tokens: 0 };
    const r = await embedTexts(stale.map((s) => s.text));
    if (!r.ok) return r;
    stale.forEach((s, i) => {
      file[kind][s.id] = { h: hashOf(s.text), v: encode(r.vectors[i]) };
    });
    saveFile(file, kind);
    return { ok: true as const, embedded: stale.length, tokens: r.tokens };
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Vectors read from the current system, stored as they are — never re-embedded.
 * Marked so `ensureVectors` leaves them alone: their text is the live system's,
 * not ours, so our text hash would never match and would pay to remake them.
 */
export function putLiveVectors(rows: { id: string; vector: number[] }[]) {
  const file = loadFile();
  for (const r of rows) file.candidates[r.id] = { h: LIVE_ROW, v: encode(Float32Array.from(r.vector)) };
  saveFile(file, "candidates");
}
const LIVE_ROW = "live";

/** Drops vectors copied from the live system, so they are embedded here next time. */
export function forgetLiveVectors(ids: string[]) {
  const file = loadFile();
  let changed = false;
  for (const id of ids) {
    if (file.candidates[id]?.h === LIVE_ROW) {
      delete file.candidates[id];
      changed = true;
    }
  }
  if (changed) {
    cache?.decoded.clear();
    saveFile(file, "candidates");
  }
}

export const candidateVector = (id: string) => get("candidates", id);
export const openingVector = (id: string) => get("openings", id);

/**
 * Nearest by meaning, from whichever index is in use.
 *
 * Backed by Convex the vectors live in Qdrant, which has 77,000 of them and an
 * index to search them with. On the file store they are in `.data`, and
 * scanning all of them is fine at that size.
 *
 * `allow` is applied AFTER retrieval in both cases. Qdrant can pre-filter on
 * its payload, but the predicate here is arbitrary code — "not already on this
 * opening", "not excluded" — so it is asked for more than `k` and narrowed
 * afterwards.
 */
export async function nearestCandidates(
  query: Float32Array,
  k: number,
  allow: (id: string) => boolean = () => true,
): Promise<{ id: string; similarity: number }[]> {
  if (!isConvexStore()) return nearest(query, k, allow);

  const { searchVectors } = await import("./qdrantSearch");
  // Over-fetch, because `allow` can reject a large share of what comes back
  // and a short list would silently become shorter still.
  const hits = await searchVectors(query, Math.min(k * 4, 2000));
  return hits
    .filter((h) => allow(h.candidateId))
    .slice(0, k)
    .map((h) => ({ id: h.candidateId, similarity: h.score }));
}

/** Similarity of every candidate that has a vector to the query, highest first.
 *  The file-store path; see `nearestCandidates` for the one that picks. */
export function nearest(query: Float32Array, k: number, allow: (id: string) => boolean = () => true) {
  const file = loadFile();
  const out: { id: string; similarity: number }[] = [];
  for (const id of Object.keys(file.candidates)) {
    if (!allow(id)) continue;
    const v = get("candidates", id);
    if (v) out.push({ id, similarity: cosine(query, v) });
  }
  return out.sort((a, b) => b.similarity - a.similarity).slice(0, k);
}

/** For tests: forget what is in memory. */
export function _resetVectorCache() {
  cache = null;
}
