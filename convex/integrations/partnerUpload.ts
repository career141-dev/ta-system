import { HeadObjectCommand } from "@aws-sdk/client-s3";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { v } from "convex/values";
import { internalAction, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api";
import { getS3Client } from "../storage/r2";

const registerPartnerFileRef = makeFunctionReference<"mutation", {
  s3Key: string;
  fileName: string;
  fileType: string;
  fileSize: number;
  fileHash: string;
}, string>("integrations/partnerUpload:registerPartnerCvFile") as unknown as FunctionReference<
  "mutation", "internal", { s3Key: string; fileName: string; fileType: string; fileSize: number; fileHash: string }, string
>;

export const registerPartnerCvFile = internalMutation({
  args: {
    s3Key: v.string(),
    fileName: v.string(),
    fileType: v.string(),
    fileSize: v.number(),
    fileHash: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("partnerCvFiles")
      .withIndex("by_s3Key", (q) => q.eq("s3Key", args.s3Key))
      .first();
    if (existing) return existing._id;
    return await ctx.db.insert("partnerCvFiles", {
      ...args,
      uploadedBy: "capacity_planner",
      createdAt: Date.now(),
    });
  },
});

/** Verify the completed signed upload in R2 before registering its file ID. */
export const completePartnerCvUpload = internalAction({
  args: {
    key: v.string(),
    fileName: v.string(),
    fileType: v.string(),
    fileSize: v.number(),
    checksumSha256: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.key.startsWith("partner-uploads/")) throw new Error("Invalid upload key");
    const head = await getS3Client().send(new HeadObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: args.key,
      ChecksumMode: "ENABLED",
    }));
    if (head.ContentLength !== args.fileSize || head.ChecksumSHA256 !== args.checksumSha256) {
      throw new Error("Uploaded file size or checksum did not match the signed request");
    }

    const fileHash = Array.from(Uint8Array.from(atob(args.checksumSha256), (char) => char.charCodeAt(0)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const fileId = await ctx.runMutation(registerPartnerFileRef, {
      s3Key: args.key,
      fileHash,
      fileName: args.fileName,
      fileType: args.fileType,
      fileSize: args.fileSize,
    });
    return { fileId, stored: true, processed: false };
  },
});
