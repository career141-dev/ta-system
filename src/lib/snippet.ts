/**
 * Snippet content and geometry — spec §6.1.
 *
 * Everything here is read off the Canva file (design DAHFxvjUKlU), not
 * invented: the five backgrounds are the artwork exported flat from that file
 * with the text layers removed, and every coordinate, size, weight and colour
 * below is the value Canva reports for that text element. The studio draws
 * text over the plate, so what a TA sees is the design, not a reconstruction
 * of it.
 *
 * Pure: no store access, so client components can import it.
 */

export interface SnippetFields {
  jobTitle: string;
  level: LevelKey;
  industry: string;
  location: string;
  company: string;
  package: string;
  gender: string;
  bullets: string[];
  email: string;
  mobile: string;
}

export type LevelKey = "JUNIOR" | "EXECUTIVE" | "MID LEVEL" | "SENIOR" | "C LEVEL";

export interface Level {
  key: LevelKey;
  /** What the pill top-right reads. */
  pill: string;
  /** The flattened artwork, 1080x1080. */
  plate: string;
  /** The ground colour, sampled from the plate, for the picker chip. */
  swatch: string;
}

export const LEVELS: Level[] = [
  { key: "JUNIOR", pill: "level - Junior", plate: "/snippet/junior.png", swatch: "#faff5c" },
  { key: "EXECUTIVE", pill: "level - Executive", plate: "/snippet/executive.png", swatch: "#01fea3" },
  { key: "MID LEVEL", pill: "level - Mid Level", plate: "/snippet/mid.png", swatch: "#ffd891" },
  { key: "SENIOR", pill: "level - Senior Level", plate: "/snippet/senior.png", swatch: "#41f5e4" },
  { key: "C LEVEL", pill: "level - C Level", plate: "/snippet/clevel.png", swatch: "#ffaa5b" },
];

export const LEVEL_BY_KEY: Record<LevelKey, Level> = Object.fromEntries(
  LEVELS.map((l) => [l.key, l]),
) as Record<LevelKey, Level>;

/** Seniority is read off the title, since that is where the desk states it. */
export function levelFromTitle(title: string): LevelKey {
  const t = title.toLowerCase();
  if (/\b(chief|cxo|c-suite|cfo|ceo|coo|chro|cso|cto)\b/.test(t)) return "C LEVEL";
  if (/\b(director|head of|group head|general manager|gm)\b/.test(t)) return "SENIOR";
  if (/\b(manager|lead)\b/.test(t)) return "MID LEVEL";
  if (/\b(intern|trainee|junior|assistant)\b/.test(t)) return "JUNIOR";
  return "EXECUTIVE";
}

/** Every text block on the card. The pills are four separate blocks because
 *  that is what they are in the design — a package that runs long should not
 *  drag the gender line with it. */
export type BlockKey =
  | "levelPill"
  | "industry"
  | "titleLead"
  | "titleMain"
  | "location"
  | "company"
  | "packageLine"
  | "gender"
  | "bullets"
  | "footer";

export interface TextBlock {
  /** Per block, because the design uses two faces and always has: one for the
   *  title, pills and footer, another for the level chip, the industry band and
   *  the requirements. A single card-wide font cannot be the design. */
  font: string;
  x: number;
  y: number;
  /** Text wraps inside this width. */
  w: number;
  size: number;
  /** 300 light, 400 regular, 500 medium, 600 semibold, 700 bold. */
  weight: number;
  color: string;
  align: "left" | "center" | "right";
  lineHeight: number;
  /** In em, as Canva reports it. */
  letterSpacing: number;
  uppercase: boolean;
  /** Bullet the lines with a disc, one line per entry. */
  bulleted?: boolean;
}

export type SnippetLayout = Record<BlockKey, TextBlock>;

/**
 * The two faces, identified by measurement rather than by eye.
 *
 * Canva reports its fonts by internal id and the ids cannot be resolved through
 * the API, so each candidate was set at the design's own sizes and its ink box
 * compared against the exported artwork:
 *
 *   HEAD — title, pills, footer. Poppins matches Canva's ink width to within
 *   0.2% on all three samples ("Graphic Designer" at 93.4/700, "Junior" at
 *   74.7/300, the footer line at 24.1/400). Nothing else came within 5%.
 *
 *   BODY — level chip, industry band, requirements. Quicksand is within 0.4% on
 *   "Apparel" at 42.7/700, 3% on the chip, and is the only candidate that wraps
 *   the first requirement exactly where Canva wraps it. It is also visibly the
 *   right shape: the design's `l` is a plain stem and its terminals are
 *   rounded, which rules out the flat-terminal geometrics.
 */
const HEAD = "Poppins";
const BODY = "Quicksand";

const T = (b: Partial<TextBlock> & Pick<TextBlock, "x" | "y" | "w" | "size">): TextBlock => ({
  font: HEAD,
  weight: 400,
  color: "#000000",
  align: "left",
  lineHeight: 1.4,
  letterSpacing: 0,
  uppercase: false,
  ...b,
});

