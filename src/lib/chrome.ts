/**
 * The fixed chrome, in pixels.
 *
 * These were written out by hand in three files, and changing the header height
 * silently left the context band overlapping it and the rail 10px too tall.
 * They are pixels rather than rem on purpose: the root font size here is 14px,
 * so every rem-based utility renders at 0.875x and a 64px header comes out 56.
 *
 * Shared from here rather than from the components, so a client component can
 * read them without dragging a server component's imports along.
 */

/** The top bar. Tall enough to carry the logo lockup at 54px. */
export const HEADER_H = 78;

/** The client / position / team band inside an opening. */
export const CONTEXT_H = 48;

/** Where the project rail starts, and therefore how tall it is. */
export const RAIL_TOP = HEADER_H + CONTEXT_H;
