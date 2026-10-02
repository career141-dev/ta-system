import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { action, internalAction } from "../_generated/server";
import { v } from "convex/values";
import { outboundLocked } from "../lib/outboundGuard";

/*
 * Test deployments keep their files at home.
 *
 * A deployment with the outbound lock on (every one that is not production)
 * READS the production bucket — that is where the 77k candidates' CVs are —
 * but never WRITES to it: a CV read from the inbox during a test is stored in
 * this deployment's own file storage, under a "convex:<storageId>" key that
 * the download and read functions below resolve. Production is unchanged.
 */
const LOCAL_PREFIX = "convex:";
const localId = (key: string) => (key.startsWith(LOCAL_PREFIX) ? key.slice(LOCAL_PREFIX.length) : null);

// Helper to initialize S3 client for Cloudflare R2
export function getS3Client() {
  return new S3Client({
    region: "auto", // R2 uses 'auto'
    endpoint: process.env.R2_ENDPOINT!,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
}

/**
 * Action to generate a pre-signed URL for uploading a CV from the frontend.
 */
export const generateUploadUrl = action({
  args: {
    fileName: v.string(),
    contentType: v.string(),
  },
  handler: async (ctx, args) => {
    const s3 = getS3Client();
    // Clean filename and create a unique key
    const safeName = args.fileName.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    const date = new Date();
    const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const key = `cvs/${yearMonth}/${Date.now()}-${safeName}`;

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: key,
      ContentType: args.contentType,
    });

    // Generate URL that expires in 1 hour
    const url = await getSignedUrl(s3, command, { expiresIn: 3600 });
    return { url, key };
  },
});

/**
 * Action to generate a pre-signed URL for downloading/viewing a CV.
 */
export const generateDownloadUrl = action({
  args: { 
    key: v.string(),
    downloadFilename: v.optional(v.string())
  },
  handler: async (ctx, args) => {
    const local = localId(args.key);
    if (local) return (await ctx.storage.getUrl(local as never)) ?? "";
    const s3 = getS3Client();
    
    // Support setting Content-Disposition for proper filename download
    const params: any = {
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: args.key,
    };
    
    if (args.downloadFilename) {
      params.ResponseContentDisposition = `attachment; filename="${args.downloadFilename}"`;
    }

    const command = new GetObjectCommand(params);
    // URL valid for 1 hour
    return await getSignedUrl(s3, command, { expiresIn: 3600 });
  },
});

/**
 * Internal action used by backend (like WhatsApp webhook) to upload a buffer to R2
 * since we can't do this inside a mutation.
 */
/**
 * Remove a CV file that a newer CV of the same person replaced (2 Oct).
 * Callers (cvs/cvReplace.ts) have already moved every record off the file, so
 * this is the last step. A deployment with the outbound lock on never writes
 * to the production bucket — it deletes only its own "convex:" files.
 */
export const deleteCvFile = internalAction({
  args: { s3Key: v.optional(v.string()), storageId: v.optional(v.id("_storage")) },
  handler: async (ctx, args) => {
    const local = args.s3Key ? localId(args.s3Key) : null;
    if (args.storageId || local) {
      await ctx.storage.delete((args.storageId ?? local) as any).catch(() => undefined);
      return "deleted-local";
    }
    if (!args.s3Key) return "nothing";
    if (outboundLocked()) {
      console.log(`[R2] outbound lock on — not deleting ${args.s3Key} from the bucket`);
      return "skipped-locked";
    }
    await getS3Client().send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME!, Key: args.s3Key }));
    return "deleted-r2";
  },
});

