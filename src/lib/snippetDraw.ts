/**
 * The one painter. The preview and the exported PNG are the same canvas call,
 * so what a TA moves is exactly what lands in WhatsApp — a DOM preview that
 * only approximates the export is how "it looked fine in the editor" happens.
 *
 * It also reports where each block actually landed, which is what the editor
 * overlays its handles on.
 */

import {
  BLOCK_ORDER,
  LEVEL_BY_KEY,
  PILL_LABEL,
  splitTitle,
  type BlockKey,
  type SnippetFields,
  type SnippetLayout,
  type TextBlock,
} from "./snippet";

export interface Run {
  text: string;
  weight?: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const CARD = 1080;

/** What each block says. Labels like "Package  :  " are design, not content,
 *  so they live here rather than in the fields a TA edits. */
export function blockParagraphs(fields: SnippetFields, key: BlockKey): Run[][] {
  const lead = fields.titleLead !== undefined ? fields.titleLead : splitTitle(fields.jobTitle).lead;
  const main = fields.titleMain !== undefined ? fields.titleMain : splitTitle(fields.jobTitle).main;
  const pill = (k: BlockKey, value: string): Run[][] => [
    [{ text: PILL_LABEL[k] ?? "" }, { text: value, weight: 700 }],
  ];

  switch (key) {
    case "levelPill":
      return [[{ text: LEVEL_BY_KEY[fields.level]?.pill ?? "" }]];
    case "industry":
      return [[{ text: fields.industry }]];
    case "titleLead":
      return [[{ text: lead }]];
    case "titleMain":
      return [[{ text: main }]];
    case "location":
      return pill("location", fields.location);
    case "company":
      return pill("company", fields.company);
    case "packageLine":
      return pill("packageLine", fields.package);
    case "gender":
      return pill("gender", fields.gender);
    case "bullets":
      return fields.bullets.filter((b) => b.trim()).map((b) => [{ text: b.trim() }]);
    case "footer":
      return [
        [
          { text: "TA :    ", weight: 700 },
          {
            text: `E : ${fields.email}${fields.mobile ? `   |    M : ${fields.mobile}` : ""}`,
          },
        ],
      ];
  }
}

function setFont(ctx: CanvasRenderingContext2D, b: TextBlock, font: string, weight: number) {
  ctx.font = `${weight} ${b.size}px "${font}", "Outfit", system-ui, sans-serif`;
  // Chromium supports letterSpacing on the 2D context; elsewhere it is ignored
  // rather than faked, because a hand-kerned fallback measures differently
  // from the real thing and the wrap would drift.
  type Spaced = CanvasRenderingContext2D & { letterSpacing?: string };
  (ctx as Spaced).letterSpacing = `${b.letterSpacing * b.size}px`;
}

function runWidth(ctx: CanvasRenderingContext2D, b: TextBlock, font: string, r: Run) {
  setFont(ctx, b, font, r.weight ?? b.weight);
  return ctx.measureText(r.text).width;
}

/** Greedy word wrap that keeps the weight of each run. */
function wrap(
  ctx: CanvasRenderingContext2D,
  b: TextBlock,
  font: string,
  runs: Run[],
  width: number,
): Run[][] {
  const lines: Run[][] = [];
  let line: Run[] = [];
  let used = 0;

  for (const run of runs) {
    const weight = run.weight ?? b.weight;
    const words = run.text.split(/(\s+)/).filter((w) => w !== "");
    let buf = "";
    setFont(ctx, b, font, weight);

    for (const word of words) {
      const candidate = buf + word;
      if (used + ctx.measureText(candidate).width > width && (buf || line.length)) {
        if (buf) line.push({ text: buf, weight });
        lines.push(line);
        line = [];
        used = 0;
        buf = word.trim() ? word : "";
        setFont(ctx, b, font, weight);
      } else {
        buf = candidate;
      }
    }
    if (buf) {
      line.push({ text: buf, weight });
      used += ctx.measureText(buf).width;
    }
  }
  if (line.length) lines.push(line);
  return lines.length ? lines : [[]];
}

/**
 * Draw one block, and hand back the box it filled. Passing `measureOnly` walks
 * the same path without painting, so the handles never disagree with the ink.
 */
function paintBlock(
  ctx: CanvasRenderingContext2D,
  b: TextBlock,
  font: string,
  paragraphs: Run[][],
  measureOnly = false,
): Box {
  const step = b.lineHeight * b.size;
  const halfLeading = ((b.lineHeight - 1) * b.size) / 2;
  // Canva's list indent, measured off the export: the disc sits 0.75em in from
  // the block edge and the text 1.75em, which is also the hanging indent the
  // wrapped lines align to.
  const bulletIndent = b.bulleted ? b.size * 1.75 : 0;
  const discOffset = b.bulleted ? b.size * 0.75 : 0;
  const textWidth = b.w - bulletIndent;

  ctx.textBaseline = "top";
  let y = b.y + halfLeading;
  let lineCount = 0;

  for (const para of paragraphs) {
    const runs = b.uppercase
      ? para.map((r) => ({ ...r, text: r.text.toUpperCase() }))
      : para;
    const lines = wrap(ctx, b, font, runs, textWidth);

    lines.forEach((line, i) => {
      const total = line.reduce((n, r) => n + runWidth(ctx, b, font, r), 0);
      const left =
        b.align === "center"
          ? b.x + bulletIndent + (textWidth - total) / 2
          : b.align === "right"
            ? b.x + b.w - total
            : b.x + bulletIndent;

      if (!measureOnly) {
        if (b.bulleted && i === 0) {
          setFont(ctx, b, font, b.weight);
          ctx.fillStyle = b.color;
          ctx.fillText("•", b.x + discOffset, y);
        }
        let cursor = left;
        for (const r of line) {
          setFont(ctx, b, font, r.weight ?? b.weight);
          ctx.fillStyle = b.color;
          ctx.fillText(r.text, cursor, y);
          cursor += ctx.measureText(r.text).width;
        }
      }
      y += step;
      lineCount += 1;
    });
  }

  return { x: b.x, y: b.y, w: b.w, h: Math.max(lineCount, 1) * step };
}

export type Boxes = Record<BlockKey, Box>;

/**
 * Paint the whole card over its plate. The plate carries the artwork — ground,
 * logo, the level chip, the four white pill shapes and the requirements panel —
 * exactly as exported from Canva, so nothing here redraws the design.
 */
export function drawSnippet(
  ctx: CanvasRenderingContext2D,
  fields: SnippetFields,
  layout: SnippetLayout,
  plate: HTMLImageElement | null,
): Boxes {
  ctx.clearRect(0, 0, CARD, CARD);
  if (plate) ctx.drawImage(plate, 0, 0, CARD, CARD);
  else {
    ctx.fillStyle = "#f2f3f5";
    ctx.fillRect(0, 0, CARD, CARD);
  }

  const boxes = {} as Boxes;
  for (const key of BLOCK_ORDER) {
    boxes[key] = paintBlock(ctx, layout[key], layout[key].font, blockParagraphs(fields, key));
  }
  return boxes;
}

