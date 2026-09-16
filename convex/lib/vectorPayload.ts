/**
 * What a candidate's point in Qdrant carries, and its id.
 *
 * Pure — no client, no Node — so a query can build payloads with the same code
 * the writers use (see ta/candidates:vectorPayloadPage, which the payload
 * repair reads), and a builder change reaches every writer at once.
 */

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

export interface CandidateVectorPayload {
  candidateId: string;
  fullName: string;
  currentJobTitle?: string;
  skills: string[];
  totalExperienceYears?: number;
  seniorityLevel?: string;
  locationCity?: string;
  locationCountry?: string;
  /** Lower-cased place text — the raw location line plus city and country —
   *  full-text indexed, so "colombo" finds "Colombo 06" and "Colombo District". */
  location?: string;
  sourceChannel?: string;
  overallStatus?: string;
  updatedAt: number;
}

/**
 * The payload for one candidate, read from the fields the candidate row
 * actually has.
 *
 * Every writer used to build this inline from `candidate.locationCity` and
 * `candidate.locationCountry` — fields the candidates table does not have
 * (place lives in `location` and `locationStructured`). So all 79,054 points
 * carried empty strings, and the engine's vector search, which filters on the
 * city, returned nothing for any search that named a place. It fell back to
 * words alone without saying so. One builder now, used by every writer.
 *
 * Unknown experience is left out rather than written as 0: a range filter
 * treats 0 as "has zero years" and drops the person from a "5+ years" search,
 * where the engine's own filter keeps people whose experience is not on file.
 */
export function candidateVectorPayload(candidate: any): CandidateVectorPayload {
  const structured = candidate?.locationStructured ?? {};
  const city = (structured.city ?? "").toString().trim();
  const country = (structured.country ?? "").toString().trim();
  const place = [candidate?.location, structured.raw_text, city, country]
    .filter((x) => typeof x === "string" && x.trim())
    .join(" ")
    .toLowerCase();
  const years = candidate?.totalExperienceYears ?? candidate?.yearsOfExperience;
  return {
    candidateId: String(candidate._id),
    fullName: candidate.fullName || "Candidate",
    currentJobTitle: candidate.currentJobTitle || candidate.currentTitle || "",
    skills: Array.isArray(candidate.skills) ? candidate.skills.filter((s: unknown) => typeof s === "string") : [],
    ...(typeof years === "number" ? { totalExperienceYears: years } : {}),
    seniorityLevel: candidate.seniorityLevel ?? "",
    locationCity: city,
    locationCountry: country,
    location: place,
    sourceChannel: candidate.firstSourceChannel || candidate.sourceChannel || "",
    overallStatus: candidate.overallStatus ?? "",
    updatedAt: Date.now(),
  };
}

