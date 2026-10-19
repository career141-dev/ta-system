import type { StrategyAssignment, User } from "@/data/types";
import { isTicked, proofsVisibleTo, strategyAcceptanceStatus } from "@/lib/strategyPlanner";
import { isTa } from "@/lib/auth";

/**
 * The rules for the proof picture a TA may attach to a strategy row (8 Oct).
 * Pure, so they are tested; the upload and serve routes only apply them.
 *
 * What is refused, and why: anything that is not really a PNG, JPEG or WebP.
 * The browser's idea of the type is not trusted (a file's own first bytes are
 * read), and SVG and HTML are refused outright because the picture is served
 * back from this site, where either would run as a script.
 */

export const PROOF_MAX_BYTES = 5 * 1024 * 1024;
export const PROOF_MAX_PER_ROW = 5;
export const PROOF_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export type ProofType = (typeof PROOF_TYPES)[number];

/** What a file is, from its first bytes; null when it is not one of the three. */
export function sniffImage(bytes: Uint8Array): ProofType | null {
  const at = (i: number) => bytes[i];
  if (bytes.length >= 8 && at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47 && at(4) === 0x0d && at(5) === 0x0a && at(6) === 0x1a && at(7) === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  // "RIFF" ???? "WEBP"
  if (
    bytes.length >= 12 &&
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 &&
    at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export type ProofCheck = { ok: true; contentType: ProofType } | { ok: false; message: string; status: number };

/** Whether a file may be attached: its size, its real type, and how many the row already has. */
export function checkProofUpload(input: { size: number; head: Uint8Array; existing: number }): ProofCheck {
  if (input.size === 0) return { ok: false, message: "Choose a picture first.", status: 400 };
  if (input.size > PROOF_MAX_BYTES) {
    return { ok: false, message: `That picture is over ${PROOF_MAX_BYTES / 1024 / 1024} MB. Save a smaller screenshot and try again.`, status: 413 };
  }
  if (input.existing >= PROOF_MAX_PER_ROW) {
    return { ok: false, message: `A strategy can hold ${PROOF_MAX_PER_ROW} pictures. Remove one to add another.`, status: 409 };
  }
  const contentType = sniffImage(input.head);
  if (!contentType) return { ok: false, message: "Only PNG, JPEG or WebP pictures can be attached.", status: 415 };
  return { ok: true, contentType };
}

/**
 * A TA may attach to a strategy ticked for the job and not struck through (the
 * route has already checked they are on the job). A lead does not attach for them.
 */
export function mayAttachProof(user: Pick<User, "id" | "role" | "isActive">, row: StrategyAssignment): boolean {
  return user.isActive && isTa(user) && !row.notApplicable && isTicked(row) && strategyAcceptanceStatus(row, user.id) !== "pending";
}

/** Whether this person may open this picture: a lead the submitted ones, a TA their own. */
export function mayOpenProof(user: Pick<User, "id" | "role" | "isActive">, row: StrategyAssignment, proofId: string): boolean {
  return user.isActive && proofsVisibleTo(row, user).some((p) => p.id === proofId);
}
