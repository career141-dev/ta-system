/**
 * Platform Knowledge Base for the Career141 Desk Assistant.
 *
 * Provides comprehensive domain knowledge about the recruitment system,
 * workflows, search engines, pipeline stages, and platform navigation.
 */

export interface SystemGuideSection {
  title: string;
  url?: string;
  summary: string;
  details: string[];
}

export const PLATFORM_NAVIGATION = [
  { label: "Dashboard", path: "/", description: "Desk overview, active openings, daily metrics, and urgent SLA alerts." },
  { label: "Openings", path: "/openings", description: "All active and on-hold openings, candidate pipelines, and assignments." },
  { label: "New Opening", path: "/openings/new", description: "Create a new role under a client, assign recruiters, and write briefs." },
  { label: "Clients", path: "/clients", description: "Client accounts, commercial terms, signed ESA records, and primary contacts." },
  { label: "Database Search", path: "/database", description: "Search 79,000+ candidate CVs by Plain English, Semantic Meaning, or Boolean." },
  { label: "Review Queue", path: "/review", description: "Unreviewed CVs and incoming applications waiting for recruiter triage." },
  { label: "Sourcing & Headhunt", path: "/hh/suggestions", description: "AI-assisted market mapping and LinkedIn profile discovery." },
  { label: "People & Directory", path: "/people", description: "Team directory, recruiter roles, and active TA assignments." },
  { label: "Reports", path: "/reports", description: "Commercial pipeline value, time-to-fill analytics, and recruiter yield." },
] as const;

