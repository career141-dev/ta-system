/**
 * What the desk assistant knows about how the platform works.
 *
 * Checked against the code on 6 Oct 2026. The first version (13 Sep) had
 * drifted: it described the 25 Sep set rule, a shared candidate pool for TAs,
 * a stage list from before the board was rebuilt, a nav with pages it no
 * longer has, and a new-opening form with fields it does not ask for. Every
 * line here should be something the code does; when the code changes, change
 * this with it.
 */

export const PLATFORM_KNOWLEDGE = `
=== CAREER141 PLATFORM GUIDE ===

1. PAGES (top bar: Clients, Openings, Database, Alerts, Reports, Voice agent, Bin):
- [Openings](/openings) — every job you can see, with stage counts and your working stage.
- [New opening](/openings/new) — Client and Position first, then country, who it is hiring for, notes (typed or recorded) and, for a lead, the TAs. The TA writes and approves the JD next.
- [Clients](/clients) — "+ Add a client": company, industry, main contact. "Save and create opening" carries on into its first opening; "Save client only" just saves. Only a lead, director or admin can add or edit clients.
- [Database](/database) — search every CV on the desk.
- [Alerts](/alerts) — what needs you now: follow-ups due, quiet posts, waiting CVs, open sets.
- [Reports](/reports), [People](/people), [CV intake](/intake), [Recruiter review](/review).
- [Bin](/bin) — deleted clients and openings, kept 7 days, then gone for good. Anyone on the desk except a viewer or client can restore; only a lead, director, ops or admin can delete for good early. Candidates are never deleted.

2. ON EACH OPENING (left sidebar). ATS half: Overview, Pipeline (one page per stage), Scoops, LinkedIn Job (one row per post; + adds a post), Job description, Database CVs, Snippets, End of day. Headhunting half: Overview, Research, Suggestions, Excel Tables. A client seat sees only the Job description and its own shortlist; headhunting pages are for recruiter seats.
- Working stage: each TA sets theirs per job (100% full hunt, Follow-up, Add-on) from the menu on the opening or the Openings list. On an Add-on day, shortlists are tagged Add-on automatically, and the stage shows on the end-of-day email.

3. STAGES: New CVs and Database match come in first. Then TA Follow-up, AI Follow-up, Director Review, Director shortlist, Client shortlist, Interview, Offer, Placed. Closed: Rejected, Dropped out.
- AI Follow-up holds only the CVs the AI scored at or above the pass mark; nobody moves people into it by hand. TA Follow-up is a TA's own shortlist, and entering it starts the follow-up (AI call first, then WhatsApp and email).
- Shortlisting someone from New CVs, Database match or AI Follow-up moves them to TA Follow-up under your name and gives them a set number.
- Collision lock: the first TA to shortlist owns the candidate; another TA cannot act on them. A lead or director still can.
- Two TAs on one job work apart: each sees their own candidates and the unclaimed pool, never the other's. Leads, directors, ops and admin see both.
- Director Review needs the CV, expected salary and notice period on file. Current salary is optional. Words count: "Negotiable" or "Not disclosed" is accepted. The move is refused with what is still missing.
- Director shortlist and Client shortlist record a decision: only a lead, director or admin (or the director/client seat on that job) can move someone there, or the reply is pasted in on the End of day page.
- Placed needs a recorded placement with a joining date. Moving someone out of Placed (to Rejected or Dropped out) is for a TA Lead, Director, Ops or Admin only (since 2 Oct).

4. SETS: numbered per TA per job. A set stays open across days until the TA sends five or more CVs in one Colombo day; that day closes it however many went, and the next day starts the next set. Four on Monday and three on Tuesday are all Set 1; six on Wednesday close Set 1; Thursday's first CV is Set 2.

5. TAGS:
- Add-on: a profile worked beyond the role's scope. Set automatically on an Add-on working day, or by hand on a candidate or a table row.
- Backup: once a job has someone at Offer or Interview, other CVs shortlisted for it become backups automatically. The TA can add or remove the tag.
- The candidate list filters All / Add-ons only / Backups only.

6. HEADHUNTING (recruiter seats):
- Research: reads the client and its competitors' websites and fills named fields, each with a source; anything it cannot verify stays empty. Benchmark is on the same page: who holds this role now at those companies.
- Suggestions: real LinkedIn profiles we hold no CV for. Runs by itself once the JD is approved; a TA can refine it up to 3 rounds per job. "Add" puts a profile into Excel Tables.
- Excel Tables: the TA's own table of profile links. "+" next to Excel Tables starts the next level (L1, L2…); a level can be renamed or deleted (its rows stay under All). Tabs: All, Pending, Interested, Not interested. Interested puts the person on the pipeline in TA Follow-up; Not interested rejects them. A TA sees only their own rows and rows a lead added. Pasting a link already in the table is refused and says whose it is.
- Chrome extension: captures a LinkedIn profile into a job's table. TA accounts only; setup is shown on Excel Tables.
- Headhunted CV upload: on the TA Follow-up page of a job, up to 10 PDF/DOC/DOCX files at once, 10 MB each. They land in TA Follow-up.
- Scoops: on the job's Scoops page, upload CVs a director, lead or ops person sent you, with who sent them. Up to 10 at once.

7. END OF DAY EMAIL (End of day page on a job): the Director copy is sent from your own mailbox. To and Cc start with the desk's usual addresses; on the Director copy you can add addresses or take any off, and it will not send with an empty To. A TA sends only the CVs they shortlisted; a lead sends for the desk. The client copy only records that it went. The reply moves people: a Director reply to Director shortlist, a client reply to Client shortlist.

8. DATABASE SEARCH ([Database](/database)), three modes:
- Plain English: the sentence is read into filters (title, skills, place, years, employer, notice).
- By meaning: ranks CVs by meaning (vector search); if it cannot run, it falls back to word ranking.
- Boolean: AND, OR, NOT, brackets and "exact phrases".

9. PRIORITY TIERS (target time to fill, used for SLA alerts): P1 14 days, P2 21, P3 30, P4 45, P5 60.

10. THIS ASSISTANT: reads the desk as the person asking sees it and answers with links. A change typed as an instruction ("shortlist Thisara on Brand Manager", "Thisara expected salary 250k") comes back as a proposal to confirm; nothing changes until they press Confirm, and the same checks as the buttons apply.
`.trim();

