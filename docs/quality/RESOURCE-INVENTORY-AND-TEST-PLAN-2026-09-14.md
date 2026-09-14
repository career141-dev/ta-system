# Career141: resource inventory and test plan (revision 3)

14 September 2026 · replaces revision 2 of this file · applies [CODEX-REVIEW-REVISION-2-2026-09-14.md](CODEX-REVIEW-REVISION-2-2026-09-14.md) · the first paid run is specified separately in [P1-RUN-CARD-2026-09-14.md](P1-RUN-CARD-2026-09-14.md)

**What produced this revision:** planning and free local inspection only.
- No paid test ran.
- The full live database was not copied.
- Production was not changed, and no one was contacted.
- Live reads used allow-listed Convex *query* functions, checked in source first. No credential values appear here.

**Status of the review input:** revision 2 answered review points listed in the request. Revision 3 applies Codex's written review of revision 2; every code claim in it was checked (section 4.2) and all were confirmed.

**Labels used below:**
- **[LIVE]** counted today from the live system
- **[CODE]** read from the live system's 7 September source copy; the deployed system may differ
- **[NEW]** the new platform
- **[COPY]** the local test copy in `.data-live-test`
- **[PROVIDER]** a provider's own account or price page, read today

---

## 1. Verified facts

### 1.1 Candidates and CVs

| Fact | Value | Source |
|---|---:|---|
| Candidate records | 76,956 | LIVE |
| CV text/embedding records (`candidateResumes`) | 97,012 | LIVE |
| CV uploads | 105,987 | LIVE |
| Original CV files | R2 and older Convex storage; not readable through the read link (download URLs come from an action) | CODE |
| A read-only query returns CV records for named candidates (`matching/queries:getCandidateResumesBatch`, internalQuery) | Exists; **not yet on the allowlist** | CODE |
| Newer extractions keep CV text only in R2 (`rawTextKey`), so database text can be empty | Yes | CODE |
| Sample of 1,000 CV records (13 Sep) | 997 with database text, 3 without | LIVE |
| Test copy | 7,251 candidates (9.4%, first pages of the table, not random); 7,235 with text; 6,633 with work history; 7,251 embeddings | COPY |
| Missing fields in the copy | 534 title, 618 history, 1,175 years, 1,293 location, 544 email, 690 phone; 86 texts under 500 characters | COPY |
| Duplicate groups in the copy | email 312 (666 records), normalised phone 305 (650), LinkedIn 110 (331), identical CV text 145 (332) | COPY |
| Live duplicate check | exact file hash, case-sensitive email, raw phone, LinkedIn; no merge record; headhunt and WhatsApp paths skip it | CODE |

### 1.2 Jobs

| Fact | Value | Source |
|---|---:|---|
| Jobs | 96: 77 active, 15 on hold, 4 draft, 0 filled, 0 cancelled | LIVE |
| Creation dates | 22 Jul – 13 Sep 2026 | LIVE |
| JD of 300+ characters | 92 | LIVE |
| Client name recorded | 95 (presence only) | LIVE |
| Test/junk jobs | 4 | LIVE |
| Repeated postings | Senior Executive Recruiter ×3, COO ×4, Head of Sales ×2, Head of IT ×2, Graphic Designer ×2, Video Editor ×2, Senior Pricing Manager ×2, Academic Manager ×2 | LIVE |
| Applications | 8,313; per-job counters are stale (they sum to 6,793 and disagree with stage counters) | LIVE |

### 1.3 Human decisions

| Fact | Value | Source |
|---|---:|---|
| Director shortlist, client review, interview, offer, placed | 0 in all job counters | LIVE |
| Tables for director/client reviews, interviews, offers, placements | 0 rows each | LIVE |
| TA shortlist | 427 in counters; **mix of human and automatic** (auto-shortlist leaves no shortlister id) | LIVE, CODE |
| Split of human vs automatic TA shortlists | **Incomplete:** 7,430 of 8,313 applications read before the session ended; not yet analysed | LIVE |
| Recruiter decisions in the new platform | 120: jobs 4, 9, 12 × 40, by Uzmaan (saved as u_lead) | COPY |
| Claude's own labels | 1,073 + 161 + 148; **not human** | COPY |

### 1.4 Calls and messaging

| Fact | Value | Source |
|---|---:|---|
| `aiCalls` rows | 43 | LIVE |
| `voiceCallSessions` rows | 0 | LIVE |
| `communications` rows | 17,074 | LIVE |
| Live call results | not posted back to the database | CODE |
| New platform voice | script, consent, state and answer-reading logic only; **no dialer** | NEW |
| New platform messaging | chase plan only; **sends nothing** | NEW |

### 1.5 New platform modules

| Area | Facts | Source |
|---|---|---|
| Auth | Stage-one: signed cookie, account picker, no password; role checks in `lib/auth.ts`, row scoping in `lib/visibility.ts` | NEW |
| Test spend guard | `lib/spend.ts`: $5 folder cap. Revision 3 fixes: an unreadable existing ledger now stops paid calls; a failed model, embedding or search request keeps its full reservation instead of being recorded as free. Reservations are still per process, so it is **not** used for P1 | NEW |
| Paid-run guard for approved experiments | `lib/runLedger.ts` (durable append-and-fsync ledger, one-runner lock, fails closed, uncertain charges held at maximum) and `lib/p1Runner.ts` (frozen manifest, pinned provider, one retry only on no response, stop on allowance, overrun or three failures in a row). 30 mocked runner and ledger checks plus dry runs on the real frozen requests | NEW |
| De-identification | `lib/deid.ts`: replaces emails, links, phones, NIC/passport, addresses, birth dates, personal fields, names, name headers, staff names in legacy footers, and referee sections, keeping employment dates. Checked by `residualContacts` on the exact outgoing text. **De-identified, not anonymous** | NEW |
| Prepared CVs | `lib/pdf.ts:195` draws a **single-page stand-in** (`placeholderCv`) and places the annotation against `placeholderOccupancy()`; it does **not** read or annotate an original CV PDF. Original-file annotation is an **implementation dependency** | NEW |
| Closing | `lib/closing.ts`: fee (default 12%), 90-day guarantee, ESA states | NEW |
| Modules that call paid services | `dbMatch`, `deskAssistant`, `deskActions`, `headhunt`, `reportAsk`, `reviewReply`, `sourcing`, `actions.ts` | NEW |

### 1.6 Results so far

| Fact | Value | Source |
|---|---:|---|
| Laptop screen, final (Qwen3.8-27B, looser rules), 120 people | yes/no agrees with you 101/120; put forward 17, of which you accept 8 (47%); kept 8 of your 18 Shortlist/Maybe; kept 3 of your 4 Shortlists; 40–90 s per CV | COPY |
| Current rules score on the same 120 | top band 53, of which 10 acceptable (19%); ranking AUC 0.51 / 0.62 / 0.68 | COPY |
| Laptop screen on the frozen P1 inputs (prompt v3, de-identified text) | **Running** (free); this is the P1 comparison baseline | COPY |

### 1.7 Prices checked today

