/**
 * Has this person worked in the automobile industry, and at what level (30 Oct).
 *
 * Feeds the Extras tab's automobile contact list (email campaigns). Same idea as
 * salesRole: keyword rules, free over 78,000 candidates, and every row says which
 * employer or job caught it. Any role counts: sales, service, finance, HR, intern.
 *
 * Pure, with no database or network.
 */
import { salesLevelOf, titleToRead, type SalesLevel, type SalesRoleInput } from "./salesRole";

export type AutomobileInput = SalesRoleInput & {
  currentEmployer?: string | null;
  employersText?: string | null;
};

export type AutomobileRole = {
  level: SalesLevel;
  title: string;
  titleSource: string;
  matchedBy: string;
};

// Words that say "automobile" wherever they appear in an employer name, job title or sector.
const WORDS = /\b(automobiles?|automotive|auto ?(parts|spares|mobiles?|care|dealer\w*|sales|components?|industry|finance)|motors?|motor ?(cycles?|vehicles?|company|sales|traders?)|motorcycles?|vehicles?|car (dealers?|sales|showroom|rental|service|spares|import\w*)|three-?wheelers?|tyres?|tires?|spare ?parts|dealerships?|service station|bajaj|yamaha|suzuki|toyota|nissan|honda|mitsubishi|mazda|subaru|isuzu|hyundai|kia motors|volkswagen|mercedes|bmw|audi|volvo|renault|peugeot|chevrolet|land rover|jaguar|mahindra|ashok leyland|tata motors|hero motocorp|tvs motor|royal enfield|harley|ducati|toyota lanka|dimo|micro cars|united motors|associated motorways|lanka ashok|general motors|ford motor|tesla|byd|geely|mg motor|daihatsu|lexus|porsche|ferrari|lamborghini|maruti|piaggio|hino|scania)\b/i;
// "Motor" alone also names electric motors and insurance ("Motor Claims"); those are left out.
const NOT_AUTO = /\b(electric(al)? motors?|motor insurance|motor claims?|motor winding|motor neuron|motor skills?|motor control)\b/i;

const hit = (text?: string | null) => {
  const t = (text ?? "").trim();
  return t && !NOT_AUTO.test(t) ? WORDS.exec(t)?.[0].toLowerCase() : undefined;
};

export function automobileRoleOf(c: AutomobileInput): AutomobileRole | null {
  const why =
    ((w) => w && `current employer: ${c.currentEmployer!.trim()} (${w})`)(hit(c.currentEmployer)) ||
    (c.jobHistory ?? []).map((j) => {
      const w = hit(j.company) ?? hit(j.title);
      return w && `past job: ${[j.title, j.company].filter(Boolean).join(" at ")} (${w})`;
    }).find(Boolean) ||
    ((w) => w && `employers: ${c.employersText!.trim().slice(0, 120)} (${w})`)(hit(c.employersText)) ||
    ((w) => w && `sector: ${c.sector!.trim()} (${w})`)(hit(c.sector)) ||
    (c.pastJobTitles ?? []).map((t) => hit(t) && `past title: ${t.trim()}`).find(Boolean);
  if (!why) return null;
  const read = titleToRead(c);
  const title = read?.title ?? "(no title)";
  return { level: salesLevelOf(title), title, titleSource: read?.source ?? "none", matchedBy: why };
}
