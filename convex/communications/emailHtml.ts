// Shared clean-text HTML email builder for the Career141 follow-up system (Agent 3).
// Renders outbound emails (Day 0 outreach, thread replies, nudges) as simple,
// natural recruiter emails — plain paragraphs, `•` bullet lines and `<br/>` line
// breaks, without heavy banner cards or colored boxes.
// Pure helper module (no Convex runtime directive) so it can be imported from
// actions, mutations, and helper files alike.

export interface StructuredEmailContent {
  candidateName: string;
  jobTitle: string;
  /** Main intro / body paragraph(s). Newlines are converted to <br/>. */
  prelude?: string;
  /** AI-generated answer shown as a plain paragraph in the body. */
  aiAnswer?: string | null;
  /** Details successfully recorded from the candidate's reply (e.g. "Notice Period: 21 Days"). */
  recordedDetails?: string[];
  /** Remaining missing items that are still required to progress the application. */
  remainingMissing?: string[];
  /** Overrides the "We are still waiting on..." header shown above the missing bullets. */
  missingHeader?: string;
  /** Overrides the default call-to-action line. */
  ctaText?: string;
  senderEmail?: string;
}

function escHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Strip markdown asterisks (`*bold*` / `**bold**`) and normalize newlines to
// <br/> so the email reads as clean natural text.
function cleanText(value: string): string {
  return escHtml(value).replace(/\*/g, "").replace(/\n/g, "<br/>");
}

const P_STYLE = "margin:0 0 16px;color:#334155;font-size:15px;line-height:1.6;";
const BULLET_P_STYLE = "margin:0 0 16px;color:#334155;font-size:15px;line-height:1.6;";

function para(content: string, style = P_STYLE): string {
  return `<p style="${style}">${content}</p>`;
}

/**
 * Builds a clean, natural-text styled HTML email for the Career141 follow-up
 * system. Used for the initial Day 0 outreach email, immediate thread replies
 * to candidate emails, and automated 24-hour follow-up nudges.
 */
export function buildStructuredEmailHtml(opts: StructuredEmailContent): string {
  const {
    candidateName,
    jobTitle,
    prelude,
    aiAnswer,
    recordedDetails,
    remainingMissing,
    missingHeader,
    ctaText,
    senderEmail,
  } = opts;

  const blocks: string[] = [];

  blocks.push(para(`Hi ${cleanText(candidateName)},`));

  if (prelude) {
    blocks.push(para(cleanText(prelude)));
  }

  if (aiAnswer) {
    blocks.push(para(cleanText(aiAnswer)));
  }

  if (recordedDetails && recordedDetails.length > 0) {
    blocks.push(
      para(
        recordedDetails.map((d) => `• ${cleanText(d)}`).join("<br/>"),
        BULLET_P_STYLE
      )
    );
  }

  if (remainingMissing && remainingMissing.length > 0) {
    const header =
      missingHeader ??
      `We are still waiting on the following to progress your application for ${cleanText(jobTitle)}:`;
    blocks.push(para(cleanText(header)));
    blocks.push(
      para(
        remainingMissing.map((m) => `• ${cleanText(m)}`).join("<br/>"),
        BULLET_P_STYLE
      )
    );
  }

  const cta = ctaText || "Please reply to this email with these details at your earliest convenience. Thank you!";
  blocks.push(para(cleanText(cta)));

  const signature = senderEmail
    ? `Best regards,<br/>Talent Acquisition Team<br/>Career141<br/>${cleanText(senderEmail)}`
    : `Best regards,<br/>Talent Acquisition Team<br/>Career141`;
  blocks.push(para(signature));

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#f8fafc;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;padding:24px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#ffffff;padding:32px;border-radius:8px;">
          <tr>
            <td>
              ${blocks.join("")}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
