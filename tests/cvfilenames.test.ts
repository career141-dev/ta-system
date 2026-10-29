import assert from "node:assert/strict";
import { cvFileNamesFor } from "../convex/lib/cvUploadLookup";

// 29 Oct: lists learn which rows have a CV file from one call per 50 rows,
// without signing a storage link per row. Each answer must match what
// getCvUploadUrl would have found.
const docs: Record<string, Record<string, unknown>> = {
  "cvUploads:r2": { _id: "cvUploads:r2", s3Key: "cv/a.pdf", fileName: "a.pdf" },
  "cvUploads:stored": { _id: "cvUploads:stored", storageId: "_storage:1", fileName: "b.docx" },
  "cvUploads:lost": { _id: "cvUploads:lost", storageId: "_storage:gone", fileName: "c.pdf" },
  "cvUploads:empty": { _id: "cvUploads:empty", fileName: "d.pdf" },
  "cvUploads:byHash": { _id: "cvUploads:byHash", fileHash: "h1", s3Key: "cv/e.pdf" },
  "candidates:withUpload": { _id: "candidates:withUpload", cvUploadId: "cvUploads:stored" },
  "candidates:lostFile": { _id: "candidates:lostFile", cvUploadId: "cvUploads:lost" },
  "candidates:hashOnly": { _id: "candidates:hashOnly", cvUploadId: "cvUploads:empty", fileHash: "h1" },
};
const ctx = {
  db: {
    normalizeId: (table: string, id: string) => (id.startsWith(`${table}:`) ? id : null),
    get: async (id: string) => docs[id] ?? null,
    system: { get: async (id: string) => (id === "_storage:1" ? { _id: id } : null) },
    query: () => ({
      withIndex: (_name: string, build: (q: { eq: (field: string, value: unknown) => unknown }) => unknown) => {
        let hash: unknown;
        build({ eq: (_field, value) => { hash = value; return null; } });
        return { first: async () => Object.values(docs).find((d) => d.fileHash === hash && d._id !== undefined && String(d._id).startsWith("cvUploads:")) ?? null };
      },
    }),
  },
} as any;
const run = (ids: string[]) => cvFileNamesFor(ctx, ids);

assert.deepEqual(
  await run(["cvUploads:r2", "candidates:withUpload", "candidates:lostFile", "candidates:hashOnly", "candidates:unknown"]),
  { "cvUploads:r2": "a.pdf", "candidates:withUpload": "b.docx", "candidates:hashOnly": "CV.pdf" },
  "An R2 key or a stored file gives a name; a file missing from storage and an unknown id do not",
);
await assert.rejects(() => run(Array.from({ length: 51 }, (_, i) => `cvUploads:${i}`)), /at most 50/);
console.log("  ok  CV file names for list rows match the CV lookup without signing links");
