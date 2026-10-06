export interface LayoutTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hasEOL?: boolean;
}

/**
 * Extracts plain text from pdfjs page textContent items while preserving:
 * 1. Multi-column / sidebar layouts (reading columns sequentially top-to-bottom)
 * 2. Visual line breaks and paragraph spacing
 * 3. In-line word spacing
 */
export function extractPageTextWithLayout(items: any[], pageWidth: number, pageHeight: number): string {
  /*
   * Only text that sits on the page (6 Oct). Some PDFs carry items at absurd or
   * infinite positions; the column search below then stepped across a "page"
   * billions of points wide — or for ever, once the step no longer moved the
   * number — and every CV read froze the backend's action runner with it.
   */
  const pageW = Number.isFinite(pageWidth) && pageWidth > 0 ? pageWidth : 612;
  const pageH = Number.isFinite(pageHeight) && pageHeight > 0 ? pageHeight : 792;
  const onPage = (n: number, size: number) => Number.isFinite(n) && n >= -size && n <= size * 2;
  const validItems: LayoutTextItem[] = [];
  for (const item of items) {
    if (!item || typeof item.str !== "string" || item.str.length === 0) continue;
    const transform = item.transform || [1, 0, 0, 1, 0, 0];
    const x = transform[4];
    const y = transform[5];
    if (!onPage(x, pageW) || !onPage(y, pageH)) continue;
    const width = Number.isFinite(item.width) ? Math.min(Math.max(0, item.width), pageW * 2) : 0;
    const height = item.height || Math.abs(transform[3]) || 10;
    validItems.push({
      str: item.str,
      x,
      y,
      width,
      height,
      hasEOL: item.hasEOL,
    });
  }

  if (validItems.length === 0) return "";

  // Helper to extract text from a cluster of items in natural top-to-bottom, left-to-right order
  const extractCluster = (clusterItems: LayoutTextItem[]): string => {
    if (clusterItems.length === 0) return "";

    // Sort primarily by Y descending (top of page to bottom), with a 3.5pt line tolerance.
    // For items on the same line, sort by X ascending.
    const sorted = [...clusterItems].sort((a, b) => {
      if (Math.abs(a.y - b.y) <= 3.5) {
        return a.x - b.x;
      }
      return b.y - a.y;
    });

    let result = "";
    let lastY: number | null = null;
    let lastRightX: number | null = null;

    for (const item of sorted) {
      if (lastY === null) {
        result += item.str;
      } else {
        const isNewLine = Math.abs(item.y - lastY) > 3.5;
        if (isNewLine) {
          const isLargeGap = Math.abs(item.y - lastY) > 16;
          result += isLargeGap ? "\n\n" : "\n";
          lastRightX = null;
        } else {
          const needsSpace =
            !result.endsWith(" ") &&
            !result.endsWith("\n") &&
            !item.str.startsWith(" ") &&
            lastRightX !== null &&
            item.x - lastRightX > 1.5;
          if (needsSpace) {
            result += " ";
          }
        }
        result += item.str;
      }
      lastY = item.y;
      lastRightX = item.x + item.width;
      if (item.hasEOL) {
        result += "\n";
        lastY = null;
        lastRightX = null;
      }
    }

    return result.trim();
  };

  // Detect 2-column / sidebar layout if present
  let bestSplitX: number | null = null;
  let minCrossing = Infinity;

  if (validItems.length > 15) {
    // A loop, not Math.min(...items): a page of tens of thousands of items
    // overflowed the call stack.
    let minX = Infinity;
    let maxX = -Infinity;
    for (const i of validItems) {
      if (i.x < minX) minX = i.x;
      if (i.x + i.width > maxX) maxX = i.x + i.width;
    }
    minX = Math.max(minX, 0);
    maxX = Math.min(maxX, pageW);
    const contentWidth = maxX - minX;

    if (contentWidth > 250) {
      // Test potential split gutters — at most ~100 of them, whatever the page.
      const step = Math.max(10, (contentWidth - 160) / 100);
      for (let split = minX + 80; split <= maxX - 80; split += step) {
        let leftCount = 0;
        let rightCount = 0;
        let crossingCount = 0;

        for (const item of validItems) {
          const itemRight = item.x + item.width;
          if (item.x < split && itemRight > split) {
            crossingCount++;
          } else if (itemRight <= split) {
            leftCount++;
          } else if (item.x >= split) {
            rightCount++;
          }
        }

        if (leftCount >= 5 && rightCount >= 5) {
          const crossingRatio = crossingCount / validItems.length;
          if (crossingRatio < 0.08 && crossingCount < minCrossing) {
            minCrossing = crossingCount;
            bestSplitX = split;
          }
        }
      }
    }
  }

  if (bestSplitX !== null) {
    const split = bestSplitX;
    const headerItems: LayoutTextItem[] = [];
    const footerItems: LayoutTextItem[] = [];
    const leftItems: LayoutTextItem[] = [];
    const rightItems: LayoutTextItem[] = [];

    for (const item of validItems) {
      const itemRight = item.x + item.width;
      const isWide = item.width > 200 && item.x < split && itemRight > split;
      if (isWide) {
        if (item.y > pageH * 0.75) {
          headerItems.push(item);
        } else if (item.y < pageH * 0.2) {
          footerItems.push(item);
        } else {
          const mid = item.x + item.width / 2;
          if (mid < split) leftItems.push(item);
          else rightItems.push(item);
        }
      } else {
        const mid = item.x + item.width / 2;
        if (mid < split) {
          leftItems.push(item);
        } else {
          rightItems.push(item);
        }
      }
    }

    const headerText = extractCluster(headerItems);
    const leftText = extractCluster(leftItems);
    const rightText = extractCluster(rightItems);
    const footerText = extractCluster(footerItems);

    return [headerText, leftText, rightText, footerText].filter(Boolean).join("\n\n");
  }

  return extractCluster(validItems);
}