export const uploadBufferToR2 = internalAction({
  args: {
    fileName: v.string(),
    contentType: v.string(),
    base64Data: v.string(), // We send base64 over action args
  },
  handler: async (ctx, args) => {
    const s3 = getS3Client();
    const safeName = args.fileName.replace(/[^a-zA-Z0-9.\-_]/g, "_");
    const date = new Date();
    const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    const key = `cvs/${yearMonth}/${Date.now()}-${safeName}`;
    const binaryString = atob(args.base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    if (outboundLocked()) {
      const storageId = await ctx.storage.store(new Blob([bytes], { type: args.contentType }));
      return `${LOCAL_PREFIX}${storageId}`;
    }

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: key,
      ContentType: args.contentType,
      Body: bytes,
    });

    let attempts = 0;
    while (attempts < 3) {
      try {
        attempts++;
        await s3.send(command);
        return key;
      } catch (err: any) {
        if (attempts >= 3) throw err;
        console.warn(`[R2 Upload] Cloudflare R2 connection flicker (attempt ${attempts}/3), retrying in ${attempts * 1000}ms...`, err?.message || err);
        await new Promise((r) => setTimeout(r, attempts * 1000));
      }
    }
    return key;
  },
});

export const uploadLogoToR2 = action({
  args: {
    key: v.string(),
    contentType: v.string(),
    base64Data: v.string(),
  },
  handler: async (ctx, args) => {
    const s3 = getS3Client();
    const binaryString = atob(args.base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: args.key,
      ContentType: args.contentType,
      Body: bytes,
    });

    await s3.send(command);
    console.log(`[R2 Logo Upload] Successfully uploaded ${args.key} to R2 bucket ${process.env.R2_BUCKET_NAME}`);
    return args.key;
  },
});

/**
 * Uploads extracted CV raw text to Cloudflare R2 object storage.
 * Saves memory by not storing multi-page string blobs in Convex SQLite/RAM.
 */
export const uploadCvRawTextToR2 = internalAction({
  args: {
    candidateId: v.string(),
    cvUploadId: v.string(),
    rawText: v.string(),
  },
  handler: async (ctx, args) => {
    const s3 = getS3Client();
    const key = `cv-rawtext/${args.candidateId}/${args.cvUploadId}.txt`;
    const encoder = new TextEncoder();
    const bytes = encoder.encode(args.rawText);
    if (outboundLocked()) {
      const storageId = await ctx.storage.store(new Blob([bytes], { type: "text/plain; charset=utf-8" }));
      return `${LOCAL_PREFIX}${storageId}`;
    }

    const command = new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: key,
      ContentType: "text/plain; charset=utf-8",
      Body: bytes,
    });

    let attempts = 0;
    while (attempts < 3) {
      try {
        attempts++;
        await s3.send(command);
        return key;
      } catch (err: any) {
        if (attempts >= 3) throw err;
        console.warn(`[R2 RawText Upload] Flicker on key ${key} (attempt ${attempts}/3), retrying in ${attempts * 1000}ms...`, err?.message || err);
        await new Promise((r) => setTimeout(r, attempts * 1000));
      }
    }
    return key;
  },
});

/**
 * Fetches raw CV text from Cloudflare R2 object storage by rawTextKey.
 */
export const getResumeRawText = action({
  args: {
    rawTextKey: v.string(),
  },
  handler: async (ctx, args): Promise<string | null> => {
    try {
      const local = localId(args.rawTextKey);
      if (local) {
        const blob = await ctx.storage.get(local as never);
        return blob ? await blob.text() : null;
      }
      const s3 = getS3Client();
      const command = new GetObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME!,
        Key: args.rawTextKey,
      });

      const response = await s3.send(command);
      if (!response.Body) return null;

      // Convert body stream to string
      const str = await response.Body.transformToString("utf-8");
      return str;
    } catch (err: any) {
      console.warn(`[getResumeRawText] Failed to fetch R2 raw text for key ${args.rawTextKey}:`, err?.message || err);
      return null;
    }
  },
});

/**
 * Action: Finds Chamin Tharuka's CV attachment in Microsoft 365, uploads it to Cloudflare R2,
 * and links the s3Key to the candidate profile and cvUpload record.
 */
