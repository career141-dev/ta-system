import { repo } from "@/data/store";
import type { User } from "@/data/types";
import { assignableTas } from "@/lib/assignable";
import { can } from "@/lib/auth";
import { CONSENT_TEXT } from "@/lib/intake";
import { COUNTRIES, NATIONALITIES, localNationality } from "@/lib/intakeOptions";
import type { NewOpeningPayload } from "@/lib/mobile/openingsTypes";
import { INDUSTRIES } from "../../../convex/lib/jobRequirements";

/** The web's /openings/new as data: who it is for, and every list its form offers. */
export function mobileNewOpening(user: User): NewOpeningPayload {
  const isLead = user.role === "ta_lead" || user.role === "admin";
  return {
    apiVersion: 1,
    isLead,
    canAddClient: can(user, "client.manage").ok,
    clients: repo.clients().map((c) => ({ id: c.id, name: c.name, industry: c.industry })),
    tas: isLead ? assignableTas(repo.users()).map((u) => ({ id: u.id, name: u.name })) : [],
    countries: COUNTRIES,
    nationalities: NATIONALITIES,
    localNationality: Object.fromEntries(COUNTRIES.map((c) => [c, localNationality(c)])),
    industries: [...INDUSTRIES],
    consentText: CONSENT_TEXT,
  };
}
