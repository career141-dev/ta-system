/** A location as the country the openings filter groups it under (from src/app/openings/page.tsx, 22 Oct). */
// Whole words only (review of PR #31): "male" is inside "Female", "uk" inside "Sukkur".
export function toCountry(loc: string): string {
  const l = loc.trim().toLowerCase();
  if (/\b(colombo|kandy|galle|jaffna|sri lanka)\b/i.test(l)) return "Sri Lanka";
  if (/\b(karachi|lahore|islamabad|rawalpindi|pakistan)\b/i.test(l)) return "Pakistan";
  if (/\b(dhaka|chittagong|bangladesh)\b/i.test(l)) return "Bangladesh";
  if (/\b(dubai|abu dhabi|sharjah|uae|emirates)\b/i.test(l)) return "UAE";
  if (/\b(doha|qatar)\b/i.test(l)) return "Qatar";
  if (/\b(riyadh|jeddah|dammam|saudi)\b/i.test(l)) return "Saudi Arabia";
  if (/\b(male|maldives)\b/i.test(l)) return "Maldives";
  if (/\b(mumbai|delhi|bangalore|india)\b/i.test(l)) return "India";
  if (/\b(singapore)\b/i.test(l)) return "Singapore";
  if (/\b(london|uk|united kingdom)\b/i.test(l)) return "UK";
  return loc.trim();
}
