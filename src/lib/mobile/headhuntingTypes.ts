/** Native headhunting-overview contract. Kept identical across backend and TA_APP. */
export interface HeadhuntingPayload {
  apiVersion: 1;
  context: { openingId: string; title: string; clientName: string };
  stats: { links: number; approached: number; reachedCv: number };
  next: HeadhuntingNextStep[];
  eyeMarkYield: {
    eyeMarked: number;
    eyeMarkedReachedCv: number;
    eyeMarkedRate: number | null;
    allLinksRate: number | null;
  };
}

export interface HeadhuntingNextStep {
  key: "approach" | "eye_mark" | "benchmark";
  title: string;
  detail: string;
  action: string;
  href: string;
}
