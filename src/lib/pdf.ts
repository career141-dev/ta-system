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

/**
 * The stand-in CV page. Deliberately plain and labelled, so nobody mistakes it
 * for a real parsed CV — the point of this build is the annotation, not the
 * document under it.
 */
/**
 * What the stand-in page occupies, in PDF coordinates (origin bottom-left).
 * At connection this list comes from pdfjs reading the candidate's real CV
 * instead; nothing downstream changes.
 */
export function placeholderOccupancy(): Box[] {
  return [
    { x: 56, y: PAGE.h - 92, w: 300, h: 26 }, // name
    { x: 56, y: PAGE.h - 116, w: 300, h: 30 }, // title and location
    { x: 56, y: PAGE.h - 122, w: PAGE.w - 112, h: 6 }, // rule
    { x: 56, y: PAGE.h - 460, w: 320, h: 150 }, // body
    { x: 56, y: 34, w: 330, h: 14 }, // footer mark
  ];
}

function placeholderCv(s: CvSubject): string {
  const black = { r: 0.1, g: 0.1, b: 0.1 };
  const grey = { r: 0.45, g: 0.45, b: 0.45 };

  const header = textBlock([s.fullName.toUpperCase()], 56, PAGE.h - 80, 17, 20, black);
  const sub = textBlock(
    [
      [s.currentTitle, s.currentEmployer].filter(Boolean).join(" · "),
      [s.location, s.totalExperienceYears ? `${s.totalExperienceYears} years` : null]
        .filter(Boolean)
        .join(" · "),
    ].filter(Boolean),
    56,
    PAGE.h - 102,
    10,
    14,
    grey,
  );
  const body = textBlock(
    [
      "PROFILE",
      "",
      "EXPERIENCE",
      `${s.currentTitle ?? "Current role"} — ${s.currentEmployer ?? "Current employer"}`,
      "",
      "EDUCATION",
      [s.educationDegree, s.educationInstitution].filter(Boolean).join(", ") || "—",
      "",
      "REFERENCES",
      "Available on request",
    ],
    56,
    PAGE.h - 330,
    10,
    16,
    black,
  );
  const mark = textBlock(
    ["[ Stand-in CV page — the candidate's real CV replaces this at connection ]"],
    56,
    40,
    7.5,
    10,
    { r: 0.62, g: 0.62, b: 0.62 },
  );
  const rule = `0.85 0.85 0.85 RG 0.7 w 56 ${PAGE.h - 118} m ${PAGE.w - 56} ${PAGE.h - 118} l S`;

  return [header, sub, rule, body, mark].join("\n");
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
  const placement = findPlacement({ x: 0, y: 0, w: PAGE.w, h: PAGE.h }, block, placeholderOccupancy());

  const x = override?.x ?? placement.box.x;
  // PDF text draws from the baseline of the first line, downward.
  const yTop = override?.y ?? placement.box.y;
  const y = PAGE.h - yTop - 12;

  const content = [placeholderCv(subject), textBlock(lines, x, y, 10, 11.2, GREEN)].join("\n");

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