export const PLATFORM_KNOWLEDGE = `
=== CAREER141 PLATFORM & WORKFLOW GUIDE ===

1. PLATFORM SITEMAP & CORE NAVIGATION:
- Dashboard: [/](/) — Desk overview, open roles, today's CV count, and urgent alerts.
- Database Search: [/database](/database) — Search across 79,000+ candidates in the talent pool.
- Openings: [/openings](/openings) — Active jobs, stage counts, and pipeline boards.
- Create Opening: [/openings/new](/openings/new) — Create a new opening under a client with target terms.
- Clients Directory: [/clients](/clients) — Client companies, primary contacts, industry, and signed ESA terms.
- Sourcing Suggestions: [/hh/suggestions](/hh/suggestions) — AI market mapping & candidate sourcing.
- Review Queue: [/review](/review) — Triage incoming CVs and unassigned database matches.
- Reports: [/reports](/reports) — Analytics, time-to-fill, and fee projections.

2. CANDIDATE DATABASE SEARCH (3 MODES):
The search engine at [/database](/database) searches over 79,000 candidates with three distinct search modes:
- Plain English ("natural"): Parses queries automatically into filters (job titles, skills, location, min experience years, employers, notice period).
- By Meaning ("meaning" / Semantic Vector Search): Uses OpenAI text-embedding-3-large (1024 dimensions) and our local Qdrant vector database (candidate_vectors collection). Ranks CVs mathematically by cosine similarity. Scores >= 0.75 are very strong matches, 0.70-0.75 are good matches. Ideal for conceptual queries like "Senior backend engineer with high-throughput distributed systems".
- Boolean ("boolean"): Supports exact Boolean logic with operators AND, OR, NOT, parentheses, and quoted exact phrases (e.g. ("React" OR "Next.js") AND "TypeScript" NOT "Junior").
- Saved Searches: Recruiters can save frequently run queries. Saved searches are stored permanently in Convex DB and appear in the "Mine" tab on [/database](/database).
- Candidate Drawer: Clicking a candidate in search results opens the slide-over Candidate Drawer for quick inspection, allowing you to browse through candidates without losing search position.

3. CLIENT & OPENING WORKFLOW:
- Creating a Client: Go to [/clients](/clients) and click "+ Add a client". Enter Company Name, Industry, and Main Contact details. Clients are persisted directly in Convex DB. You can also click "Save & Create Job" to immediately proceed to opening creation.
- ESA (Exclusive Search Agreement): Tracked on each client card. Record the date when terms are signed.
- Creating an Opening: Go to [/openings/new](/openings/new). Select the Client, enter Job Title, Job Order Number, Salary Range, and Priority Tier.
- Priority Tiers (Target Time-to-Fill):
  * P1: 2 weeks (14 days)
  * P2: 3 weeks (21 days)
  * P3: 1 month (30 days) — Standard default
  * P4: 1.5 months (45 days)
  * P5: 2 months (60 days)
- Multi-TA Assignment: Multiple recruiters can be assigned to one Opening. All recruiters share the same candidate pool under that opening.

4. CANDIDATE PIPELINE STAGES & SHORTLISTING RULES:
A candidate progresses through defined stages:
1. New CV (new_cv): Inbound application from a job post or email alias.
2. Matched (matched): Sourced from database search or headhunting and linked to the opening.
3. Follow-up (follow_up): Screening stage. Recruiter verifies availability, current salary, expected salary, and notice period.
4. Shortlist / Sets (shortlist): Candidates qualified for submission.
   * THE RULE OF FIVE (Sets): Shortlists are submitted in structured batches of 5 called "Sets". A set stays open until it reaches 5 candidates, after which it closes and progresses as a completed submission round.
   * COLLISION LOCK: The first recruiter to shortlist a candidate on an opening holds ownership. Other recruiters see the candidate marked as locked to prevent two recruiters approaching the same person.
5. Director Review (director_review): Internal leadership quality check before client submission.
6. Client Review (client_shortlist): Profile submitted to client decision-makers.
7. Interview (interview): Scheduled client rounds (Round 1, Technical, Cultural, Final).
8. Offer (offer): Formal employment offer issued to the candidate.
9. Placed (placed): Placement successfully completed; triggers billing and warranty period tracking.
10. Rejected (rejected) / Dropped Out (dropped_out): Candidate did not pass or withdrew.

5. SOURCING & LINKEDIN TOOLS:
- Sourcing tool at [/hh/suggestions](/hh/suggestions): Generates search strategies, extracts target companies, and searches Google/Serper for public LinkedIn profiles.
- Link Vault: Sourced profile links can be pinned to an opening. Recruiter eye-marks indicate review status.

6. DESK ASSISTANT CAPABILITIES:
- The assistant can answer how-to questions about any part of the system.
- It can check your real-time desk numbers (openings, follow-ups, upcoming interviews, unreviewed CVs).
- It can propose actions (e.g. "shortlist [Candidate Name]", "set salary 250k for [Candidate]") which require your confirmation before applying.
`.trim();

/**
 * Fast deterministic answers for common system help questions.
 */
