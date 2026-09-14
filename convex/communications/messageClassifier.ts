// convex/communications/messageClassifier.ts
//
// Classifies incoming WhatsApp messages so the orchestration layer can route
// each message to exactly ONE handler and produce exactly ONE reply.
//
// No Convex imports — this is a pure utility used by both the flat WhatChimp
// handler and the standard Meta Cloud API handler.

export type MessageType =
  | "cv_document"          // PDF / DOCX / DOC attached — real CV
  | "portfolio_url"        // Behance / Dribbble / Wix / personal site
  | "youtube_url"          // YouTube / Vimeo — work sample video
  | "drive_url"            // Google Drive / Dropbox / WeTransfer — external file
  | "plain_url"            // Any other URL — treat as text
  | "question"             // Candidate asking something (ends with ? or contains question words)
  | "employment_pref"      // "I only do freelance / project-based" etc.
  | "ineligible"           // Explicit "not interested" / "wrong job"
  | "plain_text";          // Everything else

export interface MessageClassification {
  type: MessageType;
  /** Populated for cv_document — the detected MIME type */
  cvMimeType?: string;
  /** Populated for portfolio_url / youtube_url / drive_url — the extracted URL */
  detectedUrl?: string;
  /** Populated for employment_pref — "freelance" | "fulltime" | "parttime" */
  employmentPreference?: "freelance" | "fulltime" | "parttime";
  /** True when the text body contains a question regardless of primary type */
  hasQuestion: boolean;
}

// ── URL pattern helpers ────────────────────────────────────────────────────────

const PORTFOLIO_HOSTS = [
  "behance.net", "dribbble.com", "wix.com", "wixsite.com",
  "carbonmade.com", "coroflot.com", "cargo.site", "squarespace.com",
  "myportfolio.com", "krop.com", "format.com", "crevado.com",
  "issuu.com", "artstation.com", "deviantart.com", "portfolio",
];

const VIDEO_HOSTS = [
  "youtube.com", "youtu.be", "vimeo.com", "tiktok.com", "instagram.com",
];

const DRIVE_HOSTS = [
  "drive.google.com", "dropbox.com", "wetransfer.com", "onedrive.live.com",
  "sharepoint.com", "box.com",
];

const CV_MIME_TYPES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.oasis.opendocument.text",
];

const CV_EXTENSIONS = [".pdf", ".doc", ".docx", ".odt", ".rtf"];

// ── Employment preference patterns ────────────────────────────────────────────

const FREELANCE_PATTERNS = [
  /\bfreelance\b/i,
  /\bproject[- ]based\b/i,
  /\bcontract[- ]only\b/i,
  /\bpart[- ]time only\b/i,
  /\bonly available for freelance\b/i,
  /\bnot looking for full[- ]?time\b/i,
  /\bonly for remote freelance\b/i,
];

const NOT_INTERESTED_PATTERNS = [
  /\bnot interested\b/i,
  /\bno thank you\b/i,
  /\bno thanks\b/i,
  /\bnot looking\b/i,
  /\bnot suitable\b/i,
  /\bwrong job\b/i,
  /\bnot for me\b/i,
  /\bi'll pass\b/i,
  /\bnot applying\b/i,
];

const QUESTION_WORDS = [
  /\?/,
  /\bwhat\b/i, /\bwhere\b/i, /\bwhen\b/i, /\bhow\b/i,
  /\bwhy\b/i, /\bwho\b/i, /\bwhich\b/i, /\bcan i\b/i,
  /\bdo you\b/i, /\bis it\b/i, /\bare you\b/i, /\bwill it\b/i,
  /\bremote\b/i, /\bhybrid\b/i, /\bsalary\b/i, /\bvisa\b/i,
  /\bbenefits\b/i, /\bcompany\b/i, /\bteam\b/i, /\bculture\b/i,
];

// ── URL extractor ─────────────────────────────────────────────────────────────

function extractUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/[^\s]+/i);
  return match?.[0];
}

function classifyUrl(url: string): MessageType {
  const lower = url.toLowerCase();
  if (VIDEO_HOSTS.some(h => lower.includes(h))) return "youtube_url";
  if (PORTFOLIO_HOSTS.some(h => lower.includes(h))) return "portfolio_url";
  if (DRIVE_HOSTS.some(h => lower.includes(h))) return "drive_url";
  return "plain_url";
}

// ── Main classifier ───────────────────────────────────────────────────────────

/**
 * Classifies an incoming WhatsApp message into a typed category.
 *
 * @param text      The text body of the message (may be empty for media-only messages)
 * @param mediaUrl  The media/file URL extracted from the payload (if any)
 * @param mimeType  The MIME type of the attached file (if any)
 * @param fileName  The filename of the attached file (if any)
 */
export function classifyMessage(
  text: string,
  mediaUrl?: string,
  mimeType?: string,
  fileName?: string,
): MessageClassification {
  const hasQuestion = QUESTION_WORDS.some(p => p.test(text || ""));

  // ── 1. Attached file — check mime + filename ─────────────────────────────
  if (mediaUrl) {
    const fileNameLower = (fileName || "").toLowerCase();
    const mimeMatches = mimeType && CV_MIME_TYPES.some(m => mimeType.includes(m));
    const extMatches = CV_EXTENSIONS.some(e => fileNameLower.endsWith(e));

    if (mimeMatches || extMatches) {
      return { type: "cv_document", cvMimeType: mimeType, hasQuestion };
    }

    // Non-CV media (image, audio, sticker) — treat as plain_text so the AI
    // can respond appropriately rather than the system crashing on a sticker.
    return { type: "plain_text", hasQuestion };
  }

  // ── 2. URL in text body ───────────────────────────────────────────────────
  const urlInText = extractUrl(text || "");
  if (urlInText) {
    const urlType = classifyUrl(urlInText);
    if (urlType !== "plain_url") {
      return { type: urlType, detectedUrl: urlInText, hasQuestion };
    }
  }

  // ── 3. Employment preference ──────────────────────────────────────────────
  if (FREELANCE_PATTERNS.some(p => p.test(text || ""))) {
    return { type: "employment_pref", employmentPreference: "freelance", hasQuestion };
  }

  // ── 4. Not interested ─────────────────────────────────────────────────────
  if (NOT_INTERESTED_PATTERNS.some(p => p.test(text || ""))) {
    return { type: "ineligible", hasQuestion: false };
  }

  // ── 5. Question ───────────────────────────────────────────────────────────
  if (hasQuestion) {
    return { type: "question", hasQuestion: true };
  }

  // ── 6. Default: plain text ────────────────────────────────────────────────
  return { type: "plain_text", hasQuestion };
}
