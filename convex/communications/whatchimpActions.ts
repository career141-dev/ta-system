"use node";
import { internalAction } from "../_generated/server";
import { api, internal } from "../_generated/api";
import { v } from "convex/values";
import { sendMetaFreeText } from "./metaDirectSender";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getS3Client } from "../storage/r2";
import crypto from "crypto";

/**
 * High-memory, async Node.js handler for incoming WhatsApp media documents.
 * Runs in Node runtime (512MB+ RAM) to effortlessly process any size PDF without OOM crashes.
 */
export const processInboundMedia = internalAction({
  args: {
    mediaUrl: v.string(),
    fileName: v.string(),
    mimeType: v.string(),
    cleanFrom: v.string(),
    cleanTo: v.string(),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const { mediaUrl, fileName, mimeType, cleanFrom, cleanTo, text } = args;
    try {
      console.log(`[processInboundMedia] Downloading media from ${mediaUrl} for +${cleanFrom}...`);
      const fileResponse = await fetch(mediaUrl);
      if (!fileResponse.ok) {
        throw new Error(`Failed to fetch file from WhatChimp media URL. Status: ${fileResponse.status}`);
      }
      const arrayBuffer = await fileResponse.arrayBuffer();
      const fileBuffer = Buffer.from(arrayBuffer);

      // Instant native crypto SHA-256
      const fileHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");

      // Upload directly to Cloudflare R2 via PutObjectCommand (Node buffer stream)
      const s3 = getS3Client();
      const safeName = (fileName || "cv.pdf").replace(/[^a-zA-Z0-9.\-_]/g, "_");
      const date = new Date();
      const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      const s3Key = `cvs/${yearMonth}/${Date.now()}-${safeName}`;

      const command = new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: s3Key,
        ContentType: mimeType || "application/pdf",
        Body: fileBuffer,
      });
      await s3.send(command);
      console.log(`[processInboundMedia] Uploaded ${fileName} to R2 key ${s3Key} (${fileBuffer.length} bytes)`);

      // Resolve Job
      let resolvedJobId: string | null | undefined = null;
      let metaSourceUrl, metaSourceId, metaHeadline;

      if (text) {
        const upperText = text.toUpperCase();
        const activeJobs = await ctx.runQuery(api.jobs.jobs.getActiveJobsBasicInfo);
        for (const job of activeJobs) {
          const pausedChannels: string[] = (job as any).pausedChannels || [];
          if (pausedChannels.includes("whatsapp")) continue;
          if (job.keyword && upperText.includes(job.keyword.toUpperCase())) {
            resolvedJobId = job._id;
            break;
          }
        }
      }

      if (!resolvedJobId) {
        const session = await ctx.runQuery(api.communications.whatchimp.getSessionByPhone, {
          phone: cleanFrom,
        });
        if (session) {
          resolvedJobId = session.jobId;
          metaSourceUrl = session.metaSourceUrl;
          metaSourceId = session.metaSourceId;
          metaHeadline = session.metaHeadline;
          console.log(`[processInboundMedia] Resolved job ID ${resolvedJobId} from session for +${cleanFrom}`);
        }
      }

      const ingestionResult = await ctx.runMutation(api.pipeline.ingestion.processCvIngestion, {
        jobId: resolvedJobId ? (resolvedJobId as any) : undefined,
        fileName: fileName || "cv.pdf",
        fileSizeBytes: fileBuffer.length,
        fileType: mimeType || "application/pdf",
        fileHash,
        s3Key,
        storageProvider: "r2",
        sourceChannel: "whatsapp",
        rawSender: cleanFrom,
        metaSourceUrl,
        metaSourceId,
        metaHeadline,
      });
      console.log(`[processInboundMedia] Ingested CV for candidate +${cleanFrom} (jobId: ${resolvedJobId}). Result:`, ingestionResult);

      // Mark CV as received in session state so the chatbot never asks for CV again and maintains context
      if (ingestionResult && (ingestionResult as any).reason !== "duplicate_file") {
        if (resolvedJobId) {
          await ctx.runMutation(api.communications.whatchimp.upsertSession, {
            phone: cleanFrom,
            jobId: resolvedJobId as any,
            keyword: "CV_UPLOADED",
            metaSourceUrl,
            metaSourceId,
            metaHeadline,
          });
        }
        await ctx.runMutation(api.communications.whatchimp.updateSessionState, {
          phone: cleanFrom,
          cvReceived: true,
          lastBotReplyAt: Date.now(),
        });
      }

      // WhatsApp reply confirmation
      const fetchedPhoneId = await ctx.runQuery(internal.communications.whatsappOutbound.getMetaPhoneNumberId, { 
        targetWhatsAppNumber: cleanTo 
      });
      const phoneNumberId = fetchedPhoneId || process.env.META_PHONE_NUMBER_ID || "965783109962872";
      if (phoneNumberId) {
        let replyMessage = "Thank you! Your CV has been successfully received and is being processed by our system. We will contact you if there is a match.";
        if (ingestionResult && (ingestionResult as any).reason === "duplicate_file") {
           replyMessage = "We already have this exact CV on file for this position. We'll be in touch if your profile matches our requirements. Thank you!";
        }
        const metaAccessToken = process.env.META_ACCESS_TOKEN || "";
        await sendMetaFreeText(phoneNumberId, cleanFrom, replyMessage, metaAccessToken)
          .then(r => { if (!r.success) console.error("[WhatsApp Webhook] CV ack reply failed:", r.error); })
          .catch(console.error);
      }
    } catch (err: any) {
      console.error("[processInboundMedia] Error processing media:", err.message || err);
    }
  },
});