export const DEFAULT_LAYOUT: SnippetLayout = {
  // Positions are Canva's own numbers for each text element, corrected by the
  // drift measured against the exported artwork — Canva's first-baseline rule
  // is not CSS's, and the gap between them grows with the line height (the
  // requirements block at 1.97 sat 8px low, the title at 1.0 sat 14px high,
  // while everything at 1.4 landed within a pixel). Measured beats modelled;
  // "Put everything back on the design" restores exactly these.
  levelPill: T({
    font: BODY, x: 657, y: 37.4, w: 390, size: 33.9, weight: 600,
    color: "#ffffff", align: "center", uppercase: true, letterSpacing: 0.002,
  }),
  industry: T({ font: BODY, x: 90.3, y: 241.3, w: 400, size: 42.7, weight: 700, color: "#ffffff" }),
  titleLead: T({ x: 90.3, y: 357.5, w: 960, size: 74.7, weight: 300, lineHeight: 1, letterSpacing: -0.042 }),
  titleMain: T({ x: 90.3, y: 435.2, w: 960, size: 93.4, weight: 700, lineHeight: 1, letterSpacing: -0.042 }),
  location: T({ x: 117.1, y: 567, w: 322, size: 18 }),
  company: T({ x: 539, y: 567, w: 341, size: 18 }),
  packageLine: T({ x: 117.1, y: 641.5, w: 322, size: 18 }),
  gender: T({ x: 540, y: 641.5, w: 322, size: 18 }),
  bullets: T({ font: BODY, x: 90.3, y: 731.4, w: 865.9, size: 21.3, weight: 500, color: "#ffffff", lineHeight: 1.97, bulleted: true }),
  footer: T({ x: 90.3, y: 1026, w: 865.9, size: 24.1 }),
};

export const BLOCK_LABEL: Record<BlockKey, string> = {
  levelPill: "Level pill",
  industry: "Industry",
  titleLead: "Title — first line",
  titleMain: "Title — bold line",
  location: "Location",
  company: "Company",
  packageLine: "Package",
  gender: "Gender",
  bullets: "Requirements",
  footer: "Footer",
};

/** The order the blocks are drawn and listed in — top of the card down. */
export const BLOCK_ORDER: BlockKey[] = [
  "levelPill",
  "industry",
  "titleLead",
  "titleMain",
  "location",
  "company",
  "packageLine",
  "gender",
  "bullets",
  "footer",
];

/** Faces the card can be set in. Outfit and Poppins are the two the design
 *  uses; the rest are there for a TA who wants a different look. */
export const SNIPPET_FONTS = ["Outfit", "Poppins", "Jost", "Quicksand", "Montserrat", "Figtree"];

export function snippetFromOpening(input: {
  title: string;
  clientIndustry: string;
  locations: string[];
  salaryMin: number | null;
  salaryMax: number | null;
  currency: string;
  packageNotes: string;
  jdMarkdown: string;
  taEmail: string;
  taPhone: string | null;
}): SnippetFields {
  // Requirements come straight out of the approved JD's bullet list. The panel
  // holds three comfortably at the design's size; more than that and the TA
  // either trims or drops the size, which is what the studio is for.
  const bullets = input.jdMarkdown
    .split("\n")
    .filter((l) => l.trim().startsWith("- "))
    .map((l) => l.replace(/^-\s+/, "").trim())
    .filter((l) => l && !/^to be completed/i.test(l))
    .slice(0, 4);

  /**
   * The package line is often already written out in full in the notes
   * ("475K + fuel, negotiable to 550K"). Appending a formatted range to that
   * produces "475K – 550K 475K + fuel…", so the note wins when it already
   * carries a figure of its own.
   */
  const money = () => {
    const note = input.packageNotes.trim();
    if (/\d/.test(note)) return note;
    if (!input.salaryMin) return note || "Negotiable";

    const short = (n: number) =>
      input.currency === "LKR" && n >= 1000 ? `${Math.round(n / 1000)}K` : n.toLocaleString();
    const unit = input.currency === "LKR" ? "" : `${input.currency} `;
    const base = input.salaryMax
      ? `${unit}${short(input.salaryMin)} – ${short(input.salaryMax)}`
      : `From ${unit}${short(input.salaryMin)}`;
    return note ? `${base} ${note}` : base;
  };

  return {
    jobTitle: input.title,
    level: levelFromTitle(input.title),
    industry: input.clientIndustry,
    location: input.locations.join(" | ") || "Sri Lanka",
    company: input.clientIndustry,
    package: money(),
    // Spec §11.1 — descriptive, and "Open" unless a client requirement says otherwise.
    gender: "Open",
    bullets,
    email: input.taEmail,
    mobile: input.taPhone ?? "",
  };
}

/**
 * The labels stamped on the four fact lines of a plate.
 *
 * Design, not content — a TA edits the value, never the word in front of it,
 * which is why these live here and not in the editable fields.
 */
export const PILL_LABEL: Partial<Record<BlockKey, string>> = {
  location: "Location  :  ",
  company: "Company  :  ",
  packageLine: "Package  :  ",
  gender: "Gender  :  ",
};

/**
 * A job title split across the plate's two title lines.
 *
 * "GM / Merchandising & Marketing" breaks at the slash; anything else puts the
 * last two words on the bold line, because that is where the eye lands and the
 * specific half of a title is almost always at the end.
 */
export function splitTitle(title: string): { lead: string; main: string } {
  const parts = title.split("/").map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    return { lead: parts.slice(0, -1).join(" / "), main: parts[parts.length - 1] };
  }
  const words = title.trim().split(/\s+/);
  if (words.length <= 2) return { lead: "", main: title };
  const cut = Math.max(1, words.length - 2);
  return { lead: words.slice(0, cut).join(" "), main: words.slice(cut).join(" ") };
}
