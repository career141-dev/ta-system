/**
 * The CAREER141 box's one size (29 Sep): shared by the PDF stamp and the
 * Prepared CV editor, which draws the box on screen. Kept apart from
 * lib/preparedCv so the browser can import it without the PDF code.
 */
export const BOX = {
  width: 260,
  padding: 8,
  lineHeight: 12.5,
  headerSize: 9.5,
  bodySize: 8.5,
  border: 1.5,
  green: "#0C7A0C",
} as const;
