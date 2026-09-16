/**
 * A very small PDF writer — enough to produce the prepared CV.
 *
 * The format is taken from `ANOJ - CAREER141.pdf`: a green Helvetica 10pt
 * block stamped on page one, reading CAREER141 CANDIDATE, the two salary
 * lines, then NOTE:- and bullets. Same colour (#0C7A0C), same face, same size,
 * so what the Director opens looks like the ones the desk already sends.
 *
 * In the standalone build the page underneath is a stand-in, clearly marked.
 * At connection the same annotation is drawn over the candidate's real CV
 * fetched from storage; only the base page changes.
 */

import { blockSize, findPlacement, type Box } from "./placement";

const GREEN = { r: 0.047, g: 0.478, b: 0.047 }; // #0C7A0C
const PAGE = { w: 595.28, h: 841.89 }; // A4 points

export interface CvAnnotation {
  currentSalary: string;
  expectedSalary: string;
  notes: string[];
}

export interface CvSubject {
  fullName: string;
  currentTitle: string | null;
  currentEmployer: string | null;
  location: string | null;
  totalExperienceYears: number | null;
  educationDegree: string | null;
  educationInstitution: string | null;
  /** The CV's structure as extracted — when present the page is built from it. */
  summary?: string | null;
  career?: { title: string; employer: string | null; from: string | null; to: string | null; current: boolean }[];
  education?: { degree: string | null; field: string | null; institution: string | null; year: string | null }[];
  skills?: string[];
  languages?: string[];
  certifications?: string[];
}

/** Latin-1 only: the page's font cannot draw anything else. */
const latin1 = (t: string) =>
  t.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—•]/g, "-").replace(/[^\x20-\xff]/g, "");

/**
 * The CV page, built from the structure extraction read out of the candidate's
 * CV: summary, dated career, education, skills. Returns the drawing and the
 * boxes it covers, so the annotation is placed off the candidate's details.
 */
export function structuredCv(s: CvSubject): { content: string; occupancy: Box[] } {
  const black = { r: 0.1, g: 0.1, b: 0.1 };
  const grey = { r: 0.45, g: 0.45, b: 0.45 };
  const left = 56;
  const width = PAGE.w - 112;
  const parts: string[] = [];
  const occupancy: Box[] = [];
  let y = PAGE.h - 80;
  const floor = 60;
  const put = (lines: string[], size: number, colour = black, lead = size * 1.4) => {
    const room = Math.max(0, Math.floor((y - floor) / lead));
    const shown = lines.map(latin1).filter(Boolean).slice(0, room);
    if (shown.length === 0) return;
    parts.push(textBlock(shown, left, y, size, lead, colour));
    const longest = Math.max(...shown.map((l) => l.length));
    occupancy.push({ x: left, y: PAGE.h - y - size, w: Math.min(width, longest * size * 0.5 + 4), h: shown.length * lead + 2 });
    y -= shown.length * lead;
  };
  const heading = (t: string) => {
    y -= 8;
    put([t], 9.5, grey, 14);
  };

  put([s.fullName.toUpperCase()], 17, black, 22);
  put(
    [
      [s.currentTitle, s.currentEmployer].filter(Boolean).join(" - "),
      [s.location, s.totalExperienceYears ? `${s.totalExperienceYears} years' experience` : null].filter(Boolean).join(" - "),
    ],
    10,
    grey,
    14,
  );
  parts.push(`0.85 0.85 0.85 RG 0.7 w ${left} ${y - 2} m ${PAGE.w - 56} ${y - 2} l S`);
  occupancy.push({ x: left, y: PAGE.h - y, w: width, h: 6 });
  y -= 12;

  if (s.summary) {
    heading("PROFILE");
    put(wrap(s.summary, Math.floor(width / 4.75)).slice(0, 6), 9.5);
  }
  const career = s.career ?? [];
  if (career.length || s.currentTitle || s.currentEmployer) {
    heading("EXPERIENCE");
    const rows = career.length
      ? career.slice(0, 8).map((r) => {
          const dates = [r.from, r.current ? "Present" : r.to].filter(Boolean).join(" - ");
          return `${r.title}${r.employer ? ` - ${r.employer}` : ""}${dates ? `   (${dates})` : ""}`;
        })
      : [[s.currentTitle, s.currentEmployer].filter(Boolean).join(" - ")];
    put(rows, 9.5, black, 13.5);
  }
  const education = (s.education ?? [])
    .map((e) => [[e.degree, e.field].filter(Boolean).join(", "), e.institution, e.year].filter(Boolean).join(" - "))
    .filter(Boolean);
  if (!education.length && (s.educationDegree || s.educationInstitution)) {
    education.push([s.educationDegree, s.educationInstitution].filter(Boolean).join(", "));
  }
  if (education.length) {
    heading("EDUCATION");
    put(education.slice(0, 4), 9.5, black, 13.5);
  }
  if (s.skills?.length) {
    heading("SKILLS");
    put(wrap(s.skills.slice(0, 40).join(", "), Math.floor(width / 4.75)).slice(0, 4), 9.5);
  }
  const extra = [
    s.languages?.length ? `Languages: ${s.languages.join(", ")}` : "",
    s.certifications?.length ? `Certifications: ${s.certifications.slice(0, 6).join(", ")}` : "",
  ].filter(Boolean);
  if (extra.length) {
    heading("OTHER");
    put(extra.flatMap((t) => wrap(t, Math.floor(width / 4.75))).slice(0, 4), 9.5);
  }
  heading("REFERENCES");
  put(["Available on request"], 9.5);

  return { content: parts.join("\n"), occupancy };
}

