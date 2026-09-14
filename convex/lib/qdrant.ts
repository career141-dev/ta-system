// @ts-ignore
import { QdrantClient } from "@qdrant/js-client-rest";

export const QDRANT_CANDIDATE_COLLECTION = "candidate_vectors";
export const QDRANT_VECTOR_DIM = 1024;
export const QDRANT_DISTANCE_METRIC = "Cosine";

export interface CandidateVectorPayload {
  candidateId: string;
  fullName: string;
  currentJobTitle?: string;
  skills: string[];
  totalExperienceYears?: number;
  seniorityLevel?: string;
  locationCity?: string;
  locationCountry?: string;
  sourceChannel?: string;
  overallStatus?: string;
  updatedAt: number;
}

export interface CandidateVectorPoint {
  candidateId: string;
  vector: number[];
  payload: CandidateVectorPayload;
}

export interface QdrantFilterOptions {
  locationCity?: string;
  locationCountry?: string;
  minExperience?: number;
  seniorityLevel?: string;
  sourceChannel?: string;
  mustHaveSkills?: string[];
  limit?: number;
}

export interface QdrantMatchResult {
  candidateId: string;
  score: number;
  payload: CandidateVectorPayload;
}

/**
 * Deterministically convert a Convex candidate ID to a valid RFC-4122 UUID for Qdrant point ID
 * (Pure JS implementation, zero Node.js runtime dependency)
 */
