// Which part of a CV the referee read sees.
//
// The main extraction reads only the first 6,000 characters (about two pages)
// to stay fast, and referees sit at the end of the CV. Five- and six-page CVs
// came through with no referees at all (25 September), so referees get their
// own read over the whole CV. Kept free of Node imports so tests can load it.

// ~10 pages of CV text. Anything up to this is read whole.
export const REFEREE_MAX_CHARS = 40_000;
// Past that, the referees section from its heading, or the end of the CV.
export const REFEREE_SECTION_CHARS = 10_000;

// A line that is only a referees heading: "REFERENCES", "Referees:",
// "Non-Related Referees", "Professional References".
const HEADING = /^[ \t]*(?:non[- ]?related|professional|character|work)?[ \t]*refer(?:ee|ence)s?[ \t]*:?[ \t]*$/gim;

export function refereeWindow(text: string): string {
  if (text.length <= REFEREE_MAX_CHARS) return text;
  // The last heading, since "References" can also appear in a contents list or summary.
  let at = -1;
  for (const m of text.matchAll(HEADING)) at = m.index ?? at;
  if (at >= 0) return text.slice(at, at + REFEREE_SECTION_CHARS);
  return text.slice(-REFEREE_SECTION_CHARS);
}
