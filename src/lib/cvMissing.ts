// src/lib/cvMissing.ts
//
// Candidates whose CV file did not survive the move off Convex Cloud, shared
// by the backend (convex/ta/cvFiles2809.ts marks them) and the screens.
//
// 5,434 CVs uploaded 7 Jul – 12 Aug 2026 were in Convex Cloud file storage and
// were never copied to the self-hosted backend, so 2,977 profiles show
// "Historical CV file pending…" and "Still needed: CV" (counted 28 Sep). Until
// the files are copied they are kept out of search, reverse match and
// automatic database matches: a TA cannot send anyone without a CV.
//
// The mark is the id of the upload that is missing, not a yes/no, so it lifts
// by itself the moment the candidate gets any other CV — a TA uploading one,
// a new application by email — without every place that links a CV knowing
// about it. Copying the old file back in place clears it (storageMigration).

export function cvFileMissing(c: { cvMissingUploadId?: string | null; cvUploadId?: string | null }): boolean {
  return !!c.cvMissingUploadId && c.cvMissingUploadId === c.cvUploadId;
}
