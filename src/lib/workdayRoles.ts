/** Shared panel visibility; reviewing workdays does not grant management actions. */
export function canViewWorkday(role: string): boolean {
  return ["ta", "ta_support", "ta_lead", "admin", "director"].includes(role);
}

export function canReviewWorkdays(role: string): boolean {
  return ["ta_lead", "admin", "director"].includes(role);
}
