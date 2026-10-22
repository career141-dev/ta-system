/**
 * The New opening form's choices: where the job is and whose passport the
 * client wants. Moved out of components/CaptureForm so the mobile app offers
 * the same lists (22 Oct).
 */
export const COUNTRIES = [
  "Sri Lanka", "Bangladesh", "India", "Maldives", "Saudi Arabia",
  "United Arab Emirates", "Qatar", "Oman", "Kuwait", "Bahrain",
  "Singapore", "Malaysia", "Vietnam",
];

export const NATIONALITIES = [
  "Sri Lankan", "Bangladeshi", "Indian", "Pakistani", "Filipino",
  "Nepali", "Maldivian", "Saudi", "Emirati",
];

const LOCAL: Record<string, string> = {
  "Sri Lanka": "Sri Lankan", Bangladesh: "Bangladeshi", India: "Indian",
  Maldives: "Maldivian", "Saudi Arabia": "Saudi", "United Arab Emirates": "Emirati",
  Qatar: "Qatari", Oman: "Omani", Kuwait: "Kuwaiti", Bahrain: "Bahraini",
  Singapore: "Singaporean", Malaysia: "Malaysian", Vietnam: "Vietnamese",
};
export const localNationality = (c: string) => LOCAL[c] ?? c;