/**
 * Fast answers to the common how-to questions, no model needed.
 */
export function quickWorkflowHelp(question: string): string | null {
  const q = question.toLowerCase().trim();

  if (/\b(how\s+does|what\s+is)\b.*\b(meaning|semantic|vector|qdrant|embedding)\b/i.test(q)) {
    return [
      "**By meaning** ranks CVs by what they mean, not the exact words:",
      "- Use it for a skill set described several ways, e.g. *'high-volume retail store operations'*.",
      "- If it cannot run, the search falls back to ranking by words.",
      "- For exact terms use **Boolean**; for a quick sentence with filters use **Plain English**.",
      "",
      "Try it on [Database](/database).",
    ].join("\n");
  }

  if (/\b(what\s+is\s+a\s+set|how\s+do\s+sets\s+work|explain\s+sets|rule\s+of\s+5|when\s+does\s+a\s+set\s+close)\b/i.test(q)) {
    return [
      "**Sets** are numbered per TA, per job:",
      "- A set stays open across days until you send **five or more CVs in one day** (Colombo time). That day closes it, however many went.",
      "- The next day starts the next set. Four on Monday and three on Tuesday are all Set 1; six on Wednesday close Set 1; Thursday's first CV is Set 2.",
      "- Shortlisting gives the person your current set number and locks them to you on that job.",
      "",
      "Ask \"where are my sets?\" to see yours.",
    ].join("\n");
  }

  if (/\b(how\s+to|how\s+do\s+i)\b.*\b(add|create|new)\b.*\bclient\b/i.test(q)) {
    return [
      "**To add a client** (lead, director or admin):",
      "1. Open [Clients](/clients) and press **+ Add a client**.",
      "2. Fill in **Company name**, **Industry** and the **Main contact** (name, title, email).",
      "3. **Save and create opening** carries on into its first opening; **Save client only** just saves it.",
    ].join("\n");
  }

  if (/\b(how\s+to|how\s+do\s+i)\b.*\b(add|create|new|open)\b.*\b(opening|job|role)\b/i.test(q)) {
    return [
      "**To start a new opening:**",
      "1. Open [New opening](/openings/new).",
      "2. Pick the **Client** and type the **Position**.",
      "3. Add the country, who it is hiring for, and any notes (typed or recorded). A lead also picks the TAs.",
      "4. Save. The TA writes and approves the JD next, on the opening's Job description page.",
    ].join("\n");
  }

  if (/\b(explain|what\s+are)\b.*\b(stages|pipeline|workflow)\b/i.test(q) || /\bpipeline\s+stages\b/i.test(q)) {
    return [
      "**Stages, in order:**",
      "- In: **New CVs**, **Database match**.",
      "- **TA Follow-up** (your shortlist; the follow-up starts) and **AI Follow-up** (CVs the AI scored as a pass).",
      "- **Director Review** (needs CV, expected salary and notice; current salary optional) → **Director shortlist** → **Client shortlist**.",
      "- **Interview** → **Offer** → **Placed** (needs a joining date).",
      "- Closed: **Rejected**, **Dropped out**.",
    ].join("\n");
  }

  if (/\b(director\s+review)\b.*\b(need|needs|require\w*|missing|before)\b|\b(need|needs|require\w*)\b.*\bdirector\s+review\b/i.test(q)) {
    return [
      "**To move someone to Director Review** they need, on file:",
      "- the **CV**, **expected salary** and **notice period**.",
      "- Current salary is optional. Words count: \"Negotiable\" or \"Not disclosed\" is accepted.",
      "- If something is missing, the move is refused and says what. Add it on the candidate's page.",
    ].join("\n");
  }

  if (/\b(move|take)\b.*\bout\s+of\s+placed\b|\bunplace\b/i.test(q)) {
    return "Only a TA Lead, Director, Ops or Admin can move someone out of **Placed** (to Rejected or Dropped out) — ask your lead.";
  }

  if (/\b(bin|restore|undelete|deleted)\b/i.test(q) && /\b(how|where|what|can)\b/i.test(q)) {
    return [
      "Deleted clients and openings go to the [Bin](/bin) for **7 days**, then are gone for good.",
      "- Anyone on the desk except a viewer or client can restore them there.",
      "- Candidates are never deleted.",
    ].join("\n");
  }

  if (/\b(priority\s+tiers?|what\s+is\s+p1|p1\s+to\s+p5|time\s+to\s+fill)\b/i.test(q)) {
    return [
      "**Priority tiers** set the target time to fill, and drive the SLA alerts:",
      "- **P1:** 14 days · **P2:** 21 days · **P3:** 30 days · **P4:** 45 days · **P5:** 60 days.",
    ].join("\n");
  }

  return null;
}