export const repairAndLinkChaminCv = action({
  args: {
    candidateEmail: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const { getGraphToken } = await import("../lib/graphClient");
    const { api } = await import("../_generated/api");
    
    const targetEmail = (args.candidateEmail || "tharukav@gmail.com").toLowerCase().trim();
    const token = await getGraphToken();
    if (!token) throw new Error("Could not acquire Microsoft Graph token");

    const mailboxes = ["azeem@career141.com", "job@career141.com", "jesmeen@career141.com"];

    for (const mb of mailboxes) {
      const searchUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
        mb
      )}/messages?$select=id,subject,hasAttachments,receivedDateTime,from&$top=15&$search="${encodeURIComponent(
        targetEmail
      )}"`;

      const qRes = await fetch(searchUrl, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });

      let messages: any[] = [];
      if (qRes.ok) {
        const qData: any = await qRes.json();
        messages = (qData.value || []).filter((m: any) => m.hasAttachments);
      }

      if (messages.length === 0) {
        const filterUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
          mb
        )}/messages?$select=id,subject,hasAttachments,receivedDateTime,from&$top=15&$filter=hasAttachments eq true and from/emailAddress/address eq '${encodeURIComponent(
          targetEmail
        )}'`;
        const fRes = await fetch(filterUrl, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        });
        if (fRes.ok) {
          const fData: any = await fRes.json();
          messages = fData.value || [];
        }
      }

      for (const msg of messages) {
        const attachUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
          mb
        )}/messages/${msg.id}/attachments?$select=id,name,contentType,size`;

        const aRes = await fetch(attachUrl, {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        });
        if (!aRes.ok) continue;

        const aData: any = await aRes.json();
        const attachments = aData.value || [];

        for (const att of attachments) {
          const lowerName = (att.name || "").toLowerCase();
          if (!lowerName.endsWith(".pdf") && !lowerName.endsWith(".docx") && !lowerName.endsWith(".doc")) continue;

          const contentUrl = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(
            mb
          )}/messages/${msg.id}/attachments/${att.id}`;

          const cRes = await fetch(contentUrl, {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          });
          if (!cRes.ok) continue;

          const cData: any = await cRes.json();
          const contentBytes = cData.contentBytes;
          if (!contentBytes) continue;

          const binaryString = atob(contentBytes);
          const fileBuffer = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            fileBuffer[i] = binaryString.charCodeAt(i);
          }

          const hashBuffer = await crypto.subtle.digest("SHA-256", fileBuffer.buffer as ArrayBuffer);
          const fileHash = Array.from(new Uint8Array(hashBuffer))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");

          const s3 = getS3Client();
          const safeName = (att.name || "cv.pdf").replace(/[^a-zA-Z0-9.\-_]/g, "_");
          const date = new Date();
          const yearMonth = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
          const s3Key = `cvs/${yearMonth}/${Date.now()}-${safeName}`;

          const uploadCmd = new PutObjectCommand({
            Bucket: process.env.R2_BUCKET_NAME!,
            Key: s3Key,
            ContentType: att.contentType || "application/pdf",
            Body: fileBuffer,
          });

          await s3.send(uploadCmd);

          // Update cvUploads and candidates in Convex
          await ctx.runMutation(api.communications.emailBackfillMutations.updateCvUploadWithR2Key, {
            cvUploadId: "jd78vmt8cvc5j6ye8zxks58zzx8ajcsp" as any,
            candidateId: "j974fpbfgf2jwkaykmaghnszks8akxyn" as any,
            s3Key,
            storageProvider: "r2",
            fileHash,
            fileSize: fileBuffer.length,
            fileName: att.name,
            fileType: att.contentType || "application/pdf",
          });

          return {
            success: true,
            s3Key,
            fileName: att.name,
            fileHash,
            fileSize: fileBuffer.length,
            previewUrl: `/api/r2-file?key=${encodeURIComponent(s3Key)}`,
            mailbox: mb,
          };
        }
      }
    }

    return { success: false, message: `No attachment found for ${targetEmail} in mailboxes.` };
  },
});


