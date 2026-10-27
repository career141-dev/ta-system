import { v } from "convex/values";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import type { Id, TableNames } from "../_generated/dataModel";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";

// Every schema table must be classified as partner-readable or private.
// Browser activity is restricted to TA Track's admin/TA lead report boundary.
export const PARTNER_PRIVATE_TABLES = ["taTrackingDevices", "taTrackingRows"] as const;
export const PARTNER_READ_TABLES = [
  "dailyEmailPolicy", "dailyEmails", "dailyEmailAttachments",
  "users", "teams", "teamMembers", "jobAssignments", "openingAccessRequests", "roleAuditLog",
  "candidateLocks", "candidateInquiries", "jobs", "jobChannels", "job_assets",
  "custom_filters", "saved_filters", "match_scores", "pipeline_health_reports",
  "cvUploads", "cvExtractionQueue", "partnerCvFiles", "folderImportProgress", "candidateResumes", "referees", "candidates",
  "applications", "pipelineEvents", "aiCalls", "voiceCallSessions", "voiceAnswers",
  "voiceAgentNonces", "voiceSimulationReservations", "communications", "directorReviews",
  "clientReviews", "interviews", "offers", "placements", "rejectionLoopEvents",
  "ingestionBatches", "ingestionLog", "systemLogs", "activityLog", "candidateConsent",
  "esaRecords", "documents", "workableImports", "herculesImports", "zipImportJobs",
  "mailboxScanJobs", "cvs", "pipeline", "followUpSequences", "notifications",
  "dashboardStatsCache", "mailboxLog", "appSettings", "searchHistory", "oauthStates",
  "graphSubscriptions", "m365Accounts", "whatsappSessions", "systemStats", "dailyStats",
  "nvidiaTokenLogs", "tokenStatsCache", "dailyTokenStats", "messageTemplates",
  "whatsappNumbers", "cvScans", "locationResolutionCache", "criteriaExpansionCache",
  "cvScanResults", "mailboxScanJobResults", "mailboxCheckpoints", "sept5ReextractionState",
  "clients", "jobPosts", "briefs", "intakeItems", "linkVault", "refereeCalls", "researchReports",
  "benchmarks", "profileSuggestions", "sourcingChat", "jdChat", "savedSearches",
  "savedReports", "matchRuns", "matchExclusions", "strategies", "strategyAssignments",
  "reviewRounds", "shortlistDecisionReviews", "eodEmailCopies", "callFeedback", "taAlerts", "taOutreach",
  "taScreeningCalls", "taSettings", "healerState", "mailIntakeMailboxes",
  "mailIntakeMessages", "feedbacks",
  "taWorkdays", "taWorkdayRequests", "taWorkdayCarry", "taWorkdayMail",
  "taWorkdayLeads", "taWorkdayActivity",
  "taWorkdayCheckNotes", "taWorkdayTaskEvents", "taWorkdayExceptions", "taSourcingRuns", "taWorkdayEvidence",
] as const;

const partnerTableSet = new Set<string>(PARTNER_READ_TABLES);
const PRIVATE_FIELDS = /token|secret|password|credential|authorization|private.?key|api.?key/i;
const getCvReferenceRef = makeFunctionReference<"query", { uploadId: string }, {
  storageId?: Id<"_storage">;
  s3Key?: string;
  fileName: string;
  fileType: string;
} | null>("integrations/partnerRead:getCvReference") as unknown as FunctionReference<
  "query", "internal", { uploadId: string }, {
    storageId?: Id<"_storage">;
    s3Key?: string;
    fileName: string;
    fileType: string;
  } | null
>;

export function redactPartnerSecrets(value: unknown, table?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => redactPartnerSecrets(item, table));
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const privateField = PRIVATE_FIELDS.test(key) ||
      (table === "oauthStates" && key === "state") ||
      (table === "mailIntakeMailboxes" && ["deltaLink", "nextLink"].includes(key));
    result[key] = privateField ? "[REDACTED]" : redactPartnerSecrets(child, table);
  }
  return result;
}

export const readTablePage = internalQuery({
  args: {
    table: v.string(),
    cursor: v.optional(v.union(v.string(), v.null())),
    limit: v.number(),
  },
  handler: async (ctx, args) => {
    if (!partnerTableSet.has(args.table)) throw new Error("Unknown table");
    const page = await ctx.db
      .query(args.table as TableNames)
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
    return { ...page, page: page.page.map((row) => redactPartnerSecrets(row, args.table)) };
  },
});

export const getCvReference = internalQuery({
  args: { uploadId: v.string() },
  handler: async (ctx, { uploadId }) => {
    const partnerFileId = ctx.db.normalizeId("partnerCvFiles", uploadId);
    if (partnerFileId) {
      const partnerFile = await ctx.db.get(partnerFileId);
      if (partnerFile) return {
        s3Key: partnerFile.s3Key,
        fileName: partnerFile.fileName,
        fileType: partnerFile.fileType,
      };
    }
    const id = ctx.db.normalizeId("cvUploads", uploadId);
    const upload = id ? await ctx.db.get(id) : null;
    return upload ? {
      storageId: upload.storageId,
      s3Key: upload.s3Key,
      fileName: upload.fileName,
      fileType: upload.fileType,
    } : null;
  },
});

/** Resolve a CV through its record; callers never choose a bucket key or storage ID. */
export const getCvDownload = internalAction({
  args: { uploadId: v.string() },
  handler: async (ctx, { uploadId }): Promise<{ url: string; fileName: string; fileType: string } | null> => {
    const upload = await ctx.runQuery(getCvReferenceRef, { uploadId });
    if (!upload) return null;

    let url: string | null = null;
    if (upload.s3Key) {
      url = await ctx.runAction(internal.storage.r2.generateDownloadUrl, {
        key: upload.s3Key,
        downloadFilename: upload.fileName,
      });
    } else if (upload.storageId) {
      url = await ctx.storage.getUrl(upload.storageId as Id<"_storage">);
    }
    return url ? { url, fileName: upload.fileName, fileType: upload.fileType } : null;
  },
});
