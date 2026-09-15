import { internalAction, internalMutation } from "../_generated/server";
import { internal, api } from "../_generated/api";
import { v } from "convex/values";
import { adjustGlobalStat } from "../stats/statsHelper";

export const processInboundCV = internalAction({
  args: {
    messageId: v.string(),
    toNumber: v.string(),
    fromNumber: v.string(),
    originalSenderPhone: v.string(),
    mediaId: v.string(),
    mimeType: v.string(),
    fileName: v.union(v.string(), v.null()),
    captionText: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, args) => {
    console.log(`[Meta Cloud API] Downloading media ${args.mediaId}...`);

    // ── 1. Fetch real media binary from Meta Graph API ─────────────────────
    const WHATSAPP_TOKEN = process.env.WHATSAPP_CLOUD_API_TOKEN;
    if (!WHATSAPP_TOKEN) {
      console.error("[WhatsApp Ingestion] WHATSAPP_CLOUD_API_TOKEN env var is not set. Aborting.");
      return;
    }

    // Step 1a: Resolve media URL from media ID
    const mediaMetaResp = await fetch(
      `https://graph.facebook.com/v19.0/${args.mediaId}`,
      { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } }
    );
    if (!mediaMetaResp.ok) {
      console.error(
        `[WhatsApp Ingestion] Failed to get media URL for ${args.mediaId}: ${mediaMetaResp.status} ${mediaMetaResp.statusText}`
      );
      return;
    }
    const mediaMeta = await mediaMetaResp.json() as { url?: string };
    if (!mediaMeta.url) {
      console.error(`[WhatsApp Ingestion] Meta response missing 'url' field for media ${args.mediaId}`);
      return;
    }

    // Step 1b: Download the actual file binary
    const fileResp = await fetch(mediaMeta.url, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    });
    if (!fileResp.ok) {
      console.error(
        `[WhatsApp Ingestion] Failed to download media binary: ${fileResp.status} ${fileResp.statusText}`
      );
      return;
    }
    const fileBuffer = await fileResp.arrayBuffer();
    const mimeType = args.mimeType || fileResp.headers.get("content-type") || "application/pdf";

    // 2. Hash file
    const hashBuffer = await crypto.subtle.digest("SHA-256", fileBuffer);
    const fileHash = Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // 3. Store in Cloudflare R2
    const base64Data = Buffer.from(fileBuffer).toString("base64");
    const s3Key = await ctx.runAction(internal.storage.r2.uploadBufferToR2, {
      fileName: args.fileName || `whatsapp_${args.originalSenderPhone}.pdf`,
      contentType: mimeType,
      base64Data,
    });

    // 4. Update Database
    await ctx.runMutation(internal.cvs.ingestion.insertCvRecord, {
      toNumber: args.toNumber,
      fromNumber: args.fromNumber,
      originalSenderPhone: args.originalSenderPhone,
      fileName: args.fileName,
      s3Key,
      storageProvider: "r2",
      fileHash,
      fileSize: fileBuffer.byteLength,
      captionText: args.captionText ?? undefined,
    });
  },
});