export function candidateIdToPointId(candidateId: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57, h3 = 0x9e3779b9, h4 = 0x85ebca6b;
  for (let i = 0; i < candidateId.length; i++) {
    const ch = candidateId.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
    h3 = Math.imul(h3 ^ ch, 3812015801);
    h4 = Math.imul(h4 ^ ch, 2246822519);
  }
  const hex1 = (h1 >>> 0).toString(16).padStart(8, "0");
  const hex2 = (h2 >>> 0).toString(16).padStart(8, "0");
  const hex3 = (h3 >>> 0).toString(16).padStart(8, "0");
  const hex4 = (h4 >>> 0).toString(16).padStart(8, "0");
  const raw = `${hex1}${hex2}${hex3}${hex4}`;
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-4${raw.slice(13, 16)}-a${raw.slice(17, 20)}-${raw.slice(20, 32)}`;
}

let clientInstance: QdrantClient | null = null;
let isCollectionInitialized = false;
let connectedUrl: string = "http://qdrant:6333";

export function getQdrantClient(targetUrl?: string): QdrantClient {
  if (!targetUrl && clientInstance) return clientInstance;

  const url = targetUrl || process.env.QDRANT_URL || connectedUrl || "http://qdrant:6333";
  const apiKey = process.env.QDRANT_API_KEY || undefined;

  const client = new QdrantClient({
    url,
    apiKey,
    checkCompatibility: false,
    timeout: 10000,
    maxConnections: 10,
  });

  if (!targetUrl) {
    clientInstance = client;
  }

  return client;
}

/**
 * Ensures the candidate_vectors collection exists with 1024-dim Cosine configuration and payload indexes.
 * Supports automatic discovery across Docker container networks (`http://qdrant:6333`) and host loops.
 */
export async function ensureCandidateCollection(): Promise<boolean> {
  if (isCollectionInitialized && clientInstance) return true;

  const candidateUrls: string[] = [
    process.env.QDRANT_URL,
    connectedUrl,
    "http://qdrant:6333",
    "http://career141-qdrant:6333",
    "http://172.17.0.1:6333",
    "http://127.0.0.1:6333",
    "http://localhost:6333",
    "http://host.docker.internal:6333",
  ].filter(Boolean) as string[];

  for (const url of candidateUrls) {
    try {
      const client = new QdrantClient({
        url,
        apiKey: process.env.QDRANT_API_KEY || undefined,
        checkCompatibility: false,
        timeout: 10000,
        maxConnections: 10,
      });

      const collections = await client.getCollections();
      const exists = collections.collections?.some((c: any) => c.name === QDRANT_CANDIDATE_COLLECTION);

      if (!exists) {
        console.log(`[Qdrant] Creating collection "${QDRANT_CANDIDATE_COLLECTION}" (dim: ${QDRANT_VECTOR_DIM}, metric: ${QDRANT_DISTANCE_METRIC}) on ${url}...`);
        await client.createCollection(QDRANT_CANDIDATE_COLLECTION, {
          vectors: {
            size: QDRANT_VECTOR_DIM,
            distance: QDRANT_DISTANCE_METRIC,
          },
        });

        const indexFields: Array<{ name: string; schema: "keyword" | "integer" | "text" }> = [
          { name: "locationCity", schema: "keyword" },
          { name: "locationCountry", schema: "keyword" },
          { name: "totalExperienceYears", schema: "integer" },
          { name: "seniorityLevel", schema: "keyword" },
          { name: "skills", schema: "keyword" },
          { name: "sourceChannel", schema: "keyword" },
        ];

        for (const field of indexFields) {
          try {
            await client.createPayloadIndex(QDRANT_CANDIDATE_COLLECTION, {
              field_name: field.name,
              field_schema: field.schema,
            });
          } catch (idxErr: any) {
            console.warn(`[Qdrant] Payload index note for "${field.name}":`, idxErr?.message);
          }
        }
      }

      clientInstance = client;
      connectedUrl = url;
      isCollectionInitialized = true;
      console.log(`[Qdrant] Connected to Qdrant successfully at ${url}!`);
      return true;
    } catch {
      // Continue trying candidate endpoint
    }
  }

  console.warn(`[Qdrant] Could not connect to Qdrant on any candidate endpoint (${candidateUrls.join(", ")})`);
  return false;
}

/**
 * Upsert a candidate embedding vector + metadata payload to Qdrant (Non-blocking safe)
 */
export async function upsertCandidateVector(point: CandidateVectorPoint): Promise<boolean> {
  if (!point.vector || point.vector.length !== QDRANT_VECTOR_DIM) {
    console.warn(`[Qdrant] Invalid vector dimension (${point.vector?.length ?? 0} != ${QDRANT_VECTOR_DIM}) for candidate ${point.candidateId}`);
    return false;
  }

  try {
    const ready = await ensureCandidateCollection();
    if (!ready) return false;

    const client = getQdrantClient();
    const pointId = candidateIdToPointId(point.candidateId);

    await client.upsert(QDRANT_CANDIDATE_COLLECTION, {
      wait: true,
      points: [
        {
          id: pointId,
          vector: point.vector,
          payload: {
            ...point.payload,
            candidateId: point.candidateId,
          } as Record<string, unknown>,
        },
      ],
    });

    return true;
  } catch (err: any) {
    console.warn(`[Qdrant] Upsert vector warning for candidate ${point.candidateId}:`, err?.message);
    return false;
  }
}

/**
 * Batch upsert multiple candidate vectors (used for backfills and bulk imports)
 */
export async function batchUpsertCandidateVectors(points: CandidateVectorPoint[]): Promise<{ success: number; failed: number }> {
  if (points.length === 0) return { success: 0, failed: 0 };

  try {
    const ready = await ensureCandidateCollection();
    if (!ready) return { success: 0, failed: points.length };

    const client = getQdrantClient();

    const formattedPoints = points
      .filter((p) => p.vector && p.vector.length === QDRANT_VECTOR_DIM)
      .map((p) => ({
        id: candidateIdToPointId(p.candidateId),
        vector: p.vector,
        payload: {
          ...p.payload,
          candidateId: p.candidateId,
        } as Record<string, unknown>,
      }));

    if (formattedPoints.length === 0) {
      return { success: 0, failed: points.length };
    }

    await client.upsert(QDRANT_CANDIDATE_COLLECTION, {
      wait: true,
      points: formattedPoints,
    });

    return {
      success: formattedPoints.length,
      failed: points.length - formattedPoints.length,
    };
  } catch (err: any) {
    console.warn(`[Qdrant] Batch upsert error (${points.length} points):`, err?.message);
    return { success: 0, failed: points.length };
  }
}

/**
 * Query candidate vectors in Qdrant with optional payload metadata filtering
 */
export async function queryCandidateVectors(
  queryVector: number[],
  options: QdrantFilterOptions = {}
): Promise<QdrantMatchResult[]> {
  if (!queryVector || queryVector.length !== QDRANT_VECTOR_DIM) {
    throw new Error(`Query vector dimension mismatch: expected ${QDRANT_VECTOR_DIM}, got ${queryVector?.length ?? 0}`);
  }

  const ready = await ensureCandidateCollection();
  if (!ready) {
    throw new Error("Qdrant service is currently unavailable");
  }

  const client = getQdrantClient();
  const limit = options.limit || 1000;

  const mustConditions: any[] = [];

  if (options.minExperience !== undefined && options.minExperience > 0) {
    mustConditions.push({
      key: "totalExperienceYears",
      range: {
        gte: options.minExperience,
      },
    });
  }

  if (options.locationCity && options.locationCity.trim().length > 0) {
    mustConditions.push({
      key: "locationCity",
      match: {
        value: options.locationCity.trim(),
      },
    });
  }

  if (options.locationCountry && options.locationCountry.trim().length > 0) {
    mustConditions.push({
      key: "locationCountry",
      match: {
        value: options.locationCountry.trim(),
      },
    });
  }

  if (options.seniorityLevel && options.seniorityLevel.trim().length > 0) {
    mustConditions.push({
      key: "seniorityLevel",
      match: {
        value: options.seniorityLevel.trim(),
      },
    });
  }

  if (options.sourceChannel && options.sourceChannel.trim().length > 0) {
    mustConditions.push({
      key: "sourceChannel",
      match: {
        value: options.sourceChannel.trim(),
      },
    });
  }

  if (options.mustHaveSkills && options.mustHaveSkills.length > 0) {
    for (const skill of options.mustHaveSkills) {
      mustConditions.push({
        key: "skills",
        match: {
          value: skill,
        },
      });
    }
  }

  const filter = mustConditions.length > 0 ? { must: mustConditions } : undefined;

  let points: any[] = [];
  try {
    if (typeof (client as any).search === "function") {
      points = await (client as any).search(QDRANT_CANDIDATE_COLLECTION, {
        vector: queryVector,
        filter,
        limit,
        with_payload: true,
      });
    } else if (typeof (client as any).query === "function") {
      const searchResult = await (client as any).query(QDRANT_CANDIDATE_COLLECTION, {
        query: queryVector,
        filter,
        limit,
        with_payload: true,
      });
      points = Array.isArray(searchResult) ? searchResult : (searchResult?.points || []);
    }
  } catch (searchErr: any) {
    console.warn("[Qdrant] Search execution error:", searchErr?.message);
    throw searchErr;
  }

  const matches: QdrantMatchResult[] = [];
  for (const p of points) {
    const payload = (p.payload || p) as unknown as CandidateVectorPayload;
    const candId = payload?.candidateId || p.id;
    if (candId) {
      matches.push({
        candidateId: String(candId),
        score: p.score ?? 0,
        payload,
      });
    }
  }

  console.log(`[Qdrant] Query returned ${matches.length} vector matches (limit: ${limit})`);
  return matches;
}

/**
 * Delete a candidate vector point by candidate ID
 */
export async function deleteCandidateVector(candidateId: string): Promise<boolean> {
  try {
    const ready = await ensureCandidateCollection();
    if (!ready) return false;

    const client = getQdrantClient();
    const pointId = candidateIdToPointId(candidateId);
    await client.delete(QDRANT_CANDIDATE_COLLECTION, {
      points: [pointId],
    });
    return true;
  } catch (err: any) {
    console.warn(`[Qdrant] Delete vector warning for candidate ${candidateId}:`, err?.message);
    return false;
  }
}
