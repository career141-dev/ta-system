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
import { BOX, boxItems, clampBox, layoutBox, noticeText, roughMeasure } from "./preparedCv";

const GREEN = { r: 0.047, g: 0.478, b: 0.047 }; // #0C7A0C
const PAGE = { w: 595.28, h: 841.89 }; // A4 points

export interface CvAnnotation {
  currentSalary?: string | null;
  expectedSalary?: string | null;
  noticePeriod?: string | number | null;
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


export function isSystemNote(note: string): boolean {
  const t = (note ?? "").trim();
  return (
    /^Matched from the database/i.test(t) ||
    /^fit \d+/i.test(t) ||
    /similarity \d+/i.test(t) ||
    /^>Historical/i.test(t) ||
    /^Imported from/i.test(t) ||
    /^Reverse match/i.test(t) ||
    /^System:/i.test(t)
  );
}

/**
 * The box's lines before wrapping (lib/preparedCv). Only what is known: an
 * empty salary is left out rather than printed as "NOT DISCLOSED" (29 Sep).
 */
export function annotationItems(a: CvAnnotation): string[] {
  const np = a.noticePeriod == null ? "" : String(a.noticePeriod).trim();
  return boxItems({
    currentSalary: a.currentSalary?.trim() || null,
    expectedSalary: a.expectedSalary?.trim() || null,
    noticePeriod: np ? noticeText({ noticePeriod: np, noticePeriodDays: null }) : null,
    notes: (a.notes || [])
      .map((n) => n.replace(/^[->•*]\s*/, "").trim())
      .filter((n) => n.length > 0 && !isSystemNote(n)),
  });
}

/** The wrapped lines, measured roughly — for the hand-built fallback PDF. */
export function buildAnnotationLines(a: CvAnnotation): string[] {
  return layoutBox(annotationItems(a), roughMeasure).lines.map((l) => l.text);
}

export function extractCareer141BoxFromText(rawText: string | null | undefined): {
  currentSalary: string | null;
  expectedSalary: string | null;
  noticePeriodDays: number | null;
  noticePeriodText: string | null;
  notes: string[];
} | null {
  if (!rawText || !/CAREER\s*141/i.test(rawText)) return null;

  const text = rawText
    .replace(/&#13;/g, "\n")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");

  const curMatch = text.match(/CURRENT\s+SALARY\s*[-:]\s*([^\n\r]+)/i);
  const expMatch = text.match(/EXPECTED\s+SALARY\s*[-:]\s*([^\n\r]+)/i);
  const noticeMatch = text.match(/NOTICE(?:\s*PERIOD)?\s*[-:]\s*([^\n\r]+)/i);
  const noteMatch = text.match(/NOTE\s*:-?\s*([\s\S]*?)(?=\n[A-Z\s]{4,}:|\n\n[A-Z]|$)/i);

  const cleanVal = (v: string | null | undefined) => {
    if (!v) return null;
    const t = v.trim();
    if (/^NOT\s+DISCLOSED$/i.test(t) || /^OPEN\s+TO\s+DISCUSS$/i.test(t) || /^N\/?A$/i.test(t)) return null;
    return t;
  };

  let noticeDays: number | null = null;
  let noticeText: string | null = null;
  if (noticeMatch) {
    const raw = noticeMatch[1].trim();
    const dMatch = raw.match(/(\d+)/);
    if (dMatch) noticeDays = Number(dMatch[1]);
    else if (/immediate/i.test(raw)) noticeDays = 0;
    noticeText = raw;
  }

  const notes = noteMatch
    ? noteMatch[1]
        .split("\n")
        .map((s) => s.replace(/^[>\-•*]\s*/, "").trim())
        .filter((s) => s.length > 0 && !isSystemNote(s))
    : [];

  return {
    currentSalary: cleanVal(curMatch?.[1]),
    expectedSalary: cleanVal(expMatch?.[1]),
    noticePeriodDays: noticeDays,
    noticePeriodText: noticeText,
    notes,
  };
}

export async function extractCareer141BoxFromPdfBuffer(
  basePdfBuffer: ArrayBuffer | Buffer
): Promise<{
  currentSalary: string | null;
  expectedSalary: string | null;
  noticePeriodDays: number | null;
  noticePeriodText: string | null;
  notes: string[];
} | null> {
  try {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.load(basePdfBuffer, { ignoreEncryption: true });
    if (doc.getPageCount() === 0) return null;
    const page = doc.getPage(0);
    const annots = page.node.Annots();
    if (annots) {
      for (let i = 0; i < annots.size(); i++) {
        const ref = annots.get(i);
        const annotObj = doc.context.lookup(ref) as any;
        const contents = annotObj?.get(doc.context.obj("Contents"))?.toString() || "";
        const rc = annotObj?.get(doc.context.obj("RC"))?.toString() || "";
        const combined = `${contents}\n${rc}`;
        if (/CAREER\s*141/i.test(combined)) {
          const parsed = extractCareer141BoxFromText(combined);
          if (parsed) return parsed;
        }
      }
    }
  } catch {
    /* Fallback */
  }
  return null;
}

/**
 * Stamps the green Career141 box on page one of a candidate's actual CV PDF.
 * If the CV already has a Career141 box stamped, this locates it and cleanly
 * updates the details inside that box with a solid background and green border.
 * If the CV already has a box and no new details are provided, it leaves the
 * original intact without stamping duplicate "NOT DISCLOSED" banners.
 * If no box exists, it stamps it at the top right.
 */
type TextItem = { str?: unknown; transform: number[]; width?: unknown };

/**
 * How much of the page an old, printed Career141 box takes up, from its
 * heading (items[at]) down through its own lines — salary, notice, notes —
 * in the heading's column, while each line is within a line or two of the
 * last. The new box is drawn over all of it: drawn only over the heading, the
 * old salary showed under the new one (the desk, 29 Sep). PDF y runs upward.
 */
export function printedBoxExtent(items: TextItem[], at: number): { width: number; height: number } {
  const x0 = items[at].transform[4];
  const y0 = items[at].transform[5];
  let bottom = y0;
  let right = x0;
  for (let j = at; j < items.length && j < at + 80; j++) {
    const it = items[j];
    if (typeof it.str !== "string" || !it.str.trim()) continue;
    const ix = it.transform[4];
    const iy = it.transform[5];
    if (Math.abs(ix - x0) > 60) continue;
    if (iy > bottom + 2 || bottom - iy > 24) {
      if (iy < bottom) break;
      continue;
    }
    bottom = Math.min(bottom, iy);
    right = Math.max(right, ix + (Number(it.width) || 0));
  }
  // From just above the heading to just below the last line, padded both sides.
  return { height: y0 + 14 - (bottom - 6), width: right - x0 + 16 };
}

export async function stampPdfWithCareer141Box(
  basePdfBuffer: ArrayBuffer | Buffer,
  annotation: CvAnnotation,
  override?: { x: number; y: number },
  fileName?: string | null,
): Promise<Uint8Array> {
  return (await stampCareer141Box(basePdfBuffer, annotation, override, fileName)).bytes;
}

/** Where the box went, from the page's top-left, for the Prepared CV editor. */
export interface StampedBox {
  x: number;
  y: number;
  width: number;
  height: number;
  lines: { text: string; bold: boolean }[];
}

/**
 * The stamp, and where it landed — the editor shows the box at exactly this
 * spot and size, so dragging starts from what prints. `box` is null when there
 * was nothing to stamp.
 */
export async function stampCareer141Box(
  basePdfBuffer: ArrayBuffer | Buffer,
  annotation: CvAnnotation,
  override?: { x: number; y: number },
  fileName?: string | null,
): Promise<{ bytes: Uint8Array; box: StampedBox | null; page: { width: number; height: number } }> {
  const { PDFDocument, rgb, StandardFonts } = await import("pdf-lib");
  const doc = await PDFDocument.load(basePdfBuffer, { ignoreEncryption: true });
  if (doc.getPageCount() === 0) throw new Error("PDF has no pages");
  const page = doc.getPage(0);
  const { width: pageWidth, height: pageHeight } = page.getSize();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

  let foundX: number | null = null;
  let foundY: number | null = null;
  let foundBoxWidth: number | null = null;
  let foundBoxHeight: number | null = null;
  let hasExistingBox = false;
  // A box printed into the page's text (not an annotation): its heading was
  // found, and the new box must cover the heading AND the lines under it.
  let foundInText = false;

  // 1. First check if there is an existing FreeText / text annotation on page 0
  const annots = page.node.Annots();
  if (annots) {
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const annotObj = doc.context.lookup(ref) as any;
      const contents = annotObj?.get(doc.context.obj("Contents"))?.toString() || "";
      const rc = annotObj?.get(doc.context.obj("RC"))?.toString() || "";
      if (/CAREER\s*141/i.test(`${contents} ${rc}`)) {
        hasExistingBox = true;
        const rectArr = annotObj?.get(doc.context.obj("Rect"))?.asArray?.();
        if (rectArr && rectArr.length >= 4) {
          const [x1, y1, x2, y2] = rectArr.map((v: any) =>
            v?.asNumber ? v.asNumber() : Number(v)
          );
          foundX = Math.min(x1, x2);
          foundY = Math.min(y1, y2);
          foundBoxWidth = Math.abs(x2 - x1);
          foundBoxHeight = Math.abs(y2 - y1);
        }
        break;
      }
    }
  }

  // 2. If not found in annotations, search in text streams via pdfjs
  if (!hasExistingBox && !override) {
    try {
      // @ts-ignore
      const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs").catch(() => import("pdfjs-dist/build/pdf.mjs"));
      const copy = Buffer.isBuffer(basePdfBuffer)
        ? Uint8Array.from(basePdfBuffer)
        : new Uint8Array(basePdfBuffer.slice(0));
      const loadingTask = pdfjs.getDocument({
        data: copy,
        useSystemFonts: true,
        disableFontFace: true,
        verbosity: 0,
      });
      const pdfDoc = await loadingTask.promise;
      if (pdfDoc.numPages >= 1) {
        const p1 = await pdfDoc.getPage(1);
        const tc = await p1.getTextContent();
        let at = -1;
        for (let i = 0; i < tc.items.length; i++) {
          const it = tc.items[i];
          if (!("str" in it) || typeof it.str !== "string") continue;
          const next = tc.items[i + 1];
          if (
            /CAREER\s*141/i.test(it.str) ||
            (/CAREER/i.test(it.str) && next && "str" in next && typeof next.str === "string" && /141/i.test(next.str))
          ) {
            hasExistingBox = true;
            foundInText = true;
            foundX = it.transform[4];
            foundY = it.transform[5];
            at = i;
            break;
          }
        }
        /*
         * The old box's own lines — salary, notice, notes — sit under its
         * heading. They were left showing below the new box, which was drawn
         * upward from the heading, so an edited salary appeared next to the
         * old one (the desk, 29 Sep). Follow the lines down from the heading,
         * in its column, while each is within a line or two of the last.
         */
        if (at >= 0) {
          const extent = printedBoxExtent(tc.items, at);
          foundBoxHeight = extent.height;
          foundBoxWidth = extent.width;
        }
      }
    } catch {
      /* Fallback to default placement if detection fails */
    }
  }

  const isAlreadyCareer141 = Boolean(
    hasExistingBox ||
    (fileName && /CAREER\s*141/i.test(fileName))
  );

  const items = annotationItems(annotation);
  const pageSize = { width: pageWidth, height: pageHeight };

  // Nothing recorded for them: no box at all, the original PDF as it is. A
  // typed "Not disclosed" is an answer and counts; an empty field does not.
  if (items.length <= 1) {
    return { bytes: new Uint8Array(basePdfBuffer), box: null, page: pageSize };
  }

  // If re-stamping on a PDF that had a FreeText annotation, strip the old annotation so it does not collide
  if (annots && hasExistingBox) {
    const remainingRefs = [];
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      const annotObj = doc.context.lookup(ref) as any;
      const contents = annotObj?.get(doc.context.obj("Contents"))?.toString() || "";
      const rc = annotObj?.get(doc.context.obj("RC"))?.toString() || "";
      if (!/CAREER\s*141/i.test(`${contents} ${rc}`)) {
        remainingRefs.push(ref);
      }
    }
    page.node.set(doc.context.obj("Annots"), doc.context.obj(remainingRefs));
  }