| Service | Price | No-data-retention |
|---|---|---|
| text-embedding-3-small | $0.02/M | yes, 1 endpoint |
| DeepSeek V4.1 Flash, standard route | $0.20 in / $0.60 out | yes (cheaper fp4 routes exist, not to be used) |
| GLM 5.3 Flash | $0.15 / $0.50 | yes |
| GPT-5.6 Luna | $0.20 / $1.20 | yes, Azure |
| Gemini 3.6 Flash (sourcing) | $0.75 / $3.75 | yes |
| Gemini 3.8 Flash | $0.75 / $3.75 | yes |
| Claude Sonnet 5 | $2 / $10 | yes |
| Claude Opus 5 | $5 / $25 | yes |
| Gemini 2.5 Flash-Lite | $0.10 / $0.40 | yes |
| GPT-4o-mini | $0.15 / $0.60 | yes |
| Batch variants | half price | **not** on the no-retention list |

**Voice** [PROVIDER]:
- **Deepgram speech-to-text:** Nova-3 streaming $0.0048/min (promotional; regular $0.0077). Nova-2 is not listed.
- **Deepgram voice (Aura-2):** $0.030 per 1,000 characters.
- **New accounts:** $200 free credit.

### 1.8 Accounts and spend

| Fact | Value | Source |
|---|---:|---|
| OpenRouter account | credits $150; usage $107.56 at 04:5x UTC → $107.96 at 05:39 UTC | PROVIDER |
| OpenRouter platform key usage | September $3.99 → $4.39 over the same interval; today $0.33 → $0.73; no spending limit set | PROVIDER |
| Serper | 1,313 prepaid credits (unchanged) | PROVIDER |
| Platform test ledger | $1.9914, 1,343 entries, all 13 Sep 12:51–15:37 UTC; unchanged today | NEW |

---

## 2. Assumptions

These are labelled so they can be challenged.

1. **Volume:** 60 jobs and ~6,000 applicant CVs a month (your figures).
2. **The 7,251 copy is an acceptable fixed snapshot** for development and acceptance tests of retrieval and matching. Results describe recall within that snapshot, not the whole database or market.
3. **Assessment prompt size is ~3,700 tokens in and ~220 out per CV.** Measured on the 120-person set: 14,664 characters average.
4. **Sourcing costs ~$0.143 per job** (measured 13 Sep across 12 jobs), until changed.
5. **A screening call averages 3–5 minutes**, with the agent speaking ~40% of it.
6. **OpenRouter's fee is ~5.5%** on credit purchases, included in estimates.
7. **Sri Lanka role levels follow the ladder** used in the screen (executive → senior executive → assistant manager → manager → senior manager → head/DGM → GM/director → CXO).
8. **Test contact goes only to your agreed test recipients.**

---

## 3. Outstanding questions

| # | Question | Needed for | Who |
|---|---|---|---|
| Q1 | **What is spending on the platform's OpenRouter key?** Usage rose $0.39 between 04:5x and 05:39 UTC today with no platform test running and no ledger entry. Is the key shared with the live server or another tool? | Spend reconciliation; any paid run | You (OpenRouter dashboard → Activity, filter by key) |
| Q2 | Set a spending limit on the platform key (and a separate key for testing) | Any paid run | You |
| Q3 | What counts as "suitable" for LinkedIn: Shortlist only, or Shortlist + Maybe? | LinkedIn pass bar | You |
| Q4 | Must a passing top-20 contain a minimum share of Shortlists, or is Shortlist + Maybe enough? (proposed: ≥ 85% S+M and ≥ 40% S) | Matching pass bar | You |
| Q5 | Approve adding `getCandidateResumesBatch` (read-only) to the allowlist, to read CVs of **named applicants only** for acceptance and reserve jobs (~1,470 CVs, no full copy) | Applicant scoring on A/R jobs | You |
| Q6 | Provide ~30 original CV files (10 scanned, 10 complex layout, 10 ordinary) and permission to process them locally | Original-file extraction, prepared CVs | You or ops |
| Q7 | Who is the second reviewer? | Label agreement | You |
| Q8 | Calls per job and calls per candidate you expect; answer minutes per call | Call budget | You or TA lead |
| Q9 | WhatsApp message category and Meta's rate for Sri Lanka on your account; messages per candidate | Follow-up budget | You or live developer |
| Q10 | Where can audio tests run: a separate voice test deployment, or the live developer running the live agent in test mode? The new platform has no dialer, and the live system must not be changed. | Audio tests | You and live developer |
| Q11 | Serper top-up pack size and price if the tests exceed 1,313 credits | Sourcing tests | You |
| Q12 | Career141 fee, guarantee and ESA terms to test against (defaults in code: 12%, 90 days) | Placement workflow | You or finance |
| Q13 | Confirm acceptance jobs A1–A6 and reserve jobs R1–R3; confirm A6 (fabric technical) is not too close to development job 5 | Job sets | You |
| Q14 | Does the deployed live system still match the 7 September code? | CODE facts | Live developer |
| Q15 | Which server-side route may run retrieval on the full live candidate set for T6b (read-only, no laptop copy)? | Production-scale coverage gate | You and live developer |
| Q16 | Create a dedicated OpenRouter key for tests with its own spending limit (for P1: $0.50), and share it only through the environment variable `C141_P1_OPENROUTER_KEY` | P1 and every later paid run | You |

---

## 4. Review points checked against code and evidence

### 4.1 Points from the request (revision 2)

