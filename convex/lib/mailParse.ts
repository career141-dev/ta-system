// convex/lib/mailParse.ts
//
// Reading an application email: who applied, to what, and which attachments
// are a CV. Pure — no Graph, no database — so it is tested on its own
// (tests/mailparse.test.ts).
//
// The old poller never read the email itself: it took identity only from an
// attached CV and dropped any message without one. A LinkedIn "new applicant"
// notification with no résumé attached still names the person, links their
// profile and names the job — enough to put them in the database and on the
// right opening — so it is read here rather than thrown away.

import { linkedinJobId } from "./postRouting";

export interface MailAttachmentMeta {
  id: string;
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
  isInline?: boolean | null;
  /** "#microsoft.graph.fileAttachment" for a file; item and reference attachments are not files. */
  "@odata.type"?: string | null;
}

export interface ParsedApplication {
  /** Sent by LinkedIn's job notifications. */
  isLinkedIn: boolean;
  linkedinJobId: string | null;
  /** From the subject ("… from Nimal Perera", "Nimal Perera applied to …"). */
  applicantName: string | null;
  /** The applicant's public profile, when the notification links it. */
  profileUrl: string | null;
  /** An address in the body that is not ours or LinkedIn's. */
  email: string | null;
  phone: string | null;
  /** The body as plain text, for routing and the log. */
  text: string;
}

export const MAX_CV_BYTES = 25 * 1024 * 1024;
const CV_EXT = /\.(pdf|docx?|rtf)$/i;
const CV_MIME = /(pdf|msword|officedocument\.wordprocessingml|rtf)/i;

/** An attachment worth treating as a CV: a real file, a CV type, not a logo in the signature. */
export function isCvAttachment(a: MailAttachmentMeta): boolean {
  const type = a["@odata.type"];
  if (type && !/fileAttachment$/i.test(type)) return false;
  if (a.isInline) return false;
  if ((a.size ?? 0) > MAX_CV_BYTES) return false;
  const name = a.name ?? "";
  const mime = a.contentType ?? "";
  // "application/octet-stream" is how some mail clients send any file; the
  // name decides then.
  return CV_EXT.test(name) || (CV_MIME.test(mime) && !/octet-stream/i.test(mime));
}

/** HTML mail body → readable text, links kept so a LinkedIn URL survives. */
export function htmlToText(html: string): string {
  return String(html ?? "")
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, " $2 $1 ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

const NAME_PATTERNS: RegExp[] = [
  // "New application: Brand Manager from Nimal Perera"
  /\bfrom\s+([A-Z][\p{L}'.-]+(?:\s+[A-Z][\p{L}'.-]+){0,3})\s*$/u,
  // "Nimal Perera applied to Brand Manager at Delmo" / "… applied for your job …"
  /^(?:(?:re|fw|fwd)\s*:\s*)?([A-Z][\p{L}'.-]+(?:\s+[A-Z][\p{L}'.-]+){0,3})\s+(?:has\s+)?applied\s+(?:to|for)\b/u,
];

function nameFromSubject(subject: string): string | null {
  const s = subject.replace(/\s+/g, " ").trim();
  for (const re of NAME_PATTERNS) {
    const m = s.match(re);
    if (m?.[1] && m[1].split(" ").length >= 1 && m[1].length <= 60) return m[1].trim();
  }
  return null;
}

const OUR_DOMAINS = /@(career141\.com|[a-z0-9-]+\.onmicrosoft\.com|linkedin\.com|e\.linkedin\.com|bounce\.linkedin\.com)$/i;

/**
 * Mail that is not an application: our own addresses (including the tenant's
 * onmicrosoft.com domain) and automatic replies. On linkedin@ these were half
 * of all mail on 16 September — "Automatic reply: RE: New application: …"
 * generated inside the company, never with a CV.
 */
export function isNotAnApplication(fromAddress: string, subject: string): boolean {
  const from = (fromAddress ?? "").toLowerCase();
  if (/@(career141\.com|[a-z0-9-]+\.onmicrosoft\.com)$/.test(from)) return true;
  return isAutoReply(fromAddress, subject);
}

/**
 * Bounces and automatic replies only. shortlists@ uses this rather than
 * isNotAnApplication, because the Director writes from a career141.com address
 * and his shortlists are exactly the mail that has to be read.
 */
export function isAutoReply(fromAddress: string, subject: string): boolean {
  const from = (fromAddress ?? "").toLowerCase();
  if (/^(mailer-daemon|postmaster|no-?reply-?notifications?)@/.test(from)) return true;
  return /^\s*(automatic reply|auto(?:matic)?[- ]?reply|out of (?:the )?office|undeliverable|delivery (?:status notification|has failed)|mail delivery failed|read:|not read:)/i.test(subject ?? "");
}

export function parseApplicationEmail(input: {
  subject: string | null | undefined;
  fromAddress: string | null | undefined;
  bodyHtml?: string | null;
  bodyText?: string | null;
}): ParsedApplication {
  const subject = input.subject ?? "";
  const from = (input.fromAddress ?? "").toLowerCase();
  const text = input.bodyText?.trim() ? input.bodyText : htmlToText(input.bodyHtml ?? "");
  const rawForLinks = `${input.bodyHtml ?? ""}\n${text}`;

  const isLinkedIn = /@(?:[a-z0-9-]+\.)*linkedin\.com$/i.test(from);

  const profile = rawForLinks.match(/https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:comm\/)?in\/([A-Za-z0-9\-_%]+)/i);
  const profileUrl = profile ? `https://www.linkedin.com/in/${profile[1]}` : null;

  const email =
    (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) ?? [])
      .map((e) => e.toLowerCase())
      .find((e) => !OUR_DOMAINS.test(e)) ?? null;

  // Sri Lankan and international numbers as people write them in a message.
  const phoneMatch = text.match(/(?:\+?94|0)\s?7\d[\s-]?\d{3}[\s-]?\d{4}|\+\d{1,3}[\s-]?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}/);
  const phone = phoneMatch ? phoneMatch[0].replace(/[\s-]/g, "") : null;

  return {
    isLinkedIn,
    linkedinJobId: linkedinJobId(rawForLinks) ?? linkedinJobId(subject),
    applicantName: nameFromSubject(subject),
    profileUrl,
    email: isLinkedIn && email === from ? null : email,
    phone,
    text: text.slice(0, 20000),
  };
}
