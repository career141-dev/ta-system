/**
 * Where a person on the desk works (22 Oct), so a link's time can be read in
 * theirs as well as Sri Lanka's. India keeps Sri Lanka's clock; Pakistan is
 * half an hour behind. Unset is Sri Lanka.
 */
export const WORK_COUNTRIES = [
  { name: "Sri Lanka", zone: "Asia/Colombo" },
  { name: "India", zone: "Asia/Kolkata" },
  { name: "Pakistan", zone: "Asia/Karachi" },
] as const;

export type WorkCountry = (typeof WORK_COUNTRIES)[number]["name"];

export function readWorkCountry(raw: unknown): WorkCountry | null {
  return WORK_COUNTRIES.find((c) => c.name === raw)?.name ?? null;
}

/** The person's own clock, for showing beside Sri Lanka time. */
export function workTimeZone(country: string | null | undefined): { zone: string; label: string } {
  const c = WORK_COUNTRIES.find((x) => x.name === country) ?? WORK_COUNTRIES[0];
  return { zone: c.zone, label: c.name };
}
