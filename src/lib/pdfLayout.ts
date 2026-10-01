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
  const validItems: LayoutTextItem[] = [];
  for (const item of items) {
    if (!item || typeof item.str !== "string" || item.str.length === 0) continue;
    const transform = item.transform || [1, 0, 0, 1, 0, 0];
    const x = transform[4];
    const y = transform[5];
    const width = item.width || 0;
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
    const minX = Math.min(...validItems.map((i) => i.x));
    const maxX = Math.max(...validItems.map((i) => i.x + i.width));
    const contentWidth = maxX - minX;

    if (contentWidth > 250) {
      // Test potential split gutters
      for (let split = minX + 80; split <= maxX - 80; split += 10) {
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
        if (item.y > (pageHeight || 800) * 0.75) {
          headerItems.push(item);
        } else if (item.y < (pageHeight || 800) * 0.2) {
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
