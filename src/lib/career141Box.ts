/**
 * The CAREER141 box's shared size limits (29 Sep, adjustable width 20 Oct):
 * used by the PDF stamp and the Prepared CV editor. Kept apart from
 * lib/preparedCv so the browser can import it without the PDF code.
 */
export const BOX = {
  width: 260,
  minWidth: 180,
  maxWidth: 380,
  padding: 8,
  lineHeight: 12.5,
  headerSize: 9.5,
  bodySize: 8.5,
  border: 1.5,
  green: "#0C7A0C",
} as const;