export const generateUploadUrl = internalMutation({
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const insertCvRecord = internalMutation({
  args: {
    toNumber: v.string(),
    fromNumber: v.string(),
    originalSenderPhone: v.string(),
    fileName: v.union(v.string(), v.null()),
    storageId: v.optional(v.id("_storage")),
    s3Key: v.optional(v.string()),
    storageProvider: v.optional(v.string()),
    fileHash: v.string(),
    fileSize: v.number(),
    captionText: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const SESSION_TTL_MS = 48 * 60 * 60 * 1000; // 48 Hours

    let jobId: any = null;
    let sourceLevel2 = "Common Number";
    let metaSourceUrl: string | undefined;
    let metaSourceId: string | undefined;
    let metaHeadline: string | undefined;

    // Normalise phone to digits-only before lookup.
    const cleanOriginalSender = args.originalSenderPhone.replace(/[^0-9]/g, "");

    // Check if there is an active WhatsApp session for the candidate phone
    const session = await ctx.db
      .query("whatsappSessions")
      .withIndex("by_phone", (q) => q.eq("phone", cleanOriginalSender))
      .first();

    if (session) {
      const isExpired = Date.now() - (session.lastInteractionAt || 0) > SESSION_TTL_MS;
      if (isExpired) {
        console.log(`[insertCvRecord] WhatsApp session for +${args.originalSenderPhone} is expired (>48h). Deleting session.`);
        await ctx.db.delete(session._id);
      } else {
        jobId = session.jobId;
        sourceLevel2 = `Campaign — WhatsApp (${session.keyword})`;
        metaSourceUrl = session.metaSourceUrl;
        metaSourceId = session.metaSourceId;
        metaHeadline = session.metaHeadline;
        await ctx.db.patch(session._id, {
          cvReceived: true,
          lastBotReplyAt: Date.now(),
        });
      }
    }

    if (!jobId) {
      const cleanToNumber = args.toNumber.replace(/[^0-9]/g, "");
      let channel = await ctx.db
        .query("jobChannels")
        .withIndex("by_whatsapp", (q) => q.eq("whatsappNumber", cleanToNumber))
        .filter((q) => q.eq(q.field("isEnabled"), true))
        .first();

      if (!channel) {
        channel = await ctx.db
          .query("jobChannels")
          .withIndex("by_whatsapp", (q) => q.eq("whatsappNumber", args.toNumber))
          .filter((q) => q.eq(q.field("isEnabled"), true))
          .first();
      }

      if (channel) {
        jobId = channel.jobId;
        sourceLevel2 = `Campaign — WhatsApp`;
      }
    }

    // Fallback: Infer job from fileName or captionText if session & campaign number lookup yield no jobId
    if (!jobId) {
      const textToSearch = `${args.fileName || ""} ${args.captionText || ""}`.trim();
      if (textToSearch.length >= 3) {
        const activeJobs = await ctx.db
          .query("jobs")
          .withIndex("by_status", (q) => q.eq("status", "active"))
          .collect();
        const upperText = textToSearch.toUpperCase();
        for (const job of activeJobs) {
          const kUpper = (job.keyword || "").trim().toUpperCase();
          const tUpper = (job.title || "").trim().toUpperCase();
          if ((kUpper.length >= 2 && upperText.includes(kUpper)) || (tUpper.length >= 3 && upperText.includes(tUpper))) {
            jobId = job._id;
            sourceLevel2 = `WhatsApp Inferred (${job.keyword || job.title})`;
            console.log(`[insertCvRecord] Inferred jobId ${jobId} (${job.title}) from media fileName/caption: "${textToSearch}"`);
            break;
          }
        }
      }
    }

    // SHA-256 duplicate check (exact file)
    const existingFile = await ctx.db.query("cvUploads")
      .withIndex("by_fileHash", (q) => q.eq("fileHash", args.fileHash))
      .first();

    if (existingFile) {
      console.log(`[cvs/ingestion:insertCvRecord] Duplicate file detected: ${args.fileHash}. CandidateId: ${existingFile.candidateId}`);
      
      const taUser = await ctx.db
        .query("users")
        .withIndex("by_phone", (q) => q.eq("phone", args.fromNumber))
        .first();

      const rawSenderDisplay = taUser ? taUser._id : args.fromNumber;

      if (existingFile.candidateId) {
        let createdAppId: any = null;
        if (jobId) {
          const existingApp = await ctx.db
            .query("applications")
            .withIndex("by_candidateId", (q) => q.eq("candidateId", existingFile.candidateId!))
            .filter((q) => q.eq(q.field("jobId"), jobId))
            .first();

          if (existingApp) {
            console.log(`[insertCvRecord] Candidate ${existingFile.candidateId} already has application ${existingApp._id} for job ${jobId}. Patching lastCandidateReplyAt.`);
            await ctx.db.patch(existingApp._id, {
              lastCandidateReplyAt: Date.now(),
            });
            createdAppId = existingApp._id;
          } else {
            const now = Date.now();
            createdAppId = await ctx.db.insert("applications", {
              candidateId: existingFile.candidateId,
              jobId: jobId,
              currentStage: "new_cvs",
              sourceChannel: "whatsapp",
              createdAt: now,
              isActive: true,
              lastStageChangedAt: now,
              loopIteration: 0,
              stageHistory: [{
                stage: "new_cvs",
                enteredAt: new Date(now).toISOString(),
                changedBy: "system",
              }],
            } as any);
            console.log(`[insertCvRecord] Created new application ${createdAppId} for existing candidate ${existingFile.candidateId} under job ${jobId}`);
          }
        }

        await ctx.db.insert("ingestionLog", {
          jobId: jobId || undefined,
          channelType: "whatsapp",
          rawSender: rawSenderDisplay,
          routingStatus: jobId ? "routed" : "duplicate_file",
          cvFileId: existingFile._id,
          candidateId: existingFile.candidateId,
          receivedAt: Date.now(),
          stage: jobId ? "queued" : "failed",
        } as any);

        return { success: true, reason: "duplicate_file_linked", existingFileId: existingFile._id, applicationId: createdAppId };
      }

      // Candidate record is missing. Evaluate retry eligibility:
      const currentStatus = existingFile.status;
      const attempts = existingFile.extractionAttempts ?? 0;

      if (currentStatus === "pending" || currentStatus === "processing") {
        console.log(`[insertCvRecord] WhatsApp upload ${existingFile._id} is already in-flight (status: ${currentStatus}). No-op.`);
        return { success: false, reason: "in_flight", existingFileId: existingFile._id };
      }

      if (currentStatus === "needs_review") {
        console.log(`[insertCvRecord] WhatsApp upload ${existingFile._id} is flagged as needs_review. Skipping automatic retry.`);
        return { success: false, reason: "needs_review", existingFileId: existingFile._id };
      }

      if (currentStatus === "failed" && attempts < 1) {
        console.log(`[insertCvRecord] Re-triggering WhatsApp extraction for failed upload ${existingFile._id} (attempt ${attempts + 1})...`);
        const now = Date.now();
        await ctx.db.patch(existingFile._id, {
          status: "pending",
          extractionAttempts: attempts + 1,
          lastAttemptAt: now,
          s3Key: args.s3Key ?? existingFile.s3Key,
          storageId: args.storageId ?? existingFile.storageId,
          storageProvider: args.storageProvider ?? existingFile.storageProvider,
          assignToJob: jobId ? (jobId as string) : existingFile.assignToJob,
          errorMessage: undefined,
        });

        const logId = await ctx.db.insert("ingestionLog", {
          jobId: jobId || undefined,
          channelType: "whatsapp",
          rawSender: rawSenderDisplay,
          routingStatus: jobId ? "routed" : "unrouted",
          cvFileId: existingFile._id,
          receivedAt: now,
          stage: "queued",
          candidateName: "Unknown — Re-triggering Extraction",
        } as any);

        await ctx.scheduler.runAfter(0, api.cvs.cvExtraction.processCvExtraction, {
          cvUploadId: existingFile._id,
          storageId: args.storageId ?? existingFile.storageId,
          s3Key: args.s3Key ?? existingFile.s3Key,
          storageProvider: args.storageProvider ?? existingFile.storageProvider,
          fileType: "application/pdf",
          uploadedBy: taUser ? taUser._id : "system",
          sourceChannel: "whatsapp",
          skipLLM: false,
          logId: logId,
        });

        return { success: true, reason: "retriggered", existingFileId: existingFile._id };
      }

      // Max attempts reached (attempts >= 1)
      if (currentStatus === "failed" && attempts >= 1) {
        console.warn(`[insertCvRecord] WhatsApp upload ${existingFile._id} reached max attempts (${attempts}). Transitioning to extraction_failed_permanent.`);
        await ctx.db.patch(existingFile._id, {
          status: "extraction_failed_permanent",
          errorMessage: "Permanent extraction failure — attempt cap reached (1 retry max)",
        });
      }

      await ctx.db.insert("ingestionLog", {
        jobId: jobId || undefined,
        channelType: "whatsapp",
        rawSender: rawSenderDisplay,
        routingStatus: "duplicate_file",
        cvFileId: existingFile._id,
        receivedAt: Date.now(),
        stage: "extraction_failed_permanent",
        errorMessage: `Extraction attempt limit reached (${attempts} attempt(s)). Marked as soft-terminal.`,
      } as any);

      return { success: false, reason: "extraction_failed_permanent", existingFileId: existingFile._id };
    }

    const taUser = await ctx.db
      .query("users")
      .withIndex("by_phone", (q) => q.eq("phone", args.fromNumber))
      .first();

    const rawSenderDisplay = taUser ? taUser._id : args.fromNumber;

    let candidate = await ctx.db
      .query("candidates")
      .withIndex("by_phone", (q) => q.eq("phone", args.originalSenderPhone))
      .first();

    if (!candidate) {
      const now = Date.now();
      const candidateId = await ctx.db.insert("candidates", {
        phone: args.originalSenderPhone,
        firstSourceChannel: "whatsapp",
        firstSeenAt: now,
        lastUpdatedAt: now,
        fullName: `WhatsApp Candidate (${args.originalSenderPhone.slice(-4)})`,
        email: "",
        status: "active",
      });
      candidate = await ctx.db.get(candidateId);
      await adjustGlobalStat(ctx, "new_candidate");
    }

    const cvUploadId = await ctx.db.insert("cvUploads", {
      candidateId: candidate!._id,
      storageId: args.storageId,
      s3Key: args.s3Key,
      storageProvider: args.storageProvider,
      fileName: args.fileName || `cv_whatsapp_${Date.now()}.pdf`,
      fileSize: args.fileSize,
      fileType: "application/pdf",
      fileHash: args.fileHash,
      source: "whatsapp",
      campaignLabel: sourceLevel2,
      metaSourceUrl,
      metaSourceId,
      metaHeadline,
      assignToJob: jobId ? (jobId as string) : undefined,
      uploadedBy: taUser ? taUser._id : "system",
      status: "queued",
    });
    
    await adjustGlobalStat(ctx, "new_cv_upload", 1, { sourceChannel: "whatsapp" });

    const logId = await ctx.db.insert("ingestionLog", {
      jobId: jobId || undefined,
      channelType: "whatsapp",
      rawSender: rawSenderDisplay,
      routingStatus: jobId ? "routed" : "unrouted",
      cvFileId: cvUploadId,
      candidateId: candidate!._id,
      processingTimeMs: 0,
      receivedAt: Date.now(),
      candidateName: candidate!.fullName || "Unknown",
      stage: "queued",
    });

    // 8. Check Channel Toggles for Pausing
    const configRow = await ctx.db.query("appSettings").withIndex("by_key", q => q.eq("key", "system")).first();
    const toggles = configRow?.channel_toggles;
    
    if (toggles?.whatsappIngestion === false) {
      await ctx.db.patch(cvUploadId, { status: "paused" });
      await ctx.db.patch(logId, { stage: "paused" });
      console.log(`[insertCvRecord] WhatsApp is paused. CV ${cvUploadId} queued for later.`);
    } else {
      await ctx.scheduler.runAfter(0, api.cvs.cvExtraction.processCvExtraction, {
        cvUploadId,
        storageId: args.storageId,
        s3Key: args.s3Key,
        storageProvider: args.storageProvider,
        fileType: "application/pdf",
        uploadedBy: taUser ? taUser._id : "system",
        sourceChannel: "whatsapp",
        skipLLM: false,
      });
    }
  }
});

export const resumePausedUploads = internalMutation({
  args: {
    channel: v.union(v.literal("whatsapp"), v.literal("email"), v.literal("email_campaign"))
  },
  handler: async (ctx, args) => {
    const pausedUploads = await ctx.db.query("cvUploads")
      .withIndex("by_status", q => q.eq("status", "paused"))
      .filter(q => q.eq(q.field("source"), args.channel))
      .collect();

    let resumedCount = 0;
    for (const upload of pausedUploads) {
      if (!upload.storageId) continue;
      
      await ctx.db.patch(upload._id, { status: "queued" });
      
      // Update ingestionLog if exists
      const log = await ctx.db.query("ingestionLog")
        .withIndex("by_cvFileId", q => q.eq("cvFileId", upload._id))
        .first();
      if (log) {
        await ctx.db.patch(log._id, { stage: "queued" });
      }

      await ctx.scheduler.runAfter(0, api.cvs.cvExtraction.processCvExtraction, {
        cvUploadId: upload._id,
        storageId: upload.storageId,
        s3Key: upload.s3Key,
        storageProvider: upload.storageProvider,
        fileType: upload.fileType || "application/pdf",
        uploadedBy: upload.uploadedBy || "system",
        sourceChannel: upload.source || "unknown",
        skipLLM: false,
        logId: log?._id,
      });
      resumedCount++;
    }
    
    return { success: true, resumedCount };
  }
});
