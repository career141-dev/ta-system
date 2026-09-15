import { httpAction } from "../_generated/server";
import { api, internal } from "../_generated/api";

// Helper to extract Meta Campaign ID from referral payload (if present)
function extractMetaCampaignId(referralData?: string | null): string | undefined {
  if (!referralData) return undefined;
  // Stub implementation based on typical Meta API payload
  // Usually the ReferralNumMedia contains a payload or you can parse JSON
  return "meta_12345";
}

// Runs as an HTTP Action — triggered by Twilio webhook
export const handleWhatsappWebhook = httpAction(async (ctx, request) => {
  const body = await request.formData();
  
  const from = body.get("From") as string; // e.g. "whatsapp:+94771234567"
  const messageBody = (body.get("Body") as string) ?? "";
  const numMedia = parseInt((body.get("NumMedia") as string) ?? "0");
  const mediaUrl = body.get("MediaUrl0") as string; // CV file URL (if attached)
  const mediaType = body.get("MediaContentType0") as string; // e.g. application/pdf
  
  const fromClean = from.replace("whatsapp:", "");
  const checkResult = await ctx.runMutation(internal.communications.whatsappOutbound.checkAndRecordFollowUpReply, {
    senderPhone: fromClean,
    textBody: messageBody,
  });

  if (checkResult && checkResult.isFollowUpReply) {
    console.log(`[Twilio Webhook] Recorded follow-up reply from ${from}`);
    return new Response("OK", { status: 200 });
  }

  // Extract keyword from first word of message
  const firstWord = messageBody.trim().split(/\s+/)[0]?.toUpperCase();

  // Find job by keyword
  let job = null;
  if (firstWord) {
    job = await ctx.runQuery(api.jobs.jobs.getByKeyword, { keyword: firstWord });
  }

  // AI fallback if no keyword found (Stubbed for now)
  // if (!job && numMedia > 0) {
  //   job = await ctx.runAction("matchingAgent:matchCvToOpenJobs", { mediaUrl });
  // }

  if (!job || job.status !== "active") {
    // Reply asking for keyword
    console.log(`[Twilio Mock] Send to ${from}: Hi! Please start your message with the job code...`);
    return new Response("OK", { status: 200 });
  }

  if (numMedia === 0) {
    console.log(`[Twilio Mock] Send to ${from}: Got it! To apply for ${job.title}, send CV...`);
    return new Response("OK", { status: 200 });
  }

  // 1. Download CV from Twilio media URL
  // (In production, you'd use your TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN)
  const fileResponse = await fetch(mediaUrl, {
    headers: {
      Authorization: "Basic " + btoa((process.env.TWILIO_ACCOUNT_SID || "") + ":" + (process.env.TWILIO_AUTH_TOKEN || ""))
    }
  });
  
  if (!fileResponse.ok) {
    console.error("Failed to fetch file from Twilio");
    return new Response("Error fetching media", { status: 500 });
  }

  const fileBlob = await fileResponse.blob();
  const fileSizeBytes = fileBlob.size;
  
  // 2. Hash the file in memory before storing it (bypasses mutation limits)
  const fileBuffer = await fileBlob.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest("SHA-256", fileBuffer);
  const fileHash = Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  // 3. Store in Cloudflare R2
  const base64Data = Buffer.from(fileBuffer).toString("base64");
  const fileName = `cv_whatsapp_${Date.now()}.pdf`;
  const s3Key = await ctx.runAction(internal.storage.r2.uploadBufferToR2, {
    fileName,
    contentType: mediaType || "application/pdf",
    base64Data,
  });

  // 4. Check if this is Meta Campaign
  const referralData = body.get("ReferralNumMedia") ?? body.get("ButtonPayload");
  const metaCampaignId = extractMetaCampaignId(referralData as string | null);

  // 5. Process central ingestion pipeline
  const result = await ctx.runMutation(api.pipeline.ingestion.processCvIngestion, {
    jobId: job._id,
    sourceChannel: metaCampaignId ? "meta_campaign" : "whatsapp",
    rawSender: from,
    s3Key: s3Key,
    storageProvider: "r2",
    fileHash: fileHash,
    fileName,
    fileType: mediaType || "application/pdf",
    fileSizeBytes: fileSizeBytes,
    metaCampaignId,
  });

  if (result.success) {
    console.log(`[Twilio Mock] Send to ${from}: Thank you! We received your CV for ${job.title}.`);
  } else if (result.reason === "duplicate_file") {
    console.log(`[Twilio Mock] Send to ${from}: We already have this exact CV on file!`);
  }

  return new Response("OK", { status: 200 });
});