  // One width and one font size (lib/preparedCv BOX): more text makes the box
  // taller, never the text smaller or bigger. Wrapped with the font's metrics.
  const layout = layoutBox(items, (t, size, bold) => (bold ? fontBold : font).widthOfTextAtSize(t, size));
  const { padding, lineHeight } = BOX;
  // Wide enough to cover a box already on the CV, never narrower than ours.
  const boxWidth = Math.max(foundBoxWidth ?? 0, layout.width);
  const boxHeight = Math.max(foundBoxHeight ?? 0, layout.height);

  let x: number;
  let y: number;

  if (override && Number.isFinite(override.x) && Number.isFinite(override.y)) {
    // The TA's spot, measured from the top-left and kept inside the page.
    const at = clampBox(override, { width: boxWidth, height: boxHeight }, pageSize);
    x = at.x;
    y = pageHeight - at.y - boxHeight;
  } else if (foundX !== null && foundY !== null) {
    // Found existing Career141 box: place the updated box right over it.
    // A printed box is covered from just above its heading down; an
    // annotation's rectangle already starts at its bottom edge.
    x = Math.max(15, Math.min(pageWidth - boxWidth - 15, foundX - (foundInText ? padding : 0)));
    const bottom = foundInText ? foundY + 14 - boxHeight : foundY;
    y = Math.max(15, Math.min(pageHeight - boxHeight - 15, bottom));
  } else {
    // Default top-right placement
    x = Math.max(15, pageWidth - boxWidth - 25);
    const yTop = pageHeight - 25;
    y = Math.max(15, yTop - boxHeight);
  }

  // Draw solid white box with green border to cleanly cover any existing box underneath
  page.drawRectangle({
    x,
    y,
    width: boxWidth,
    height: boxHeight,
    color: rgb(1, 1, 1),
    borderColor: rgb(GREEN.r, GREEN.g, GREEN.b),
    borderWidth: 1.5,
  });

  let textY = y + boxHeight - padding - 10;
  for (const line of layout.lines) {
    page.drawText(line.text, {
      x: x + padding,
      y: textY,
      size: line.bold ? BOX.headerSize : BOX.bodySize,
      font: line.bold ? fontBold : font,
      color: rgb(GREEN.r, GREEN.g, GREEN.b),
    });
    textY -= lineHeight;
  }

  return {
    bytes: await doc.save(),
    box: { x, y: pageHeight - y - boxHeight, width: boxWidth, height: boxHeight, lines: layout.lines },
    page: pageSize,
  };
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

  const content = [page.content, textBlock(lines, x, y, BOX.bodySize, BOX.lineHeight, GREEN)].join("\n");

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
