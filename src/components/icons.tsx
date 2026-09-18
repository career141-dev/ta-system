/**
 * The small set of glyphs the chrome needs — finding 21.
 *
 * These were text characters: ⌕ for search, ✕ for close, ‹ › for paging. A
 * character is whatever the operating system's font has, which is why the bin
 * rendered in full colour on macOS and the pencil was missing on some Android
 * builds. Drawn once here, they are the same everywhere.
 */

const base = {
  fill: "none" as const,
  stroke: "currentColor",
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function SearchIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.4" strokeWidth="1.5" {...base} />
      <path d="M10.3 10.3L14 14" strokeWidth="1.5" {...base} />
    </svg>
  );
}

export function CloseIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" strokeWidth="1.6" {...base} />
    </svg>
  );
}

export function BellIcon({ size = 17 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 6.2a4 4 0 0 1 8 0c0 3.1 1 4 1 4H3s1-.9 1-4Z" strokeWidth="1.4" {...base} />
      <path d="M6.6 12.2a1.5 1.5 0 0 0 2.8 0" strokeWidth="1.4" {...base} />
    </svg>
  );
}

export function ChevronIcon({
  size = 14,
  dir = "down",
}: {
  size?: number;
  dir?: "up" | "down" | "left" | "right";
}) {
  const d = {
    down: "M4 6.5L8 10.5L12 6.5",
    up: "M4 9.5L8 5.5L12 9.5",
    left: "M9.5 3.5L5.5 8L9.5 12.5",
    right: "M6.5 3.5L10.5 8L6.5 12.5",
  }[dir];
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d={d} strokeWidth="1.7" {...base} />
    </svg>
  );
}
