# Follow-up reply bot: plan and status

When a candidate in Follow-up answers our WhatsApp message or email, one handler
reads the reply and answers it. That handler is
`convex/communications/inboundExtraction.ts:extractDetailsFromText`. It saves
the details, answers questions from the opening's own facts, asks for what is
still missing, and schedules the next reminder. WhatsApp and email use the same
handler; only the way the reply arrives differs.

How it works today: `.claude/skills/follow-up/SKILL.md` (Flow F) and
`.claude/skills/email-intake/SKILL.md`. Full review this builds on: the Astra
plan of 29 Oct (owner's copy, shared with Prabhu).

## How a reply arrives

| Channel | Path into the handler | Application passed |
|---|---|---|
| WhatsApp | Meta webhook `whatchimp.ts` → `whatsappOutbound:checkAndRecordFollowUpReply` | yes |
| Email (poller: linkedin@, cv@, job@, per-job inboxes) | `emailAgent:checkAndRecordEmailReply` | yes |
| Email (Graph subscription) | `graphEmailMutations` | yes |
| Email (mail intake: job@ and TA mailboxes) | `mailIntake/process.ts` → `replyingCandidate` | yes, since 29 Oct |

## Done: PR #322 (29 Oct)

Both channels:
- A promised time is kept. It used to be set and then erased.
- A promise over 72 hours saves the answers in the same message, thanks the candidate, and flags a TA.
- "Not interested" thanks the candidate once and stops the chase. "Stop contacting me" sets do-not-contact and sends nothing. "Can I speak to someone" says a consultant will call. Each of these flags a TA, and none moves the stage.
- One- and two-letter replies are read.
- After saving, the turn re-reads its own application.
- Salary in words counts as answered.
- No invented location or workplace type. Students are not given a salary of 0.
- Model calls take at most 2 × 20 s, and a failure falls back safely.

Email only:
- Only the candidate's new words are read: no HTML, and not our own email quoted underneath.
- The reply email says what was decided. It no longer always lists the missing details.
- Out-of-office auto-replies are not answered.
- Email questions are filed as email, not WhatsApp.
- Mail intake passes the application.

Checks: `tests/replyturn.test.ts` runs the real handler with a faked model and database, 15 cases. `tests/replyrouting.test.ts` checks that every path passes the application.

## Done: one "complete" rule (29 Oct)

- Owner: current salary is **not** required. It is still asked for, but never holds a candidate back.
- `ta/stages.ts followUpBlockers` (Director Review's CV, expected salary and notice period, plus the opening's own questions) is now the only "complete" rule. The bot, the sweep, `checkAndAdvanceFollowUp`, Day 0 and a TA's logged call all use it.
- `checkAndAdvanceFollowUp` moves the stage through the state machine, so the move writes a pipeline event and stops the reminders.
- Not changed: the lists of what a message asks for are still built in several places. Only the decision is shared.

Checks: `tests/followupsweep.test.ts`.

## Still to do (in order)

1. **Reply identity and duplicates.**
   - WhatsApp: store Meta's message id and the receiving number, and drop duplicates by id, not "same text within 30 s".
   - Email: when job@ is read by both the poller and mail intake, one reply can be recorded twice. Make one path own it.
2. **Delivery status.** Store Meta's sent/delivered/read/failed callbacks against the message. Today a reply is shown as "sent" before Meta accepts it.
3. **CV by reply.**
   - A CV attached to a WhatsApp message or an email should be linked to the same application and close the CV item.
   - "I sent my CV" is not a CV.
4. **Sender identity.**
   - Each opening sends from its TA's number once those accounts are connected.
   - Email replies go from the mailbox the candidate wrote to.
   - Sign the reply with the TA's name. *Owner decides.*
5. **Hand-over controls.** A TA can pause and resume the bot per application, and every queued send checks that at send time.
6. **Live acceptance.** One test candidate, with the owner's number and email. Initial message, then a greeting, a question, partial answers, a correction, a promise, a CV, and the last answer. Check the form after each turn. Needs Meta billing (error 131042) fixed first.

## Rules that do not change

- Every send goes through `lib/outreachSafety.ts` and `lib/outboundGuard.ts`.
- `OUTREACH_LIVE` is never set in code.
- Live changes go only through the release pipeline, after the owner says go.
