const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function makeReviewToken(): string {
  return `C141-${Array.from({ length: 6 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("")}`;
}
