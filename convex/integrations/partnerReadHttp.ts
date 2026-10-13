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