/** PDF strings escape these three characters and nothing else. */
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Helvetica is roughly 0.5em average; good enough to wrap a note line. */
function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > maxChars) {
      if (line) lines.push(line.trim());
      line = w;
    } else {
      line = (line + " " + w).trim();
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Every line wraps at the block width — a package line like
 *  "BASIC RS 610K + FUEL + DRIVER ALLOWANCE 50K" runs off the page otherwise. */
const BLOCK_CHARS = 46;

export function buildAnnotationLines(a: CvAnnotation): string[] {
  const lines = ["CAREER141 CANDIDATE"];

  const labelled = (label: string, value: string) => {
    const parts = wrap(`${label} - ${value}`, BLOCK_CHARS);
    lines.push(parts[0]);
    for (const p of parts.slice(1)) lines.push(`  ${p}`);
  };

  labelled("CURRENT SALARY", a.currentSalary || "NOT DISCLOSED");
  labelled("EXPECTED SALARY", a.expectedSalary || "OPEN TO DISCUSS");

  if (a.notes.length) {
    lines.push("NOTE:-");
    for (const n of a.notes) {
      const parts = wrap(n, BLOCK_CHARS - 2);
      lines.push(`- ${parts[0]}`);
      for (const p of parts.slice(1)) lines.push(`  ${p}`);
    }
  }
  return lines;
}

function textBlock(
  lines: string[],
  x: number,
  y: number,
  size: number,
  leading: number,
  colour: { r: number; g: number; b: number },
): string {
  const out = [
    "BT",
    `/F1 ${size} Tf`,
    `${colour.r} ${colour.g} ${colour.b} rg`,
    `${leading} TL`,
    `1 0 0 1 ${x} ${y} Tm`,
  ];
  lines.forEach((l, i) => {
    out.push(`(${esc(l)}) Tj`);
    if (i < lines.length - 1) out.push("T*");
  });
  out.push("ET");
  return out.join("\n");
}

export function buildPreparedCv(
  subject: CvSubject,
  annotation: CvAnnotation,
  /** Override from the draggable preview — a TA's judgement beats the solver. */
  override?: { x: number; y: number },
): { pdf: Buffer; placement: ReturnType<typeof findPlacement> } {
  const lines = buildAnnotationLines(annotation);

  // Spec §8 — placed where it does not cover the candidate's information.
  // Decided against what the page actually occupies, not by convention.
  const block = blockSize(lines);
  const page = structuredCv(subject);
  const placement = findPlacement({ x: 0, y: 0, w: PAGE.w, h: PAGE.h }, block, page.occupancy);

  const x = override?.x ?? placement.box.x;
  // PDF text draws from the baseline of the first line, downward.
  const yTop = override?.y ?? placement.box.y;
  const y = PAGE.h - yTop - 12;

  const content = [page.content, textBlock(lines, x, y, 10, 11.2, GREEN)].join("\n");

  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE.w} ${PAGE.h}] ` +
      `/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefAt = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;

  return { pdf: Buffer.from(pdf, "latin1"), placement };
}

/** Spec §8 / notebook page 4 — the filename the desk uses. */
export function preparedCvFileName(fullName: string): string {
  return `${fullName} - Career141.pdf`;
}
