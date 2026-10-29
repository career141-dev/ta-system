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

/*
 * Where the quoted thread starts in a reply. Gmail: "On Tue, 28 Oct 2026 at
 * 10:02, Career141 <job@…> wrote:". Outlook: an underscore rule, or a
 * "From: … Sent: …" header block. Older clients: "-----Original Message-----"
 * and "> " lines.
 */
const QUOTE_START: RegExp[] = [
  /^\s*On\b.{0,200}\bwrote:\s*$/im,
  /^\s*_{10,}\s*$/m,
  /^\s*-{2,}\s*Original Message\s*-{2,}/im,
  /^\s*From:\s.+\n(?:.*\n){0,3}?\s*(?:Sent|Date):\s/im,
  /^\s*>/m,
];

/**
 * Only what the candidate wrote this time: HTML to text, the quoted thread cut
 * off.
 *
 * The reply bot was handed the raw HTML body with our own earlier email
 * quoted under it, so "Current Salary / Expected Salary / Notice Period" from
 * OUR message was read as the candidate's, and every "?" in it made the reply
 * a question (29 Oct). Empty when they wrote nothing above the quote.
 */
export function latestReplyText(body: string): string {
  // "\r\n" first: "." does not match "\r", so Outlook's "From: … Sent:" block
  // was never found. HTML only when there are real tags — a plain-text reply
  // quoting "<job@career141.com>" is not HTML.
  const raw = String(body ?? "").replace(/\r\n?/g, "\n");
  const text = /<\/?(?:p|div|br|span|html|body|table|blockquote)\b/i.test(raw) ? htmlToText(raw) : raw;
  let cut = text.length;
  for (const re of QUOTE_START) {
    const m = re.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  return text.slice(0, cut).split("\n").map((l) => l.trim()).join("\n").trim();
}

/**
 * An out-of-office or other automatic reply: by its subject ("Automatic reply:",
 * "Out of Office:", "Auto:"), or by an opening that says it is automatic. Only
 * words a person would not write themselves count — "I'm on leave until
 * Monday, will send my CV then" is a real answer with a real date.
 */
export function isAutomaticReply(subject: string | undefined, body: string): boolean {
  if (/^\s*(automatic reply|auto(?:matic)?[- ]?response|out of (?:the )?office|auto)\s*:/i.test(subject ?? "")) return true;
  return /\b(this is an automatic(?:ally generated)? (?:reply|response|message)|auto-?reply)\b/i.test(String(body ?? "").slice(0, 300));
}
