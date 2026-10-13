import { internal } from "../_generated/api";
import { makeFunctionReference, type FunctionReference, type PaginationResult } from "convex/server";
import { httpAction } from "../_generated/server";
import { hasPartnerBearerToken, partnerPageOptions } from "../lib/partnerReadAuth";
import { PARTNER_READ_TABLES } from "./partnerRead";

const readTablePageRef = makeFunctionReference<"query", {
  table: string;
  cursor?: string;
  limit: number;
}, PaginationResult<unknown>>("integrations/partnerRead:readTablePage") as unknown as FunctionReference<
  "query", "internal", { table: string; cursor?: string; limit: number }, PaginationResult<unknown>
>;
const getCvDownloadRef = makeFunctionReference<"action", { uploadId: string }, {
  url: string;
  fileName: string;
  fileType: string;
} | null>("integrations/partnerRead:getCvDownload") as unknown as FunctionReference<
  "action", "internal", { uploadId: string }, { url: string; fileName: string; fileType: string } | null
>;
const createPartnerCvUploadRef = makeFunctionReference<"action", {
  fileName: string;
  contentType: string;
  fileSize: number;
  checksumSha256: string;
}, { url: string; key: string; expiresInSeconds: number }>(
  "storage/r2:generatePartnerCvUploadUrl",
) as unknown as FunctionReference<"action", "internal", {
  fileName: string; contentType: string; fileSize: number; checksumSha256: string;
}, { url: string; key: string; expiresInSeconds: number }>;
const completePartnerCvUploadRef = makeFunctionReference<"action", {
  key: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  checksumSha256: string;
}, unknown>("integrations/partnerUpload:completePartnerCvUpload") as unknown as FunctionReference<
  "action", "internal", {
    key: string; fileName: string; fileType: string; fileSize: number; checksumSha256: string;
  }, unknown
>;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });

async function authenticate(request: Request): Promise<"ok" | "unauthorized" | "unconfigured"> {
  const expected = process.env.CAPACITY_PLANNER_READ_TOKEN;
  if (!expected) return "unconfigured";
  return (await hasPartnerBearerToken(request.headers.get("authorization"), expected)) ? "ok" : "unauthorized";
}

function authError(state: "unauthorized" | "unconfigured"): Response {
  return state === "unconfigured"
    ? json(503, { error: "Integration is not configured" })
    : json(401, { error: "Unauthorized" });
}

export const partnerReadTable = httpAction(async (ctx, request) => {
  const auth = await authenticate(request);
  if (auth !== "ok") return authError(auth);

  const url = new URL(request.url);
  const table = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
  if (!PARTNER_READ_TABLES.includes(table as (typeof PARTNER_READ_TABLES)[number])) {
    return json(404, { error: "Unknown table" });
  }
  const options = partnerPageOptions(url);
  if (!options) return json(400, { error: "Invalid pagination options" });

  try {
    const result = await ctx.runQuery(readTablePageRef, {
      table,
      ...options,
    });
    console.info("[partner-read] table page", JSON.stringify({ table, rows: result.page.length }));
    return json(200, { table, ...result });
  } catch {
    return json(500, { error: "Could not read the requested table page" });
  }
});

export const partnerReadTableIndex = httpAction(async (_ctx, request) => {
  const auth = await authenticate(request);
  if (auth !== "ok") return authError(auth);
  return json(200, { tables: PARTNER_READ_TABLES });
});

export const partnerReadCv = httpAction(async (ctx, request) => {
  const auth = await authenticate(request);
  if (auth !== "ok") return authError(auth);

  let uploadId = "";
  try {
    uploadId = decodeURIComponent(new URL(request.url).pathname.split("/").at(-1) ?? "");
  } catch {
    return json(400, { error: "Invalid CV id" });
  }
  if (!uploadId || uploadId.length > 128) return json(400, { error: "Invalid CV id" });

  try {
    const file = await ctx.runAction(getCvDownloadRef, { uploadId });
    if (!file) return json(404, { error: "CV not found" });
    const upstream = await fetch(file.url, { signal: AbortSignal.timeout(30_000) });
    if (!upstream.ok || !upstream.body) return json(502, { error: "CV download is temporarily unavailable" });

    const filename = (file.fileName || "candidate-cv")
      .replace(/[\r\n"\\/]/g, "_")
      .replace(/[^\x20-\x7e]/g, "_")
      .slice(0, 160);
    const headers = new Headers({
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-type": file.fileType || upstream.headers.get("content-type") || "application/octet-stream",
      "x-content-type-options": "nosniff",
    });
    const length = upstream.headers.get("content-length");
    if (length && /^\d+$/.test(length)) headers.set("content-length", length);
    console.info("[partner-read] CV download", JSON.stringify({ bytes: length ?? "streamed" }));
    return new Response(upstream.body, { status: 200, headers });
  } catch {
    return json(502, { error: "CV download is temporarily unavailable" });
  }
});

const PARTNER_CV_MAX_BYTES = 10 * 1024 * 1024;
const PARTNER_CV_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);
const isSha256Base64 = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9+/]{43}=$/.test(value);

export const partnerCreateCvUpload = httpAction(async (ctx, request) => {
  const auth = await authenticate(request);
  if (auth !== "ok") return authError(auth);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > 8_192) return json(413, { error: "Request is too large" });
  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!input || typeof input.fileName !== "string" || input.fileName.length < 1 || input.fileName.length > 180 ||
      typeof input.contentType !== "string" || !PARTNER_CV_TYPES.has(input.contentType) ||
      typeof input.fileSize !== "number" || !Number.isInteger(input.fileSize) || input.fileSize < 1 || input.fileSize > PARTNER_CV_MAX_BYTES ||
      !isSha256Base64(input.checksumSha256)) {
    return json(400, { error: "Provide a valid fileName, supported CV contentType, fileSize (1-10485760), and SHA-256 checksum (base64)" });
  }
  try {
    const upload = await ctx.runAction(createPartnerCvUploadRef, {
      fileName: input.fileName,
      contentType: input.contentType,
      fileSize: input.fileSize,
      checksumSha256: input.checksumSha256,
    });
    return json(201, { ...upload, requiredHeaders: {
      "content-type": input.contentType,
      "x-amz-checksum-sha256": input.checksumSha256,
    } });
  } catch {
    return json(503, { error: "CV upload is temporarily unavailable" });
  }
});

export const partnerCompleteCvUpload = httpAction(async (ctx, request) => {
  const auth = await authenticate(request);
  if (auth !== "ok") return authError(auth);
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > 8_192) return json(413, { error: "Request is too large" });
  const input = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!input || typeof input.key !== "string" || !/^partner-uploads\/[A-Za-z0-9-]{36}-[A-Za-z0-9._-]{1,120}$/.test(input.key) ||
      typeof input.fileName !== "string" || input.fileName.length < 1 || input.fileName.length > 180 ||
      typeof input.fileType !== "string" || !PARTNER_CV_TYPES.has(input.fileType) ||
      typeof input.fileSize !== "number" || !Number.isInteger(input.fileSize) || input.fileSize < 1 || input.fileSize > PARTNER_CV_MAX_BYTES ||
      !isSha256Base64(input.checksumSha256)) {
    return json(400, { error: "Invalid upload completion details" });
  }
  try {
    const result = await ctx.runAction(completePartnerCvUploadRef, {
      key: input.key,
      fileName: input.fileName,
      fileType: input.fileType,
      fileSize: input.fileSize,
      checksumSha256: input.checksumSha256,
    });
    return json(200, { uploaded: true, file: result });
  } catch {
    return json(400, { error: "Upload is missing, expired, or failed verification" });
  }
});