| Point | Verdict | Evidence and change |
|---|---|---|
| Retrieval misses must use reviewed candidates inside and outside results, including model rejects | **Agree** | Revision 1 had reviewers check only people the local screen flagged, so people the screen wrongly rejected could never count as misses. Now there are stratified random samples inside and outside the pool, drawn regardless of any model verdict, and misses are estimated with stratum weights (T6) |
| Evaluate the actual top-ranked database results; Shortlist and Maybe separately | **Agree** | Revision 1 labelled only 10 top matches per job, so "top 20 ≥ 85%" couldn't be computed. Now the system's actual top 20 (database) and top 20 (applicants) are labelled in full, reporting Shortlist, Maybe and Reject separately (T7) |
| Separate development and model selection from untouched acceptance | **Agree** | Revision 1 priced model comparison on 360 people including 240 acceptance labels, which would tune on the acceptance set. Now models are compared on development jobs only; one frozen configuration runs once on acceptance; reserves run once at the end (section 5) |
| Verify identity and evidence of every published LinkedIn suggestion | **Agree** | Revision 1 sampled 20. Now every published profile is checked for identity (right person, current role, not a namesake) and for the evidence line behind its suitability (T9) |
| Cover original CV extraction, prepared CVs, permissions, interview-to-placement and the other workflows | **Agree** | Missing or thin in revision 1. `lib/pdf.ts` needs original PDFs; `lib/auth.ts` and `lib/visibility.ts` exist with 19 test cases; `lib/closing.ts` exists with 34. Added T1, T3, T15, T16 |
| Ordinary, senior and specialist jobs in end-to-end tests | **Agree** | Revision 1 used A1 and A3 only. Now A1 (ordinary), A3 (senior), A6 (specialist), then R1–R3 (T19) |
| Price all required stages including holdouts and audio; conditional and unknown costs separate | **Agree** | Section 7 separates required, conditional and unknown costs, stating the information each unknown needs |
| Reconcile the ledger with provider usage by key and period | **Agree, partly possible** | Per-key, per-day, per-model breakdown needs an OpenRouter management key or the dashboard. Serper exposes only a balance. Section 6 gives what can be verified and what's missing |
| Separate facts, assumptions, questions | **Agree** | Sections 1–3 |
| **Partial disagreement:** "copy the full database before measuring retrieval" (revision 1's own recommendation) | **Withdrawn** | A full copy isn't needed to measure retrieval correctly. Recall within a fixed snapshot (the 7,251 copy) is valid if stated as such. Applicant scoring needs only named applicants' CVs (Q5). Whole-database coverage becomes a later, separate performance test |
| **Partial disagreement:** labelling everything with a second reviewer | **Keep it partial** | Full double review of 6 jobs would roughly double reviewer time. The second reviewer covers the jobs most likely to disagree (senior A3, specialist A6) plus a 20% random slice of the others, which still measures agreement per role type |

---

### 4.2 Codex review of revision 2: claims checked

| Claim | Verified in code or data | Change |
|---|---|---|
| `spend.ts` has only a $5 folder cap, in-memory reservations, and reads an unreadable ledger as zero | **Confirmed** (`TEST_CAP_USD = 5`; `let reserved = 0`; `read()` returned `{ spent: 0 }` on any error) | P1 uses a separate durable ledger. `spend.ts` now fails closed on an unreadable ledger (tested) |
| `ai.ts` records failed requests as free and allows four attempts | **Confirmed** (`let cost = 0` settled in `finally`; `for (attempt < 4)`) | Failed requests now keep their reservation in `ai.ts`, `embed.ts` and `serper.ts` (tested). P1 does not use `ai.ts` |
| 360 calls at 600 output tokens exceed $0.40 | **Confirmed** at the plan's 3,700 input tokens ($0.432) | P1 is now two models, measured inputs: expected $0.19, worst case $0.28, allowance $0.40 (run card) |
| `unknown` quantisation doesn't verify standard routes | **Confirmed** | Each route pinned to one named provider with a published fp8 quantisation and `allow_fallbacks: false`. GPT-5.6 Luna removed: its no-retention endpoints list no `max_tokens`, so its cost can't be bounded |
| Contact details can remain inside raw CV text | **Confirmed**: 120 CVs held 222 emails, 332 phones, 87 addresses, 36 birth dates, 54 referee sections, 65 name headers, and staff names in legacy footers. The old line-dropping filter also deleted employment dates from 54 CVs | New `deid.ts`; build stops if any identifier pattern remains; 4 lines left in a manual scan are employer addresses (kept) |
| `pdf.ts` doesn't annotate an original CV | **Confirmed** (`placeholderCv`) | Fact corrected; T3 is blocked on implementation |
| T6 strata overlap; zero counts; top-100 scoring loses ranks 101–500; P3 prices two rounds; monthly margin | **Confirmed** by reading revision 2 | T6, T7, T8, T9, section 8 and section 9 rewritten |

## 5. Job sets and data sources

### 5.1 Development jobs (tune and select models; results never count as acceptance)

| Id | Live job id | Title | Type | Existing labels |
|---|---|---|---|---|
| D4 | m1798w0p5d15779qgcaa4ncbms8b4qf4 | Procurement Manager | Ordinary manager | 40 recruiter decisions |
| D7 | m1733a4nwf2pwdrdvs5y3k6gw18drt1f | Senior Executive / Assistant Accountant | Ordinary | Claude labels only |
| D9 | m170sg6ed6evhd84nj6rg0m01s8cmtma | Head of Engineering | Senior | 40 recruiter decisions |
| D12 | m17ebv4bkeb4e3jb3pn7j5nhfs8e3mf0 | Group Chief – Supply Chain | Senior | 40 recruiter decisions |
| D8 | m17466cjjh0p3jt3j24sv997wx8dsd88 | EHS Manager | Specialist | Claude labels only |
| D2 | m176pb61fpystfj873wj9vnxrn8b2te9 | Manager – QA (Sweater) | Specialist | Claude labels only |

The other development jobs (1, 3, 5, 6, 10, 11) stay available for extra checks. **All 12 are contaminated for acceptance.**

### 5.2 Acceptance jobs (untouched; nothing runs on them until requirement lists are frozen)

| Id | Live job id | Title | Type | Recorded applicants |
|---|---|---|---|---:|
| A1 | m173jbpec250v8kx83nykf2y218b2y0w | Human Resources Executive | Ordinary | 624 |
| A2 | m171sse9z842t55hnskwhs0pe18b5xfr | Sales Executive – Business Development | Ordinary | 83 |
| A3 | m1754ctnat47zpywb8f97rtam58c9jd0 | Chief Operating Officer | Senior | 139 |
| A4 | m1722ca9v2hc03g5kjgdz540ts8cnx9e | Head of Finance (on hold) | Senior | 118 |
| A5 | m179ym14k3fnnxcg3dv22extj98c185f | Manager – IT Application SAP | Specialist | 41 |
| A6 | m176gq6q2hcn35hgqpzf54g94x8c0k74 | Manager – Fabric Technical | Specialist | 56 |

### 5.3 Reserve jobs (run once, at the end, with frozen settings)

| Id | Live job id | Title | Type | Recorded applicants |
|---|---|---|---|---:|
| R1 | m170914xvbxqj817bkeh3de0wx8drynk | Data Entry Specialist – Documentation | Ordinary | 181 |
| R2 | m17er98veewbrbwydg3s6zwgy18dszyc | General Manager – Marketing & Merchandising | Senior | 139 |
| R3 | m17eh74q9r0cp3tevgs3ztgxj98c0x9b | Human Capital Business Partner | Specialist | 88 |

**If acceptance fails and the system changes:**
- the acceptance jobs become development jobs
- the reserves become the new acceptance set
- fresh reserves come from jobs created after 14 September (about 60 new jobs arrive a month)

### 5.4 Data sources

| Data | Source | Cost |
|---|---|---|
| Database candidates | The 7,251 copy (fixed snapshot) | Free |
| Applicants for A1–A6 and R1–R3 | Live read of applicant ids per job (allow-listed) and their CV records by id (needs Q5); ~1,470 CVs, kept in the test folder, deleted after testing | Read free; embeddings ~$0.03 |
| Original CV files | ~30 files you provide (Q6) | Free locally |
| Requirement lists | Approved per job by the TA lead before any candidate is shown | Free, or optional model drafts |

---

## 6. Spend reconciliation

| Period | Local ledger | Provider |
|---|---:|---|
| 13 Sep 12:51–15:37 UTC | $1.9914: Serper $1.187 (1,187 credits), Gemini Flash plan/rank $0.528, embeddings $0.150, Claude JD $0.104, GPT-4o-mini $0.023 | Not separable by hour on the platform key |
| September to date (key) | OpenRouter part of the ledger: **$0.804** | Key usage **$4.39** (05:39 UTC 14 Sep) |
| 14 Sep 00:00–05:39 UTC (key) | **$0.00** | Key usage **$0.73**, rising $0.39 between two checks an hour apart |
| Account (all keys) | — | $107.96 of $150 credits used |
| Serper | 1,187 credits | Balance 1,313; purchase history not available through the API |

**Unexplained on the platform key: $3.58 so far**, of which $0.73 is today.

**What was checked:**
- No platform process with the test ledger active made an unrecorded call; the ledger is unchanged.
- The running preview server shows only page loads, no model calls.
- The laptop screen is local.
- The live inventory reads use Convex only.

**Likely explanations (unverified):**
1. The same key is configured somewhere else (the live server, or another tool on this machine).
2. Paid tests on 13 September before the ledger existed. This can't explain today's $0.73.

**Needed to close it:**
- OpenRouter dashboard Activity filtered to this key (per request: time, model, cost), or a management key for `/api/v1/activity`.
- A dedicated test key with a spending limit.

**Rule until closed:** no paid run.

---

## 7. Tests by workflow

Each test lists jobs, sample, source, reviewer work, procedure, pass/fail, expected cost and cap. "Cap" means the run stops when reached.

### T1. Original CV file extraction
- **Jobs:** not job-specific.
- **Sample:** 30 original files (Q6): 10 scanned or image PDFs, 10 complex layouts (tables, two columns), 10 ordinary. **Split before anyone looks:** 20 development files (fixes allowed) and 10 held-out files (4 scanned, 3 complex, 3 ordinary) run once after fixes are frozen.
- **Source:** your files, processed locally.
- **Procedure:**
  1. Extract text locally (pdf text layer; OCR with the local toolchain for scans).
  2. Build the structured profile with the platform's extractor.
  3. Compare with a reviewer's field sheet.
- **Reviewer work:** fill a field sheet per file (current title, employer, dates per role, qualifications and status, years), ~3 min each, **1.5 h**.
- **Report separately:** extraction accuracy before any human correction, and the approved-profile workflow (a TA confirms fields).
- **Pass (held-out 10, before human correction):**
  - text recovered from ≥ 9/10
  - current title and employer ≥ 95% correct
  - years within ±1 in ≥ 90%
  - qualification status ≥ 95%
  - no invented employer or qualification
- **Cost:** free locally. **Conditional:** if local OCR fails on scans, a vision model run is quoted then (unknown until page counts are known: needs pages per scan).

### T2. Profile extraction from existing CV text
- **Jobs:** development-job candidates in the copy.
- **Sample:** 60 CVs:
  - 20 ordinary
  - 20 with overlapping or concurrent roles
  - 10 with part-way qualifications
  - 10 with text under 1,000 characters
- **Procedure:**
  1. Code checks structured fields against text (dates, current role, years, qualification status).
  2. A reviewer verifies 30 of them.
- **Reviewer work:** **1 h**.
- **Pass:** same field bars as T1; unknown shown as unknown.
- **Cost:** free.

### T3. Prepared CVs
- **Blocked on implementation:** today's export draws a stand-in page. Original-file annotation (reading the PDF, measuring occupied areas, writing onto its pages) must be built first. T3 then runs through the actual export path.
- **Sample:** 15 of the T1 files (5 scanned, 5 complex, 5 ordinary), each prepared for development job D4 or D9.
- **Procedure:**
  1. Generate the prepared CV (`lib/pdf.ts`).
  2. Check the annotation block doesn't cover content.
  3. Check facts match the approved profile.
  4. Check contact details are handled per the client-CV rule.
  5. Check the file name is correct.
- **Reviewer work:** **30 min**.
- **Pass:** 15/15 readable with nothing covered; 0 wrong facts; 0 contact details where they must be hidden.
- **Cost:** free.

### T4. Duplicates and merges
- **Sample:** all 7,251 copy records; reviewer checks 50 proposed merges and 50 near-misses (same name, different details).
- **Replays:**
  - same file twice
  - email case change
  - `077…` vs `+9477…`
  - new CV changing a qualification
  - two TAs uploading the same person at once
  - headhunt entry matching an applicant
- **Reviewer work:** **40 min**.
- **Pass:**
  - 0 wrong merges in the sample
  - ≥ 98% of exact email or normalised-phone duplicates caught
  - replays keep one person with the newest facts and full history
  - concurrent upload creates one record
- **Cost:** free.

### T5. Job interpretation (requirement lists)
- **Jobs:** A1–A6, R1–R3 (JD only), plus D7, D8, D2 (development).
- **Procedure:**
  1. The platform drafts essentials, preferred, level, industry gate and years for each JD.
  2. The TA lead approves or edits before any candidate is shown.
  3. Freeze as `requirements.json` v2.
- **Reviewer work:** **10 min per job, 2 h** for 12 jobs.
- **Pass (measured on A1–A6):** ≤ 1 essential edited per job; 0 invented essentials; industry and level gates correct.
- **Cost:** rules draft free. **Optional** model drafts (Opus 5, 12 JDs × ~6k in / 1k out): expected $0.66, cap $0.90.

### T6. Retrieval misses (inside and outside results, including model rejects)
- **Jobs:** development D4, D7, D8, D9, D12, D2; acceptance A1–A6 (once, frozen configuration); reserve R1–R3 (once).
- **Snapshot:** the 7,251 copy. Results are **recall within this snapshot**, never a claim about the whole live database (see T6b).
- **Ranks** are retrieval ranks (the order the retrieval step returns), recorded before any assessment.
- **Pool:** everything retrieval returns under the frozen policy. If it returns fewer than 500, the pool is what it returns; more than 500 is not allowed by the policy.
- **Mutually exclusive strata, defined in this order; each person belongs to the first that matches:**

| Stratum | Definition | Reviewed per job |
|---|---|---:|
| S1 | Final top 20 shown (after assessment and ranking) | all 20 (shared with T7) |
| S2 | Rest of the retrieval pool | 20, random |
| S3 | Outside the pool; job core terms in title, history, skills, or industry match | 25, random |
| S4 | Outside the pool and not S3; meaning-similarity rank ≤ 2,000 | 15, random |
| S5 | Everyone else | 15, random |

- **Saved before labelling:** each stratum's size, the random seed, and the sampled ids (`runs/<run>/strata.json`).
- **Estimate:** good people per stratum = stratum size × sample good share; recall = good in S1 + S2 ÷ good in all strata. Intervals by stratified bootstrap over the samples, with each stratum's good share bounded by its Clopper-Pearson 95% interval, so a stratum with zero observed good people still contributes its upper bound.
- **Expansion rule (fixed in advance):** if the recall interval is wider than ±10 points, sample more from the stratum contributing most to the width, in steps of 15, **at most 45 extra reviews per job**. If still wider than ±10 points: **inconclusive**, not pass.
- **Diagnostic runs** that push outside-pool labelled people through a model are kept in a separate file and never count toward recall.
- **Pass (acceptance, each job):** recall lower bound ≥ 80% and point estimate ≥ 90%. **Fail:** upper bound < 90%. Otherwise inconclusive.
- **Reviewer work:** 95 per job before expansion (75 unique beyond S1), included in T7's manifest.
- **Cost:** retrieval free. Applicant embeddings for A and R jobs: P4.

### T6b. Production-scale coverage (separate gate before any live coverage claim)
- **Question:** does retrieval on the full live candidate set keep the good people the snapshot result suggests?
- **Needs:** approved server-side retrieval against the live data (no laptop copy), or a sanctioned server copy. Environment and cost are **unknown** until that route is agreed (Q15).
- **Procedure:** for A1 and A3, the same five strata on the full set, same expansion rule.
- **Pass:** same as T6. No live coverage claim is made until it passes.

### T7. Assessment and ranking (database matches and applicants)
- **Jobs:**
  - development: D4, D7, D8, D9, D12, D2
  - acceptance: A1–A6
  - reserve: R1–R3
- **Sample per job (one blinded list merged with T6):**

| Group | Reviewed |
|---|---:|
| System's actual top 20 database matches | 20 |
| System's actual top 20 applicants (A and R jobs; all applicants if fewer than 20) | 20 |
| Random applicants ranked below 20 | 10 |
| Current rules score top 20 (baseline; overlap removed) | up to 20 |
| T6 strata I2 + O1 + O2 + O3 | 55 |

- **Selection policy being tested (production order):** retrieval pool → cheap screen on **every** person in the pool → second look on everyone the routing rule sends → rank → show top 20. Nobody is dropped for rank alone before the screen, so ranks 21–500 are screened and their misses are counted (S2 in T6).
- **Manifest:** before any quote or labelling, generate a **deduplicated candidate-job manifest** per job (union of all groups; a person appearing in several groups is reviewed once). Existing labels are reused only where a person is in the new manifest.
- **Size:** set by the manifest; estimated up to ~135 unique per A/R job and ~110 per development job.
- **Reviewers:**
  - lead reviews everything, with a reason on every Maybe/Reject
  - second reviewer reviews A3 and A6 in full, plus a random 20% of the other acceptance jobs
  - disagreements over 20% on a job are resolved before scoring
- **Reviewer time:** not estimated from assumptions. **Timing pilot first:** the lead reviews 20 people for D7 with reasons and CV evidence, timed. Review hours for every set are then computed from the measured rate (the 20 count toward D7). Labels are never rushed to meet an estimate.
- **Report per job, top 20 database and top 20 applicants separately:**
  - Shortlist, Maybe and Reject counts
  - Shortlists and Maybes the system rejected before a second look
  - ranking AUC against yes/no
  - per role type
- **Uncertainty:** every proportion with a Wilson 95% interval; AUC with a bootstrap interval.
- **Gates, per job (no averaging across jobs):**
  - top 20 database: Shortlist + Maybe ≥ 85%. **Pass** if the Wilson lower bound ≥ 70% and the point estimate ≥ 85%; **fail** if the upper bound < 85%; otherwise **inconclusive**
  - top 20 applicants: same
  - reviewer Shortlist + Maybe rejected before a second look ≤ 10% (same pass/fail/inconclusive rule, reversed)
  - AUC ≥ 0.90 (point estimate), reported with interval
  - Shortlist share: **proposal** ≥ 40% of top 20, pending Q4; reported, not gated, until agreed
- **Release reading:** acceptance passes only when every acceptance job passes each gate. An inconclusive job needs more evidence (a reserve job of the same role type), never an average. Six jobs are acceptance evidence, not proof of stable population-wide accuracy.
- **Cost:** see T8 and section 8.

### T8. Model selection (development only)
- **Configurations**, compared on the same development labels:

| Config | What it is |
|---|---|
| C0 | Rules score |
| C1 | Laptop screen (Qwen3.8-27B, evidence-quote prompt v3) |
| C2 | DeepSeek V4.1 Flash |
| C3 | GLM 5.3 Flash |
| C4 | GPT-5.6 Luna (**on hold:** no no-retention endpoint lists `max_tokens`, so cost can't be bounded; re-check each run) |
| C5 | Routing: the cheapest of C2–C4 that holds your Shortlists, plus a stronger second look |

  - **Routing rule, fixed in advance:** a Maybe, any gate with no quoted evidence, an unsure company, related work, or any Shortlist goes to the second look.
  - **Second-look models:** Gemini 3.8 Flash, or Sonnet 5 only if Gemini fails.
- **Settings:** no-retention routes, standard (not fp4) endpoints, reasoning off, output capped at 600 tokens.
- **Stage A:** the existing 120 (D4, D9, D12). **Stage B:** full development labels (T7 development lists, ~600 people).
- **Scoring** runs the full selection policy (T7) on every pool member; labelled outside-pool people are scored only as diagnostics, kept separate from pipeline results.
- **Selection rule:** the cheapest configuration that meets the T7 bars on development with a 3-point margin, whose projected monthly cost fits the $50 bucket (section 9). Stop escalating once one passes.
- **Pass to proceed to acceptance:** meets the development bars with margin. Otherwise report the gap and the smallest next change.
- **Cost:** see P1 and P2 in section 8.

### T9. LinkedIn suggestions
- **Development:**
  1. **Stage A (free):** you review the existing 36 suggestions for D4 (13), D9 (14), D12 (9), checking identity and evidence. This measures today's quality independently.
  2. **Stage B:** after changes, **one** sourcing round each for D4, D7, D8, D9, D12, D2. The baseline is the existing 13 September output (Stage A), not a paid re-run.
- **Acceptance:** one round each for A1–A6. **Reserve:** R1–R3.
- **Procedure:**
  1. Measure each stage: queries, profiles found, duplicates removed, identity rejects, screen rejects, published.
  2. **Every published profile** is checked by a reviewer opening it:
     - identity: right person, current employer and title match, not a namesake
     - evidence: the stated reason is supported on the profile
     - suitability: Shortlist, Maybe or Reject
  3. A random 10 of the profiles removed by the screen per job are also reviewed, to catch wrongful removal.
- **Reviewer work:** opening each profile and checking identity and evidence; time per profile is measured on the Stage A review (36 profiles) and used to plan the later stages. Not rushed to fit an estimate.
- **Headline suitability** counts reviewer-confirmed suitable profiles only, with Maybes shown separately, until Q3 is decided. It is not silently replaced by Shortlist + Maybe.
- **Pass (each acceptance job, no averaging):**
  - 10–15 published
  - suitable share ≥ 90%, with a Wilson lower bound reported (at 10–15 profiles one miss already drops to 90–93%, so a pass is evidence, not proof)
  - 0 wrong-identity and 0 unsupported claims among published
- **Fail:** fewer than 10 published, or any wrong identity or unsupported claim, or suitable share < 90%.
- **Fewer than 10 found:** reported as "found fewer than 10 within the tested searches and budget". That is a **fail**, not a scarcity pass. A scarcity claim needs broader evidence (wider search plan, a recruiter's market check) and is recorded separately.
- **Cost:** see P3, P6, P8.

### T10. Company research
- **Development:** one client each for D4, D9, D12 (client names recorded).
- **Acceptance:** A3, A6.
- **Procedure:**
  1. Generate the research brief.
  2. The reviewer checks every factual claim against its cited page and date.
  3. Unknowns must stay blank.
- **Reviewer work:** ~20 claims per brief, ~25 min each brief; **~2 h** in total.
- **Freshness by claim type:** the reviewer checks the source supports the claim **as written** and its relevant date: current titles and employers need a source from the last 6 months or an explicit "as of" date; company size, revenue and ownership within 12 months; history can be older if stated as history.
- **Pass:** ≥ 95% of claims supported as written; 0 invented facts, companies or people; 0 current-tense claims backed only by a stale source.
- **Cost:** pilot P9 first (web search is billed by the provider). Later briefs are quoted after the pilot measures tokens and search charges.

### T11. Benchmarking
- **Development:** D4 pilot, then D9, D12. **Acceptance:** A3, A6.
- **Procedure:**
  1. The benchmark (Serper + Gemini Flash sort) returns comparable companies and people.
  2. The reviewer checks each against the cited result, and that it's a real, relevant peer.
- **Reviewer work:** ~30 items per job, ~30 min each; **~2.5 h** in total.
- **Pass:** ≥ 90% relevant; 0 invented or wrong-identity people; all sources resolvable.
- **Cost:** P10 pilot, then P11.

### T12. Calls
- **T12a, transcript interpretation (synthetic):**
  - 40 transcripts written by you and the TA lead: consent refusal, wrong person, salary in LKR / lakhs / USD / "same as now", notice in days / weeks / months, callback request, withdrawal, language switch, silence, abuse, two people answering.
  - Run through `lib/voice.ts` answer reading and the state plan.
  - **Reviewer work:** writing ~2 h; checking ~30 min.
  - **Pass:** ≥ 95% of fields correct; 0 critical failures (wrong person accepted, consent or withdrawal ignored, duplicate call scheduled, call outside allowed hours).
  - **Cost:** rules only free. If a model reads answers: GPT-4o-mini, 40 × ~3k in / 200 out, expected $0.02, cap $0.10 (P12).
- **Implementation dependency:** the new platform has no dialer, audio pipeline or provider event intake. T12a tests logic with fakes; T12b needs an audio harness built and approved first. Live-pilot readiness is reserved until T12b passes.
- **T12b, audio calls (required before any pilot; needs Q10):**
  - 30 calls to your test number only, 3 scripts × 10 runs (clean line, noisy background, non-native English): 3–5 minutes each, ~120 min in total.
  - **Measure:** word accuracy on the answer fields, answer-field accuracy, latency, interruptions, hang-up handling, event delivery to the platform.
  - **Pass:** ≥ 95% answer fields correct; 0 critical failures; every call has a delivered result record.
  - **Cost:** P13 (carrier excluded).

### T13. Follow-ups and messaging
- **T13a (simulated, free):** 40 scenarios:
  - no reply
  - late reply
  - Colombo quiet hours
  - withdrawal after a message is queued
  - callback tomorrow
  - repeated webhook
  - provider timeout
  - restart mid-sequence
  - no phone (email only)
  - two jobs for one person
  - candidate already placed
  - Messages go to a fake outbox.
  - Also: callback requested in the candidate's local time zone (for example Dubai) versus Colombo; withdrawal from one job while active on another (only that job stops unless they say all); a provider event arriving after the chase has moved on; a delivery report arriving twice.
  - **Delivery states kept distinct:** attempted → accepted by provider → delivered → read, plus failed. A failure or a missing delivery report is never shown as delivered.
  - **Pass:** 0 duplicate or out-of-hours messages; withdrawal stops exactly the jobs it names; every message has one record with its true state; no message after placement or rejection; late events never reopen a closed chase.
- **Implementation dependency:** the new platform sends nothing today; a sending integration with delivery reports must be built before T13b.
- **T13b (required before any pilot):** 10 real sends to your test email and WhatsApp only.
  - **Cost:** email via Microsoft 365 is free under the existing licence (assumption). WhatsApp templates: unknown until Q9 gives the category and rate. P14 is quoted then.

### T14. Director and client replies
- **Sample:** 30 replies written by the TA lead to a numbered shortlist email:
  - numbers
  - names
  - "all except 3"
  - corrections
  - reply to an older email
  - forwarded thread
  - out-of-office
  - mixed decisions
  - a decision about someone not on the list
  - a reply to the same shortlist after some people were already decided ("shortlist 2 and 4" when 1 was decided yesterday)
  - "the second one" when the list order has since changed
- **Reviewer work:** writing ~1 h.
- **Pass:** 0 decisions applied to the wrong person; ambiguous replies held for a person; ≥ 95% applied without help.
- **Cost:** rules part free. Parse model (Gemini 2.5 Flash-Lite, 30 × ~2k in / 300 out): expected < $0.01, cap $0.05 (P15).

### T15. Interview → offer → placement → guarantee
- **Sample:** 25 scenario replays in the test store:
  - interview scheduled, moved, no-show
  - offer made, countered, declined
  - accepted then fell through
  - placement with monthly salary
  - fee calculation
  - guarantee replacement inside and outside 90 days
  - ESA draft → signed → expired
  - two TAs claiming the same placement
- **Reviewer work:** finance or ops checks fees and dates against Career141 terms (Q12), **~45 min**.
- **Pass:** 25/25 correct stage, fee, guarantee date and ESA state; 0 stage changes without a named person; placement locks the candidate from other chases.
- **Cost:** free.

### T16. Permissions and visibility
- **Matrix:** 6 roles (director, TA lead, TA, ops, viewer, client contact) × deactivated × assigned/unassigned × 25 actions, covering:
  - reading candidates
  - claiming a match
  - moving stages
  - approving
  - sending
  - exporting a prepared CV
  - Ask answers
  - reports
  - review lists
  - suggestions
  - settings
- **How it's tested:** each action through its server action or API route, not just the page.
- **Also:** a tampered cookie, a stale session after deactivation, and concurrent claims.
- **Reviewer work:** you confirm the intended matrix once, **~30 min**.
- **Pass:** 0 unauthorised reads or writes; client contacts see only their own jobs' approved candidates; Ask never reveals out-of-scope data.
- **Known gap:** stage-one auth (no password) must be replaced before any pilot, whatever this test finds.
- **Cost:** free.

### T17. Reporting and Ask
- **Sample:** 25 unseen questions from the TA lead: counts, filters, dates, per-TA, per-stage, qualifications, "who is waiting", plus 5 that should be refused (out of scope).
- **Procedure:** answers are checked against the same figures computed in code.
- **Pass:** ≥ 95% correct; 0 invented candidates; out-of-scope requests refused.
- **Cost:** GPT-4o-mini, 25 × ~6k in / 300 out: expected $0.03, cap $0.10 (P16).

### T18. JD drafts
- **Sample:** existing drafts for D4, D9, D11 (Opus, Sonnet, the team's own), blinded. These already informed the model choice, so they are development. **Held out:** 3 new Opus drafts for A2, A4, A5 (P19), marked once after the choice is frozen.
- **Reviewer work:** **15 min**.
- **Pass (held-out):** usable with light edits on 3/3, judged before any human correction.
- **Cost:** free (drafts exist). A new model is quoted only if both fail.

### T19. End-to-end workflow (shadow)
- **Jobs:** A1 (ordinary), A3 (senior), A6 (specialist); then R1, R2, R3 once.
- **Precondition:** T1–T18 pass on development and acceptance.
- **Flow:**
  1. approved brief
  2. requirement list
  3. applicant intake and database matching
  4. LinkedIn suggestions
  5. TA review
  6. simulated follow-up and call outcomes (T12a/T13a scenarios)
  7. synthetic director and client replies
  8. interview, offer, placement replay
  9. report and Ask
- **Replays during the run:** revised JD, duplicate CV, qualification change, withdrawal, late reply to an older shortlist, restart, provider timeout.
- **Reviewer work:** TA lead operates each job as normal, ~2 h per job; **~12 h** in total over the six jobs.
- **Pass:**
  - all component bars hold on each job
  - 0 critical contact or decision failures
  - correct person, job and stage throughout
  - TA time per accepted candidate recorded and compared with today's process on similar jobs
- **Cost:** see P17 and P18.

### T20. Monthly cost verification
- **Procedure:** from measured unit costs (tokens per CV, sourcing per job, research per brief, minutes per call), project 60 jobs and 6,000 CVs, with volumes for calls and messages from Q8/Q9, adding a 20% margin.
- **Pass:** each bucket ≤ its ceiling with margin. If not, report the gap and test cost-only changes (cache use once verified, fewer second looks, shorter evidence) without lowering the quality bars.
- **Cost:** free.

---

## 8. Test costs

Prices checked 14 September on OpenRouter's public endpoint list (no-retention endpoints only). Amounts below are provider usage; OpenRouter adds ~5.5% when credits are bought, shown in the totals. Serper credits are valued at $0.001 each.

**Every paid stage is approved separately**, with its own frozen manifest, expected cost, maximum, and cap behaviour: the run stops before any request whose worst case would take committed spend past its allowance, marks everything after as not run, and nothing escalates, retries in bulk or expands without a new approval.

### 8.1 Prerequisites to a successful launch (successful path)

| # | Stage | Trigger | Scope | Expected | Max |
|---|---|---|---|---:|---:|
| P1 | Model check A | Q1, Q16 done; laptop baseline finished | 2 models × 120 frozen development requests ([run card](P1-RUN-CARD-2026-09-14.md)) | $0.20 | $0.40 allowance (reservations are estimates; see card) |
| P2 | Model check B | P1 continue-rule met; deduplicated development manifest generated | Surviving models × development manifest (≈ 660 unique people). **Re-quoted from the manifest before approval** | $1.65 | $2.20 |
| P2b | Second look, development | Routing rule frozen | Gemini 3.8 Flash on the routed share (assumed 35%) | $0.80 | $1.10 |
| P3 | LinkedIn sourcing, development | Suggestion changes frozen | D4, D7, D8, D9, D12, D2 × **1 round** (~600 Serper credits) | $0.86 | $1.50 |
| P4 | Applicant embeddings | Q5 approved | ~1,470 applicant CVs for A1–A6, R1–R3 | $0.03 | $0.10 |
| P5 | Acceptance assessment | Configuration frozen; A-job requirements and labels frozen | Full selection policy on A1–A6 pools and applicants + second look | $4.47 | $5.80 |
| P6 | LinkedIn, acceptance | P3 passes | A1–A6 × 1 round (~600 credits) | $0.86 | $1.50 |
| P7 | Reserve assessment | Acceptance passes | R1–R3 | $1.96 | $2.60 |
| P8 | LinkedIn, reserve | Acceptance passes | R1–R3 (~300 credits) | $0.43 | $0.80 |
| P9 | Research pilot | Anytime | 1 brief, D4 client | $0.20 | $0.40 |
| P9b | Research, development + acceptance | P9 passes | D9, D12, A3, A6 | $0.80 | $1.60 |
| P10 | Benchmark pilot | Anytime | D4 (~30 credits) | $0.15 | $0.30 |
| P11 | Benchmarks, development + acceptance | P10 passes | D9, D12, A3, A6 (~120 credits) | $0.60 | $1.20 |
| P12 | Transcript reading | Synthetic transcripts written | 40 transcripts, GPT-4o-mini | $0.02 | $0.10 |
| P13 | Audio calls | Q10 route agreed, audio harness built, T12a passes | 30 calls × ~4 min to your test number. **Excludes** the unknown Deepgram privacy surcharge and test environment | $2.50 | $4.00 |
| P15 | Reply parsing | Replies written | 30 replies, Gemini 2.5 Flash-Lite | $0.01 | $0.05 |
| P16 | Ask | Questions written | 25 questions, GPT-4o-mini | $0.03 | $0.10 |
| P17 | End-to-end shadow | T1–T18 pass | A1, A3, A6 then R1–R3, model usage beyond P5–P8 | $1.50 | $2.50 |
| P19 | JD drafts, held out | Model choice frozen | 3 Opus drafts (A2, A4, A5) | $0.08 | $0.15 |
| | **Provider usage, successful path** | | | **$17.15** | **$26.40** |
| | **With ~5.5% credit fee** | | | **≈ $18.09** | **≈ $27.85** |

- **Not included:** existing test spend ($1.99 ledger; $4.39 on the platform key), P13's unknown surcharge and environment, T6b (unknown until Q15), messaging sends (T13b), and anything in 8.2.
- **Illustrative only, not an all-inclusive testing maximum.** Arithmetic on today's prices and measured sizes; it excludes unresolved items. P2, P5 and P7 are re-quoted from their deduplicated pool manifests before approval, and may be larger if pools approach 500 per job.

### 8.2 Optional or failure-driven (only if a trigger occurs)

| # | Stage | Trigger | Expected | Max |
|---|---|---|---:|---:|
| P2c | Sonnet 5 second look, development (replaces P2b) | Gemini second look fails development bars | $2.15 | $2.80 |
| P5c | Acceptance with Sonnet 5 second look (replaces P5) | P2c chosen | $8.90 | $11.00 |
| P7c | Reserve with Sonnet 5 second look (replaces P7) | P2c chosen | $3.90 | $4.90 |
| P1e | Vision OCR for scans | Local OCR fails T1 development files | Unknown until page counts are known | — |
| P18 | Model drafts of requirement lists | You prefer drafts to rules | $0.66 | $0.90 |
| Re-runs | Any stage after a fix | A bar fails and a fix is approved | Same as the original | Same |

### 8.3 Three separate amounts

**1. Incremental service usage** (draws on balances already held): section 8.1. OpenRouter account credit remaining: ~$42 of $150, shared with other usage on the account.

**2. New cash purchases:**

| Item | Needed because | Amount |
|---|---|---|
| Serper top-up | Successful path needs ~1,650 credits (P3 600, P6 600, P8 300, P10 30, P11 120) against 1,313 held | ≥ 340 credits; pack price unknown (Q11) |
| Deepgram | Audio tests (P13) | Possibly covered by the $200 new-account credit; privacy surcharge unknown |
| WhatsApp template sends (T13b) | Delivery test | Unknown until Q9 |
| OpenRouter credit | Only if other usage on the account consumes the remaining ~$42 | $0 planned |

**3. Reviewer and implementation effort:**
- **Reviewer:** set after the T7 timing pilot. Fixed items already known: requirement lists 2 h (TA lead), synthetic scenarios ~4 h (you + TA lead), permissions matrix 30 min, extraction field sheets 1.5 h, duplicate sample 40 min, research and benchmark claim checks ~4.5 h, JD marking 30 min, end-to-end operation ~2 h per job × 6.
- **Implementation dependencies before their tests can run** (estimates, to be confirmed when scoped):
  - original-CV annotation for prepared CVs (T3)
  - stratified sampler, strata file and bootstrap/Clopper-Pearson estimator (T6)
  - full selection policy with routing and second look (T7/T8)
  - audio harness and provider event intake (T12b)
  - sending integration with delivery states (T13b)
  - server-side retrieval route for T6b (Q15)
  - real authentication before any pilot (T16)

### 8.4 Unknown costs and what is needed

| Item | Why unknown | Information needed |
|---|---|---|
| WhatsApp template messages | Category, country and account tier | Q9 |
| Deepgram privacy surcharge | Opt-out pricing not on the public page | Deepgram plan or quote |
| Audio test environment | No dialer in the new platform; live system must not change | Q10 |
| Serper top-up | Pack price not in the API | Q11 |
| Vision OCR | Scan page counts; whether local OCR fails | T1 development files |
| T6b production-scale retrieval | Route not agreed | Q15 |
| Unexplained OpenRouter usage | Source not identified | Q1 |

---

## 9. Monthly operating model

A projection to confirm in T20, not a quote.

| Bucket | Driver (assumed volume) | Projection | With 20% margin | Ceiling |
|---|---|---:|---:|---:|
| LinkedIn suggestions | 60 jobs × 1 round at $0.143 (before quality changes) | $9.07 with fee | $10.88 | $100 |
| Database / scoring / research / benchmarking | 12,000 cheap assessments (6,000 applicants + **100 database people per job**) + 35% second look (Gemini 3.8 Flash) + 60 benchmarks + 20 research briefs + embeddings | $40.80 with fee | **$48.96** | $50 |
| Same, Sonnet 5 second look | 35% × 12,000 | ~$67.50 with fee | ~$81 | $50: **over** |
| Calls and follow-ups | Per 4-minute call ≈ $0.08 (speech-to-text, voice, model); messaging unknown | Needs Q8, Q9 | — | $50 |

**Pool size decides whether this fits (Codex, P1 review).** The row above assumes 100 database assessments per job. Revision 3 screens every person in the retrieval pool, up to 500 per job:

| Database pool screened per job | Cheap assessments a month | Projection with fee | With 20% margin | Within $50? |
|---|---:|---:|---:|---|
| 100 | 12,000 | $40.80 | $48.96 | yes, barely |
| ~105 (break-even at today's unit costs) | 12,300 | $41.60 | $49.90 | limit |
| 250 | 21,000 | $61 | $73 | no |
| 500 | 36,000 | $95 | $114 | no |

Unit cost per database person: cheap screen ~$0.00087 plus 35% × ~$0.0036 second look ≈ $0.0021. Fixed monthly items: 6,000 applicants (~$12.80), benchmarks, research and embeddings (~$13.20).

- **The full-pool policy fits $50 only if pools average about 105 people per job**, at today's measured prompt size and assumed routing share. That is not established.
- **P2, P5 and P7 quotes, and this projection, are recomputed from the actual pool manifests** (T7) and the routing share P2 measures.
- **If pools are larger, recall and budget pull against each other.** The options are measured, never assumed: a free first cut before the paid screen, validated in T6 so good people aren't lost; a smaller pool with T6 proving recall holds; cheaper second looks; or you decide on the ceiling. Quality gates are not lowered to fit.

**Implications:**
- **The database bucket has little headroom** ($1.04 with margin, at 100 per job). Affordability is not asserted until P1–P2 measure the real prompt size, output length and routed share.
- **If it doesn't fit, routing isn't cut to make it fit when that fails quality.** First try cost-only changes that keep the bars: shorter evidence text, not re-screening unchanged CVs, cached job text once verified with no-retention routes.
- **LinkedIn has headroom** for quality changes up to ~10× today's cost.
- **Sonnet 5 can't be the routine second look** within $50.

---

## 10. Order of work

1. **Free now:**
   - Q1 and Q16 (spend source, dedicated test key with limit)
   - laptop baseline on the frozen P1 inputs (running)
   - T7 timing pilot (20 people, D7)
   - your review of the existing 36 suggestions and 3 JD drafts
   - TA lead approves requirement lists (T5)
   - synthetic scenarios (T12a, T13a, T14, T15)
   - duplicates (T4), text extraction (T2), permissions (T16)
2. **P1** on approval → decide whether P2 is worth the development labels.
3. **Development labels** from the deduplicated manifests; stratified sampler built.
4. **P2 / P2b** (re-quoted from the manifest) → freeze the configuration.
5. **P3** LinkedIn development (one round) → fix → freeze.
6. **Build** the implementation dependencies needed for acceptance (selection policy; original-CV annotation; sending and audio harnesses in parallel).
7. **Acceptance:** P4, P5, P6 on A1–A6 once; T1/T18 held-out portions; P9/P9b, P10/P11.
8. **Audio P13** after Q10 and T12a; **T13b** sends.
9. **End-to-end T19** on A1, A3, A6; **T6b** production-scale coverage.
10. **Reserve:** P7, P8 and T19 on R1–R3.
11. **T20 monthly cost check** → shadow → supervised pilot.

---

## 11. Changes

### From revision 2 (this revision)

1. **P1 made executable and bounded:** a separate durable run ledger that fails closed, a frozen hash-checked manifest, pinned no-retention fp8 routes with no fallback, one retry only on no response, uncertain charges held at maximum, stop on allowance, overrun or three failures in a row. Proven by 30 mocked runner and ledger checks and dry runs on the real 240 frozen requests, including a killed process and restart.
2. **P1 scope corrected:** two models (GPT-5.6 Luna can't be cost-bounded), measured inputs: expected $0.19, worst case $0.28, allowance $0.40; incomplete or invalid answers reported, never dropped.
3. **De-identification rebuilt and verified on the outgoing text;** described as de-identified, not anonymous.
4. **General spend guard fixed:** unreadable ledger stops paid calls; failed requests keep their reservation.
5. **Prepared-CV fact corrected;** audio, messaging and original-CV annotation marked as implementation dependencies.
6. **T6:** mutually exclusive strata with saved sizes, seeds and ids; retrieval ranks; zero-count-safe intervals; capped expansion; inconclusive outcome; separate production-scale gate T6b.
7. **T7:** full selection policy (no top-100 cut), deduplicated manifests, per-job pass/fail/inconclusive gates, intervals, timing pilot instead of assumed review speed.
8. **T9:** one development round; headline counts confirmed suitable only; unproven scarcity is a fail.
9. **Held-out portions** for original-file extraction and JD drafts; delivery states and edge cases for follow-ups and replies; claim-specific research freshness.
10. **Costs:** successful path $17.15 expected / $26.40 max in provider usage (≈ $18.09 / $27.85 with fee), shown separately from optional stages, cash purchases and effort; monthly database projection $48.96 with margin.

### From revision 1

1. **Retrieval misses** are now measured with random, stratified reviews inside and outside the pool, independent of any model's verdict, with weighted estimates and intervals.
2. **The system's actual top 20** (database and applicants) are labelled in full; Shortlist, Maybe and Reject reported separately, with a Shortlist-share question (Q4).
3. **Model selection moved entirely to development jobs.** Acceptance runs one frozen configuration once; reserves run once at the end.
4. **Every published LinkedIn profile** is checked for identity and evidence, plus a sample of removed profiles.
5. **Added:** original-file extraction (T1), prepared CVs (T3), interview-to-placement (T15), permissions (T16).
6. **End-to-end** covers ordinary, senior and specialist jobs (A1, A3, A6), then R1–R3.
7. **Withdrew the full-database copy.** Tests use the fixed 7,251 snapshot, plus named applicants' CVs read by id (Q5).
8. **All stages priced** (required $12.65 expected / $17.95 cap), with conditional stages, unknowns and the information needed for each.
9. **Spend reconciliation** by key and period: $3.58 unexplained on the platform key, still rising today; no paid run until closed.
10. **Sections for facts, assumptions and questions**; a monthly operating projection showing Sonnet 5 as a routine second look would exceed $50.

---

## 12. Proposed first paid experiment: P1

Specified in full in [P1-RUN-CARD-2026-09-14.md](P1-RUN-CARD-2026-09-14.md): question, preconditions, frozen manifest and hash, routes and prices, de-identification evidence, attempt and charge policy, expected and worst-case cost, allowance and stop behaviour, mocked and dry-run evidence, outputs, and what the result can and can't show.

**Summary:** DeepSeek V4.1 Flash and GLM 5.3 Flash, 120 frozen development requests each (jobs 4, 9, 12), compared with the laptop baseline on the identical inputs. Expected **$0.19**, worst case **$0.28**, allowance **$0.40**. Not authorised until you approve that manifest hash.