export function quickWorkflowHelp(question: string): string | null {
  const q = question.toLowerCase().trim();

  // How does semantic / vector search work?
  if (/\b(how\s+does|what\s+is)\b.*\b(meaning|semantic|vector|qdrant|embedding)\b/i.test(q)) {
    return [
      "**By Meaning (Semantic Vector Search)** searches our database of over 79,000 candidates using AI vector embeddings:",
      "- **How it works:** Your query is converted into a 1024-dimensional vector using OpenAI's embedding model and compared against indexed CV vectors in our local Qdrant database using cosine similarity.",
      "- **Relevance Scores:** Scores above **0.75** indicate a very strong match. Scores between **0.70–0.75** represent good conceptual matches.",
      "- **When to use:** Use this mode when searching for domain expertise, interchangeable skill sets, or conceptual requirements (e.g., *'High-scale fintech backend architect'*).",
      "",
      "Try it on the [Database Search page](/database).",
    ].join("\n");
  }

  // How do sets work?
  if (/\b(what\s+is\s+a\s+set|how\s+do\s+sets\s+work|explain\s+sets|rule\s+of\s+5)\b/i.test(q)) {
    return [
      "**Sets** are structured candidate batches submitted to clients on an opening:",
      "- **The Rule of 5:** Candidates are grouped into sets of **5** per recruiter. A set remains 'open' until it reaches 5 shortlisted candidates, at which point it closes as a completed batch.",
      "- **Why sets?** Submitting in batches of 5 ensures consistent candidate presentation and prevents piecemeal reviews by clients.",
      "- **Collision Lock:** When you shortlist a candidate for an opening, you lock that candidate to yourself on that opening so colleagues don't approach them simultaneously.",
      "",
      "You can track your sets on any [Opening page](/openings).",
    ].join("\n");
  }

  // How to add a client?
  if (/\b(how\s+to|how\s+do\s+i)\b.*\b(add|create|new)\b.*\bclient\b/i.test(q)) {
    return [
      "**To create a new client:**",
      "1. Navigate to the [Clients page](/clients).",
      "2. Click the **'+ Add a client'** button at the top right.",
      "3. Fill in **Company Name**, **Industry**, and **Main Contact** details (Name, Title, Email).",
      "4. Click **'Add client'** to save, or **'Save & Create Job'** to immediately open the job creation form.",
      "",
      "The client record will be persisted directly to Convex DB and will be available in all opening forms.",
    ].join("\n");
  }

  // How to create an opening?
  if (/\b(how\s+to|how\s+do\s+i)\b.*\b(add|create|new)\b.*\b(opening|job|role)\b/i.test(q)) {
    return [
      "**To create a new opening:**",
      "1. Go to the [New Opening form](/openings/new).",
      "2. Select the **Client** from the dropdown (or create one on [Clients](/clients) first).",
      "3. Enter the **Position Title**, **Headcount**, and **Salary Range**.",
      "4. Choose a **Priority Tier** (P1 for 14-day fill target, up to P5 for 60-day).",
      "5. Assign the Lead and Recruiters who will work on the role.",
      "",
      "Once saved, you can add job posts and start matching candidates on [Openings](/openings).",
    ].join("\n");
  }

  // How do pipeline stages work?
  if (/\b(explain|what\s+are)\b.*\b(stages|pipeline|workflow)\b/i.test(q) || /\bpipeline\s+stages\b/i.test(q)) {
    return [
      "**Career141 Candidate Pipeline Stages:**",
      "1. **New CV:** Inbound application waiting for review.",
      "2. **Matched:** Sourced candidate linked to the role from the database or headhunting.",
      "3. **Follow-up:** Recruiter screening (verifying notice period, current & expected salary).",
      "4. **Shortlist:** Qualified candidates compiled into sets of 5 for review.",
      "5. **Director Review:** Internal review before client submission.",
      "6. **Client Review:** Candidate presented to the hiring manager.",
      "7. **Interview:** Formal interview rounds (Round 1, Tech, Cultural, Final).",
      "8. **Offer:** Employment offer extended.",
      "9. **Placed:** Candidate accepted and confirmed.",
      "",
      "View and manage candidates across these stages on the [Openings board](/openings).",
    ].join("\n");
  }

  // What are Priority tiers?
  if (/\b(priority\s+tiers?|what\s+is\s+p1|p1\s+to\s+p5|time\s+to\s+fill)\b/i.test(q)) {
    return [
      "**Priority Tiers define target Time-to-Fill for an opening:**",
      "- **P1:** 2 weeks (14 days) — Urgent executive or critical hires.",
      "- **P2:** 3 weeks (21 days) — High priority roles.",
      "- **P3:** 1 month (30 days) — Standard roles (default).",
      "- **P4:** 1.5 months (45 days) — Niche technical or senior roles.",
      "- **P5:** 2 months (60 days) — Long-lead or overseas searches.",
      "",
      "These tiers drive SLA countdown timers and alerts across the platform.",
    ].join("\n");
  }

  return null;
}
