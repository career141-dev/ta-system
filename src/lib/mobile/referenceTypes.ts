/** Native opening-reference contract. Kept identical across backend and TA_APP. */
export interface ReferencePayload {
  apiVersion: 1;
  context: { openingId: string; title: string; clientName: string };
  stats: { referees: number; candidates: number; withPhone: number; targetCompanies: number };
  candidates: ReferenceCandidate[];
  targetCompanies: string[];
  backchannel: { company: string; people: BackchannelPerson[] } | null;
}

export interface ReferenceCandidate {
  applicationId: string;
  candidateId: string;
  name: string;
  stage: string;
  stageLabel: string;
  referees: ReferenceReferee[];
}

export interface ReferenceReferee {
  id: string;
  name: string;
  title: string | null;
  company: string | null;
  phone: string | null;
  email: string | null;
  relationship: string | null;
}

export interface BackchannelPerson {
  id: string;
  name: string;
  title: string | null;
  phone: string | null;
  email: string | null;
}
