/**
 * Where the CAREER141 block goes on page one — spec §8.
 *
 * The first version stamped it top-right by convention. That is an assumption,
 * not a guarantee: plenty of CVs put a photo, a contact column or a header bar
 * exactly there, and covering a candidate's phone number is the one mistake
 * this feature cannot be allowed to make.
 *
 * So placement is decided against the page's actual occupied regions:
 *
 *   1. Take the bounding boxes of everything drawn on page one.
 *   2. Test candidate positions in preference order.
 *   3. Return the first that clears every box by a margin.
 *   4. If none clears, say so — never stamp over content silently.
 *
 * In the standalone build the boxes come from the stand-in page we draw. At
 * connection they come from pdfjs, which already parses CVs in the existing
 * app and reports each text item with a transform matrix. `findPlacement` does
 * not care which produced them.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacementResult {
  ok: boolean;
  box: Box;
  /** Which candidate position was taken, for the UI to explain itself. */
  where: string;
  /** True when nothing was clear and the block had to go on its own page. */
  ownPage: boolean;
  /** Boxes it would have collided with, for the preview to draw. */
  collisions: Box[];
}

const MARGIN = 12;

export function overlaps(a: Box, b: Box, margin = MARGIN): boolean {
  return !(
    a.x + a.w + margin <= b.x ||
    b.x + b.w + margin <= a.x ||
    a.y + a.h + margin <= b.y ||
    b.y + b.h + margin <= a.y
  );
}

/**
 * Preference order matches how the desk reads a CV: top right first because it
 * is clear on most layouts and the Director sees it immediately; then the foot
 * of the page; then the left margin; then mid-page gaps.
 */
export function candidatePositions(page: Box, block: Box): { where: string; box: Box }[] {
  const pad = 40;
  const positions: { where: string; box: Box }[] = [
    {
      where: "top right",
      box: { x: page.w - block.w - pad, y: pad + 20, w: block.w, h: block.h },
    },
    {
      where: "bottom right",
      box: { x: page.w - block.w - pad, y: page.h - block.h - pad, w: block.w, h: block.h },
    },
    {
      where: "bottom left",
      box: { x: pad, y: page.h - block.h - pad, w: block.w, h: block.h },
    },
    {
      where: "top left",
      box: { x: pad, y: pad + 20, w: block.w, h: block.h },
    },
  ];

  // Then sweep down the right column looking for a gap between blocks of text.
  for (let y = pad + 120; y + block.h < page.h - pad; y += 40) {
    positions.push({
      where: "right margin",
      box: { x: page.w - block.w - pad, y, w: block.w, h: block.h },
    });
  }
  return positions;
}

export function findPlacement(page: Box, block: Box, occupied: Box[]): PlacementResult {
  for (const { where, box } of candidatePositions(page, block)) {
    const hits = occupied.filter((o) => overlaps(box, o));
    if (hits.length === 0) {
      return { ok: true, box, where, ownPage: false, collisions: [] };
    }
  }

  // Nothing on page one is clear. Spec §8 said prefer top then bottom; it did
  // not say what to do when neither works. Overlapping is not an option, so the
  // block gets its own page and the TA is told.
  const first = candidatePositions(page, block)[0];
  return {
    ok: false,
    box: { x: 40, y: 60, w: block.w, h: block.h },
    where: "its own page",
    ownPage: true,
    collisions: occupied.filter((o) => overlaps(first.box, o)),
  };
}

/** Rough block size from the annotation's lines, at 10pt Helvetica. */
export function blockSize(lines: string[]): Box {
  const longest = Math.max(...lines.map((l) => l.length), 1);
  return {
    x: 0,
    y: 0,
    // Helvetica averages a shade under half the point size per character.
    w: Math.min(260, longest * 4.85 + 16),
    h: lines.length * 11.2 + 14,
  };
}
