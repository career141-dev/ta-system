import { externalUrl } from "@/lib/url";

/**
 * A candidate's ways in, each one a press away: call, email, LinkedIn, CV.
 *
 * Lists showed a phone number as plain text and no email at all, so a
 * recruiter opened each profile just to copy them out (25 Sep). Whatever is
 * missing is left out, not shown as a dash.
 */
export function ContactLinks({
  phone,
  email,
  linkedinUrl,
  cvHref,
  className = "",
}: {
  phone?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  /** Where "CV" opens — `/api/cv/<id>`, with `?app=` on an opening. */
  cvHref?: string | null;
  className?: string;
}) {
  const linkedin = externalUrl(linkedinUrl);
  const dial = phone?.replace(/[^\d+]/g, "");
  const link = "text-accent hover:underline";
  const items = [
    dial && (
      <a key="phone" href={`tel:${dial}`} className={`tabular ${link}`}>
        {phone}
      </a>
    ),
    email && (
      <a key="email" href={`mailto:${email}`} className={`break-all ${link}`}>
        {email}
      </a>
    ),
    linkedin && (
      <a key="linkedin" href={linkedin} target="_blank" rel="noreferrer" className={link}>
        LinkedIn ↗
      </a>
    ),
    cvHref && (
      <a key="cv" href={cvHref} target="_blank" rel="noreferrer" className={link}>
        CV ↗
      </a>
    ),
  ].filter(Boolean);
  if (items.length === 0) return null;
  return (
    <p className={`flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] ${className}`}>
      {items.map((item, i) => (
        <span key={i} className="inline-flex items-center gap-2">
          {i > 0 && <span className="text-ink-faint">·</span>}
          {item}
        </span>
      ))}
    </p>
  );
}
