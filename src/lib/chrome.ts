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

/**
 * The top bar: 78px on a wide screen, tall enough for the logo lockup at 54px;
 * 64px below 1280px, where the menu folds into a button (5 Oct, mobile). The
 * number lives in globals.css as --header-h so it can change with the screen.
 */
export const HEADER_H = "var(--header-h)";

/** The client / position / team band inside an opening (sticky from 1024px). */
export const CONTEXT_H = 48;

/** Where the project rail starts, and therefore how tall it is. */
export const RAIL_TOP = `calc(var(--header-h) + ${CONTEXT_H}px)`;
