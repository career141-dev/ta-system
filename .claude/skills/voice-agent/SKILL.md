---
name: voice-agent
description: Aura, the AI voice screening agent - LiveKit worker (voice-agent/), browser Call window in Follow-up, /voice practice page, SIP dial dispatch (VOICE_ENGINE), signed events route, post-call answer extraction, ElevenLabs legacy. Also "Aura", "AI call", "screening call", "voice call", "Call with Aura", "LiveKit". Use when changing, debugging or extending Aura's prompt/turn-taking, call sessions, consent, dial safety, transcript-to-record filling, or voice deploys.
---

# Voice agent (Aura screening calls)

## Scope and boundaries

In this skill: the `voice-agent/` worker, everything that creates, runs, ends and reads an Aura call (`convex/ta/voice.ts`, `convex/ta/voiceExtract.ts`, `convex/lib/screeningCall.ts`, `convex/aiCalls/*`, `convex/integrations/livekitSip*.ts`, the `/api/voice-agent/events` route), the desk surfaces (Call button, Call window, `/voice` practice page, call results), the ElevenLabs legacy code, and the LiveKit deploy files.

Neighbours (not covered here):
- /follow-up: the chase sequence (WhatsApp/email reminders, `FollowUpPanel`, `LiveFollowUp`, `evaluate-follow-up` cron). Aura is one of three buttons there; this skill covers only the hand-off (`updateFollowUpFlags`, `checkAndAdvanceFollowUp`).
- /cv-extraction, /email-intake, /database-search, /excel-tables, /openings, /scoop, /sets-shortlist, /strategy-planner, /workday, /eod-email: unrelated, except that deleting an opening cleans the voice tables (`convex/ta/openingDelete.ts`).
- Outbound safety primitives (`convex/lib/outreachSafety.ts`, `outboundGuard.ts`) belong to the messaging code; this skill only says where voice calls them.

Orientation (read first, it is not what the file names suggest):
- There are **two** call paths. (1) The **browser Call window** (`startWebCall`) is the only path a user can reach today: nobody is dialled, whoever is at the TA's microphone plays the candidate. (2) The **SIP outbound dial** (`dispatchManualVoiceCall`) is built and fail-closed but has **no reachable trigger** (see Known quirks).
- `convex/aiCalls/voiceCalls.ts` is the CV platform's session state machine (consent, `stateVersion`, idempotent answers, watchdog). The browser path reuses only `startVoiceCallSession` and the watchdog; it writes its results through `convex/ta/voice.ts`.
- `src/lib/voice.ts` + `ScreeningPanel` + `repo.startCall` etc. are a **third**, file-store-only desk model (simulation / assisted / live "AiCall" rows, mapped to `taScreeningCalls`). It is not used when `isConvex()` is true.

## How it works now

### Flow 1 - TA presses Call (browser room, the live path)

Trigger: `AuraCallButton` (`src/components/AuraCallButton.tsx`), "Start call" in the pop-up.

1. `startWebCall(applicationId, openingId)` (`src/app/voiceActions.ts`). Refuses unless `isConvex()` ("AI calls need the Convex store."). `primeStore({openingId})`, `getCurrentUser()`, then `can(user, "opening.act", {openingId, assignment, ownerTaId})`; the deny message is returned as-is (e.g. "Another recruiter has claimed this candidate."). No LiveKit env -> "LiveKit is not configured (LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)."
2. Room `ta-call-<uuid>`, identity `ta-<userId>` (<=120 chars). `convexMutation("ta/voice:prepareWebCall", {actorId, applicationId, roomName, participantIdentity})`.
3. `prepareWebCall` (`convex/ta/voice.ts`): `requireActor`; `assertJobAccess(..., WORKS_THE_DESK)` (primary/supporting recruiter or director; admin and ta_manager bypass); `assertNotAnotherTasCandidate` (collision lock). Refuses: application `isActive === false` ("This application is closed."), candidate/job missing, `candidate.doNotContact` ("This candidate has asked not to be contacted.").
4. One call at a time: pending `aiCalls` (`scheduled` or `in_progress`, index `by_application`) younger than `STALE_CALL_MS` = 15 min -> "A call for this candidate is already in progress." Older ones are retired in place (`callStatus: "failed"`, `completedAt`; their `active` session -> `cancelled`, `livekitFailureReason: "Abandoned before the agent finished"`).
5. Inserts `aiCalls` (`triggerType: "manual_ta_trigger"`, `callStatus: "scheduled"`, `callScriptUsed: "initial_screening"`, `companyHidden: false`, `attempts`/`attemptNumber` 1), then `internal.aiCalls.voiceCalls.startVoiceCallSession` with `mode: "live"`, `externalSessionId = roomName`. That creates a `voiceCallSessions` row (`status "active"`, `consentStatus "pending"`, `stateVersion 0`), flips the call to `in_progress` (`calledAt`, `voiceCallSessionId`, room fields, `livekitSipStatus "dialing"`), sets `applications.aiCallStatus = "in_progress"` and `aiCallId`, and writes `pipelineEvents` `voice_call_started` (actorAgent `career141-voice-agent`).
6. Room metadata (the whole brief Aura sees): `agentType "aura-screening"`, `mode`/`sessionMode "live"`, `callSessionId`, `stateVersion`, `aiCallId`, `candidateName`, `jobTitle`, `companyName: "Career141"` (always), `jobDescription = callBrief(job)`, `customQuestions = screeningQuestions(job)`, `detailsToCollect = detailsToCollect(job.title, custom)`.
7. Back in the action: `RoomServiceClient.createRoom({name, metadata, emptyTimeout: 120, maxParticipants: 4})`, then `AgentDispatchClient.createDispatch(roomName, AURA_AGENT_NAME, {metadata})` (name `AURA_AGENT_NAME` or `career141-aura`; the worker joins **only** dispatched rooms). Token: `AccessToken` ttl `20m`, grants roomJoin/canPublish/canSubscribe/canPublishData. Browser URL = `LIVEKIT_BROWSER_URL`, else `LIVEKIT_URL` rewritten http->ws (`127.0.0.1` -> `localhost`). Failure at room/dispatch/token -> `ta/voice:abandonWebCall` and "The call service could not be reached. Try again."
8. Browser (`AuraCallDialog`): phases `idle -> connecting -> waiting -> live -> saving -> ended|error`. Connects a `livekit-client` Room, attaches Aura's audio, enables the mic, listens for `RoomEvent.DataReceived` on topic `aura-transcript` (`{type:"line", who:"agent"|"candidate", text}`) and keeps `heard` (UI shows the last 60). Fallback: `RoomEvent.TranscriptionReceived` is used only while no topic line has arrived (an agent that sends none). `ParticipantConnected` -> `live`.
9. The call ends on End call, on room disconnect (including Aura's cap deleting the room), or when connect fails. `finish(reason)` runs once (guarded by `callId.current`): `completeWebCall({aiCallId, openingId, durationSeconds, lines, reason})`. The action keeps lines with `who` agent|candidate and non-empty text, `slice(0,400)` lines, each text `slice(0,2000)`, calls `ta/voice:completeWebCall`, `revalidatePath(/openings/<id>, "layout")`; the dialog then `router.refresh()`.
10. `completeWebCall` (mutation): `requireActor` + `assertJobAccess`. Call not `scheduled`/`in_progress` -> `{ok:true, answered:false, alreadyEnded:true}`. `answered = candidateSpoke(lines)` (a candidate line with >= 2 alphanumerics). `aiCalls` -> `completed` or `no_answer`, `completedAt`, `callDurationSeconds`, `transcript = transcriptText(lines)` (`"Aura: ..."`/`"Candidate: ..."`, capped 100,000 chars). Session (if still `active`) -> `completed` or `cancelled` (`livekitFailureReason = reason ?? "Nobody answered"`), `finalizedAt`, `durationSeconds`. `applications.aiCallStatus` -> `completed` | `no_answer`. If answered and the call has an application: `scheduler.runAfter(0, internal.ta.voiceExtract.extractCallAnswers, {aiCallId})`.
11. Dialog messages: answered -> "Call saved. The answers are being read into the candidate's record..."; zero lines -> "Aura never joined the call, so nothing was saved. Is the Aura voice agent running?"; otherwise "Nobody answered, so the call is saved as no answer."
12. If the TA closes the tab: nothing runs. `AuraCallDialog` does not call `endWebCall`/`abandonWebCall` (only the unused `WebCallPanel` does), so an `in_progress` call is cleaned by the next `prepareWebCall` (15 min) or the watchdog (Flow 6).

`abandonWebCall` (mutation): call `scheduled`/`in_progress` -> `callStatus "failed"`, session `active` -> `cancelled` ("Abandoned before the agent finished"), `applications.aiCallStatus = "failed"`.

### Flow 2 - What Aura says and does (voice-agent/)

Entry: `voice-agent/src/index.ts` default export `defineAgent({entry})`, started by `cli.runApp(new ServerOptions({agent, agentName: AGENT_NAME, port: AURA_HEALTH_PORT ?? 8082}))`.

- Startup `need()`s `LIVEKIT_URL` (falls back to `NEXT_PUBLIC_LIVEKIT_URL`, http->ws), `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `OPENAI_API_KEY` (throws `[Aura] Missing X`). Loads `../../.env.local`, then `../.env`. No OpenRouter fallback, by design (that account serves only deepseek-v4-flash).
- Per call: `ctx.connect()`, `readBrief(ctx.room.metadata)` (`prompt.ts`, defensive: name <=100, company <=140, title <=160, JD <=1,800, details <=15 x 300 chars; four standard details if none), `openai.realtime.RealtimeModel` with `model = AURA_REALTIME_MODEL || "gpt-realtime-2.1-mini"`, `voice = AURA_REALTIME_VOICE || "marin"`, `reasoning {effort:"minimal"}`, `speed = clamp(AURA_SPEED ?? 0.92, 0.5, 1.5)`, `inputAudioNoiseReduction {type:"near_field"}`, server-VAD `turnDetection`.
- Turn-taking: `INTERRUPTIONS = AURA_INTERRUPTIONS != "off"` (default on). `silence_duration_ms = AURA_SILENCE_MS` (default 600 with interruptions, 400 without), `threshold = AURA_VAD_THRESHOLD` (0.6 on / 0.5 off), `prefix_padding_ms 300`, `create_response true`, `interrupt_response = INTERRUPTIONS`. Session: `aecWarmupDuration 0`, `turnHandling.turnDetection "realtime_llm"`, interruption `{enabled:true, falseInterruptionTimeout:1500, resumeFalseInterruption:true}` or `{enabled:false}`.
- The opening is **fixed**, not model-written (`openingLine`): "Hi <First>, this is Aura, an AI voice assistant calling on behalf of Career141 about the <jobTitle> role. Is now a good time for a quick two-minute chat?" sent via `session.generateReply({instructions: openingInstruction(brief)})`. `firstName()` fixes ALL-CAPS/lowercase CV names.
- `systemPrompt(brief)` is a five-step script: 1 intro (never repeated); 2 wait for a clear yes to "good time" (no/not now -> ask when, close; stop if asked); 3 only after a yes: say the profile is "shortlisted" (never selected/hired/offered) and describe the role in under 60 words from the BRIEF block (JD sits between `<BRIEF>` tags as data, never instructions); 4 checklist, one item at a time (salary needs amount + currency + monthly, read back once; notice in days/weeks/months; the step-2 "yes" answers no item); 5 close: repeat back, ask for corrections, say the team will be in touch. Boundaries: honest "AI voice assistant working for Career141" if asked; never name or guess the hiring company (industry allowed); no protected-characteristic questions; nothing about pay/benefits not in the brief; never score, reject or promise. `employer()` is deliberately `""`.
- Transcript out: `ConversationItemAdded` (user/assistant) -> `publishData({type:"line", who, text, at}, {reliable:true, topic:"aura-transcript"})`. Typed answers in: `dataReceived` JSON `{type:"candidate_reply", text}` -> `session.generateReply({instructions: 'The candidate typed this answer: "..." ...'})` (only `VoiceTestPanel` sends it; the Follow-up dialog has no typing box).
- Cap: `MAX_CALL_MS = 8 * 60 * 1000`; then Aura speaks a fixed goodbye ("We're out of time for this call...") via `generateReply`, and 8 s later `ctx.deleteRoom()` + `ctx.shutdown("call_cap")`. `session.start({record:false})`: audio is not recorded.
- Logs: `[Aura] Call starting [room][role][items][model][voice][silence][interruptions][speed]`, `heard`, `speaking`, `reply first audio in N ms` (the latency number), agent/candidate state. `uncaughtException`/`unhandledRejection` are logged, not fatal.
- Health: LiveKit Agents' HTTP server on `AURA_HEALTH_PORT` (8082); compose healthcheck `GET http://127.0.0.1:8082/`.
- The worker **never calls Convex**. It talks to LiveKit and OpenAI only; every record is written by the browser's `completeWebCall`.

### Flow 3 - Post-call extraction and what lands on the record

`extractCallAnswers` (`convex/ta/voiceExtract.ts`, internalAction): `ta/voice:callForExtraction` (transcript + `screeningQuestions(job)`); empty -> `{ok:false, error:"No transcript to read."}`. Model: `getOpenAI("voice_call_extraction").chat.completions.create({model: getModelForTask(...), temperature: 0})`. `getModelForTask` returns `deepseek/deepseek-v4-flash` for every non-vision task (OpenRouter, 30 s default client timeout; falls back to NVIDIA NIM when no OpenRouter key). `extractionPrompt()` asks for JSON `{interested, currentSalary(+Currency), expectedSalary(+Currency), noticePeriodDays, answers{question->answer}}` from what the candidate said only. `parseJsonObject` strips prose/fences; `normaliseCallAnswers(raw, questions)` clamps (salary 1..100,000,000 rounded; notice 0..365; currency a 3-letter code uppercased; answers only to asked questions, <=500 chars, "null/n/a/unknown/not stated" dropped). Failures are `console.error`'d and returned; no retry and no flag on the call row.

`applyCallAnswers` (mutation): the **call** gets everything heard (`currentSalary`, currency, `expectedSalary`, currency, `noticePeriodDays`, `customQuestionAnswers`). **Candidate: blanks only** (a field is filled only when `undefined`; a TA-checked figure is never replaced). **Application**: opening questions that repeat a standard detail are answered from the figures (`standardAnswers`); `customFollowUpAnswers` by label (existing answers win) and `answers` by question id (`answersById`). Then `updateFollowUpFlags` and `checkAndAdvanceFollowUp(ctx, candidateId)`.

Side effect to remember: `checkAndAdvanceFollowUp` (`convex/pipeline/followUpHelper.ts`) moves every application of that candidate that is in Follow-up (`follow_up`/`ta_shortlist`) with nothing missing by `followUpBlockers` (`ta/stages.ts`: CV, expected salary, notice period, custom questions; current salary not required) to `second_shortlist` through `executeStageTransition` (note "Auto-advanced from Follow-up: all requirements completed."), and reopens one auto-rejected for the 7-day window. A voice call can therefore change a stage. `interested` is extracted but never stored or used.

Question routing (`convex/lib/screeningCall.ts`): `standardFieldOf()` regexes (notice -> `noticePeriodDays`; salary/pay/package/compensation/ctc plus expected-words -> `expectedSalary`, current-words -> `currentSalary`); `allJobQuestions()` merges `followUpQuestions[].label`, `customFollowUpQuestions`, `agent5CustomQuestions` (case-insensitive dedupe); `screeningQuestions()` = the non-standard ones, first 10; `detailsToCollect()` = interest confirm + current + expected + notice + questions, first 15. `callBrief(job)` never names the client: "A client of Career141 [in <industry>]. Do not name or guess the company...", drops JD lines starting Client/Company/Hiring company, replaces the client name with "the client", JD capped at 1,500 chars.

### Flow 4 - Practice line (`/voice`)

`src/app/voice/page.tsx` (force-dynamic) shows `VoiceTestPanel` if `can(user,"voice.practice")`, else the heading plus the deny message. Open openings (`status === "open"`) are offered with `jdMarkdown` (4,000 chars). `startVoiceTest` (`src/app/voiceTestActions.ts`): `primeStore()`, `can(user,"voice.practice")`, requires company + title, JD >= 20 chars, >= 1 detail; clamps (company 140, title 160, JD 4,000, details 15 x 300). Room `aura-<12 hex>`, metadata `mode "simulation"` + `recruiterUserId`; `createRoom` (emptyTimeout 120, departureTimeout 30, maxParticipants 4), dispatch to `AURA_AGENT_NAME` (failure ignored: the CV platform's agent joins every room), token ttl 20m with metadata. **Nothing is written to Convex** (no aiCalls, no sessions). The panel also sends typed replies (`candidate_reply`), shows a clock, and reads both transcript styles (topic lines, or LiveKit transcription).

### Flow 5 - SIP outbound dial (built, unreachable)

Entry `internal.integrations.livekitSip.dispatchManualVoiceCall({aiCallId, kind: "intake"|"follow_up", ...})` (`"use node"`):
1. `getLiveOutboundCallContext` validates trigger type (`manual_ta_trigger`/`followup_retry`), the application/candidate/job relationship, application active, not `doNotContact`, candidate has a phone, call `scheduled`/`in_progress` (or a session exists). Failure -> `markVoiceDialNotPlaced("failed", diagnosticOnly)`.
2. `VOICE_ENGINE` must equal `livekit` (trimmed, case-insensitive). Anything else (unset, `disabled`, legacy) -> `markVoiceDialNotPlaced("suppressed", "Voice engine is disabled or unsupported")`. **Fail closed.**
3. Existing session with participant + SIP ids -> idempotent success; without ids -> refuses ("A prior dial has an unresolved outcome; refusing to redial").
4. Needs `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_SIP_OUTBOUND_TRUNK_ID`.
5. `isOutboundCallTestMode` (`livekitSipPolicy.ts`) is true unless **all** hold: `outreachLive()` (`OUTREACH_LIVE=true`), `CALL_TEST_MODE === "false"`, `OUTREACH_TEST_MODE !== "true"`, `TEST_MODE !== "true"`, settings `testModeEnabled === false`. In test mode the recipient is `CALL_TEST_RECIPIENT ?? TEST_PHONE_NUMBER ?? settings.testPhoneNumber`, valid E.164 (`/^\+[1-9]\d{7,14}$/`) or the call is `suppressed` ("Test mode has no valid E.164 test recipient"); it **never falls back to the candidate's phone**. Live: the candidate phone must be E.164 or the call `failed`.
6. `startVoiceCallSession` with `mode "test"` or `"live"`, external id `livekit:<aiCallId>:<uuid>`; room `voice-<uuid>`, identity `candidate-<uuid>`. Participant metadata: `schemaVersion 1`, `consentStatus` `not_required` (test) / `pending` (live), brief fields (JD 2,000 chars, up to 8 questions x 300), `maxCallDurationSeconds`.
7. `createRoom` (`emptyTimeout 60`, `departureTimeout 10`, `maxParticipants 3`), `phoneAllowed(recipient)` (with `C141_OUTBOUND_LOCK=true` only `C141_OUTBOUND_ALLOW_PHONES`), then `SipClient.createSipParticipant` (`hidePhoneNumber`, `ringingTimeout 25`, `maxCallDuration 300`, `waitUntilAnswered`, `timeout 35`). Reject/timeout -> `failVoiceCallDial`. Success -> `recordLivekitSipParticipant` (ids, `livekitSipStatus "answered"`).
This path never dispatches Aura by agent name (unverified how an agent would join such a room).

### Flow 6 - Session state machine and the signed events bridge

`POST /api/voice-agent/events` (`convex/http.ts`), checks in order: `VOICE_AGENT_SHARED_SECRET` set and >= 32 chars, else 503; `content-length` <= 120,000 else 413 (body length re-checked); headers `x-career141-timestamp` (10-13 digits, within 5 min), `x-career141-nonce` (`^[A-Za-z0-9_-]{16,128}$`), `x-career141-signature` (64 hex), else 401; HMAC-SHA256 over `${timestamp}.${nonce}.${rawBody}` (`verifyVoiceAgentSignature`, `convex/lib/voiceAgentWebhook.ts`) else 401; `claimVoiceAgentNonce` (replay -> 409; TTL 10 min; 100 expired nonces swept per request); `parseVoiceAgentEvent` (exact keys, else 400); mutation errors -> 409. Events: `consent`, `confirmed_answer` (`currentSalary|expectedSalary|noticePeriodDays`; salary needs an uppercase 3-letter currency, notice forbids one), `finalize` (`completed|failed|cancelled`, transcript <= 100,000).

| Mutation (`convex/aiCalls/voiceCalls.ts`) | Rule |
|---|---|
| `recordVoiceConsent` | Only `mode "live"` writes. Idempotent on same key + decision; a different second decision throws. Needs session `active`, `stateVersion === expectedStateVersion`, call `in_progress`. Declined -> session `cancelled`, call `declined`, application `aiCallStatus "declined"`, event `voice_consent_declined`. Bumps `stateVersion`. |
| `commitConfirmedVoiceAnswer` | Idempotency read **before** the version (key = JSON `[sessionId, turnId, field]`); reuse with different data throws. Needs live mode, active, consent `granted`, version match, call `in_progress`, not do-not-contact. Writes `voiceAnswers`, candidate (`lastUpdatedAt`, field, currency; **overwrites**, unlike the browser path), application (`candidateCurrentSalary` etc. + `followUp*` flag), call, bumps version, event `voice_answer_confirmed`. Limits: salary 0..1,000,000,000; notice integer 0..730. |
| `finalizeVoiceCallSession` | Same-status retry idempotent; another status throws. Live `completed` needs consent `granted`. `simulation`/`test` finalize touches only the session (+ test call status). Live: call status/duration/transcript, application `aiCallStatus`, event `voice_call_finalized`. `durationSeconds` 0..300. |
| `failVoiceCallDial`, `markVoiceDialNotPlaced` | Close a prepared session/call when a dial fails or is suppressed; live refuses after the candidate interacted (`stateVersion !== 0`). |
| `failStaleVoiceCallSessions` | Cron `fail-stale-voice-sessions`, every **23 min**, no env gate. `by_status_startedAt` active sessions older than `STALE_SESSION_AGE_MS` = **10 min**, 50 per run: session `failed` (+1 version, duration capped at 300 s), call `failed` if still `scheduled`/`in_progress`; live mode also sets application `aiCallStatus "failed"` + event `voice_call_watchdog_failed`. |

Session modes (`voiceSessionPolicy.ts`): only `live` may write candidate/application/pipeline/outcome (`productionWritePolicy`). The browser path creates its session as `mode "live"` and consent never leaves `pending`.

### Flow 7 - ElevenLabs legacy

`convex/integrations/elevenlabs.ts`: `triggerIntakeCall`, `triggerFollowUpCall` (internalActions; `ELEVENLABS_API_KEY`, `ELEVENLABS_INTAKE_AGENT_ID`, `ELEVENLABS_FOLLOWUP_AGENT_ID`, `ELEVENLABS_SIP_PHONE_NUMBER_ID`). They apply `doNotContactRefusal`, `!outreachLive()` -> test mode, `CALL_TEST_RECIPIENT`, `phoneAllowed`. **No code calls either.** Webhooks in `convex/http.ts`: `/api/elevenlabs/save-intake`, `/mark-declined`, `/post-call-webhook`, each via `verifyElevenLabsSecret` (`ELEVENLABS_WEBHOOK_SECRET`, header `x-elevenlabs-signature`, fails closed when unset since 2 Oct). `aiCalls.elevenlabsConversationId/AgentId` and index `by_elevenlabs` remain. The Day-2 AI call in the follow-up cron is intentionally silent.

## UI surface

| Where | Control | Calls | Who |
|---|---|---|---|
| Follow-up row (`CandidateRow.tsx`, compact) and `LiveFollowUp.tsx`, both through `FollowUpActions` | "Call" / "Call with Aura" (`AuraCallButton`) | `startWebCall`, `completeWebCall` | Not `locked` (no `opening.act`), stage `ta_follow_up`/`ai_follow_up`/`follow_up`, `isConvex()` |
| Candidate page `/openings/[id]/candidate/[appId]`, tab `call` (label "Call Log") | Card "Screening call with Aura" + `AuraCallButton`; `WebCallResults` ("AI call results": up to 5 calls, status, consent, duration, three figures, `endedReason`, transcript <= 4,000 chars via `ta/voice:callsFor`); then `CallLogForm` + `CallLog` (manual call logs) | same | Card needs `!locked`; results gated by `assertJobAccess` |
| `/voice` (nav "Voice agent", mobile "Voice") | `VoiceTestPanel`: pick opening or type role, Start, mute, typed reply, end | `startVoiceTest` | `voice.practice` |
| File store only (`!isConvex()`) | `ScreeningPanel`, `FollowUpPanel mode="call"`, actions `startCall`/`recordConsent`/`recordCallAnswer`/`finishCall` in `src/app/actions.ts` | `repo.*` in `src/data/store.ts` | `opening.act` |
| Unused | `WebCallPanel.tsx` (the only caller of `endWebCall`) | | |

Tab count: `call` = `repo.calls(app.id).length` + outreach rows with channel `ai_call` (candidate `page.tsx`). `src/app/api/recording/route.ts` is **not** a call recorder: it stores and transcribes a TA's spoken opening brief (`ta/storage:recordingUploadUrl`, `transcribeAudio` in `src/lib/transcribe.ts`, `C141_TRANSCRIBE_MODEL` default `gpt-4o-transcribe`, 40 MB upload / 25 MB transcription caps, needs `opening.create`). Aura calls are never recorded (`record:false`; `aiCalls.recordingUrl` unused).

## Data

| Table | Use | Indexes used |
|---|---|---|
| `aiCalls` | One call. `callStatus`: scheduled, in_progress, completed, no_answer, failed, declined. `triggerType`: manual_ta_trigger (browser), followup_retry, automatic_*. Figures, `customQuestionAnswers`, `transcript`, `callDurationSeconds`, LiveKit ids, `livekitSipStatus` (dialing/answered/completed/failed/suppressed), `isTestCall`, `voiceCallSessionId`, legacy twilio/elevenlabs ids | `by_application`, `by_candidate`, `by_job` |
| `voiceCallSessions` | `mode` simulation/test/live, `status` active/completed/failed/cancelled, `consentStatus` not_required/pending/granted/declined, `stateVersion`, LiveKit ids, `livekitFailureReason`, `startedAt/finalizedAt/durationSeconds` | `by_externalSessionId`, `by_aiCallId`, `by_status_startedAt`, `by_application_startedAt` |
| `voiceAnswers` | One row per confirmed field, `idempotencyKey`, expected/committed version | `by_idempotencyKey`, `by_application_committedAt` |
| `voiceAgentNonces` | Replay protection, `expiresAt` | `by_nonce`, `by_expiresAt` |
| `voiceSimulationReservations` | Quota rows (2 active/user, 10 active global, 10/hour/user, TTL 10 min); no caller creates them | `by_sessionId`, `by_user_*`, `by_status_expiresAt`, `by_jobId` |
| `taScreeningCalls` | File-store desk calls (mode, status, consent text, answers, conflicts); model mapping `aiCalls: identity("taScreeningCalls", [...])` in `convex/ta/model/tables.ts` | `by_application` |
| `applications` | `aiCallStatus`, `aiCallId`, `followUpCurrentSalary/ExpectedSalary/NoticePeriod`, `candidateCurrentSalary` etc. (bridge path), `customFollowUpAnswers`, `answers` | |
| `candidates` | `currentSalary(+Currency)`, `expectedSalary(+Currency)`, `noticePeriodDays`, `doNotContact` | |
| `pipelineEvents` | `voice_call_started`, `voice_consent_*`, `voice_answer_confirmed`, `voice_call_finalized`, `voice_dial_not_placed`, `voice_dial_failed`, `voice_call_watchdog_failed` (the browser path writes only `voice_call_started`) | |

`convex/ta/openingDelete.ts` removes `aiCalls`, `voiceCallSessions`, `voiceAnswers`, `taScreeningCalls`, `voiceSimulationReservations` with the opening. `convex/integrations/partnerRead.ts` lists the voice tables as readable by the partner read tool.

## Backend wiring

- Every Convex function is `internal*` (2 Oct, `e5d6225`); the Next server calls them with the admin key (`convexMutation("ta/voice:...")`). The only external HTTP entry is the events route.
- `convex/ta/voice.ts`: `prepareWebCall`, `callsFor`, `abandonWebCall`, `completeWebCall`, `callForExtraction`, `applyCallAnswers`. `convex/ta/voiceExtract.ts`: `extractCallAnswers`.
- `convex/aiCalls/voiceCalls.ts`: `claimVoiceAgentNonce`, `recordVoiceCallSession` (no-write simulation stub), `getVoiceSimulationContext`, `getCandidateVoiceCalls`, `reserveVoiceSimulationSession`, `releaseVoiceSimulationReservation`, `getLiveOutboundCallContext`, `startVoiceCallSession`, `recordVoiceConsent`, `recordLivekitSipParticipant`, `markVoiceDialNotPlaced`, `failVoiceCallDial`, `failStaleVoiceCallSessions`, `commitConfirmedVoiceAnswer`, `finalizeVoiceCallSession`. Nothing calls the simulation/reservation functions, `recordVoiceCallSession`, `getCandidateVoiceCalls`, or `convex/aiCalls/voiceEngine.ts` (`generateVoicePrescreeningReply`, an old "Sarah"/LKR text agent).
- `voiceCallGuards.ts` `assertNoPendingVoiceCall` guards `applications.triggerManualAiCall`/`triggerAiCall`, which schedule the SIP dispatcher; `convex/ta/dispatch.ts` `startVoiceCall` calls `triggerManualAiCall` and has no UI caller.
- Cron: `fail-stale-voice-sessions` (23 min). `evaluate-follow-up` (7 min) holds a dead `triggerAiCall` branch (always `false`; its `MAX_CALLS_PER_RUN = 20` and `isWithinCallingHours` are unreachable).
- Calling-hours rule (only in that dead branch, `convex/crons.ts`): local hour 9 <= h < 20 from a fixed UTC offset by phone prefix (+44/07 0, +971 +4, +94 +5.5, +65 +8, +1 -5, +61 +10; any other prefix offset 0; no phone = allowed). The SIP dispatcher itself has **no** calling-hours check.
- Env (names only). Convex: `VOICE_ENGINE`, `VOICE_AGENT_SHARED_SECRET`, `CALL_TEST_MODE`, `CALL_TEST_RECIPIENT`, `TEST_PHONE_NUMBER`, `OUTREACH_TEST_MODE`, `TEST_MODE`, `OUTREACH_LIVE`, `C141_OUTBOUND_LOCK`, `C141_OUTBOUND_ALLOW_PHONES`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_SIP_OUTBOUND_TRUNK_ID`, `LIVEKIT_INTERNAL_URL`, `NEXT_PUBLIC_LIVEKIT_URL`, `ELEVENLABS_*`, OpenRouter keys. Next: `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_BROWSER_URL`, `AURA_AGENT_NAME`, `OPENAI_API_KEY` + `C141_TRANSCRIBE_MODEL` (briefs only), `C141_VOICE_LIVE` (read only by `liveCallsEnabled()` in `src/lib/voice.ts`, the file-store "live" mode; not a switch for the Convex path). Worker: Flow 2 plus `AURA_HEALTH_PORT`.
- What actually stops Aura: stop the worker (no agent joins; dialog says "Aura never joined"), unset the LiveKit env (action refuses), or `opening.act` denial. There is no server-side "voice off" flag for the browser path.
- Providers: LiveKit (self-hosted, SIP), OpenAI Realtime (the call), OpenRouter DeepSeek (extraction), OpenAI transcription (briefs only), ElevenLabs (legacy, uncalled).

## Access and roles

- Browser call: client-side `can(user, "opening.act", {openingId, assignment, ownerTaId})` (`src/lib/auth.ts`: desk-wide roles pass; others need an assignment that is not `client_contact`; a TA is refused when `ownerTaId` is someone else, the collision lock); the backend repeats it with `assertJobAccess(..., WORKS_THE_DESK)` + `assertNotAnotherTasCandidate`. Buttons are hidden when `locked`.
- `voice.practice` (`src/lib/auth.ts`): denies `isTa` (roles `ta`, `ta_support`) with "The voice agent practice line is not available on a Talent Acquisition account." (2 Oct, `1306b28`); everyone else passes, so a `client` seat sees the nav link (probably unintended, per the skill references; verify). `startVoiceTest` re-checks; nav filters in `TopNav.tsx`, mobile in `src/lib/mobile/navigation.ts`.
- Results (`callsFor`): `assertJobAccess` WORKS_THE_DESK.
- Workday gate: none found in this feature (unverified beyond `prepareWebCall`, which has no workday check).
- Events route: no user identity, HMAC secret only. Backend functions never trust a client-supplied mode, application id or phone (the dial context is rebuilt from `aiCallId`).

## Invariants and safety

- **The browser path rings no one.** Do not add a dial to `startWebCall`.
- **Real dials need every switch** (`376c8a2`, 15 Sep outbound lock; `3e7f73c`, 2 Oct, "real voice calls also need OUTREACH_LIVE=true" after `CALL_TEST_MODE=false` plus a DB setting alone could ring real candidates): `VOICE_ENGINE=livekit`, `OUTREACH_LIVE=true`, `CALL_TEST_MODE=false`, no test flags, `testModeEnabled=false`, E.164, `phoneAllowed`. Test mode never dials the candidate. Never set `OUTREACH_LIVE` in code or config. Keep `livekitSipPolicy.test.ts` green.
- `VOICE_ENGINE` unset/unknown -> suppressed, never a provider call. Never redial an uncertain session.
- Do-not-contact is checked in `prepareWebCall`, `getLiveOutboundCallContext`, consent, answer commit and ElevenLabs; keep all of them.
- Aura says it is an AI and never names the client (`4b7a1c9` 24 Sep; `afdc997` 21 Sep; `e608b67` 18 Sep). The fixed opening and `callBrief` both enforce it; change together and rerun `tests/screeningcall.test.ts`.
- Transcript extraction fills **blanks only**; never overwrite a TA-checked figure.
- Idempotency is read before the `stateVersion` check, so an ack-loss retry gets the first success. Transcript <= 100,000 chars; event body <= 120,000.
- Webhook secret >= 32 chars; timestamp window 5 min; nonces single-use (TTL 10 min).
- Non-live sessions never write candidate/application/pipeline fields (`productionWritePolicy`).
- One call per application (15-min stale rule in `prepareWebCall`; `assertNoPendingVoiceCall` in the SIP triggers).
- ElevenLabs webhooks verify the signature and fail closed (2 Oct: they were open, anyone could write salary or mark do-not-contact by id).
- Colombo-day rules: none apply here.

## Known quirks, gaps and unverified items

- **The worker never posts to `/api/voice-agent/events`** and nothing in this repo signs such a request. The bridge (consent, confirmed_answer, finalize) is idle: browser calls leave `consentStatus "pending"` and `voiceAnswers` empty, so `WebCallResults` rarely shows "consent ...". Commit `637a766` (15 Sep) describes the bridge as the answer path; the code moved to transcript extraction in `4d63446` (16 Sep). Consent is the spoken "good time" yes only; no consent text is stored on this path.
- The SIP path is reachable only via `triggerManualAiCall`/`triggerAiCall` (`convex/applications/applications.ts`) <- `ta/dispatch:startVoiceCall`, which no screen calls; the cron's `triggerAiCall` is hard-coded `false` ("AI voice call suspended"). The dispatcher does not dispatch Aura by agent name (unverified how an agent would join), has no calling-hours check, and `startVoiceCall`'s `kind` argument is ignored.
- Duration limits disagree: Aura cap 8 min; `finalizeVoiceCallSession` and SIP max 5 min (`MAX_CALL_DURATION_SECONDS`); watchdog 10 min; stale-call retire 15 min; cron every 23 min. A >5 min call finalized through the bridge would be rejected; the browser path has no such cap.
- `interested` is extracted and discarded; no "not interested" reaction exists.
- Extraction failure leaves a `completed` call with no figures, no retry and no visible error (a Convex log line only).
- `completeWebCall` trusts the browser's lines (a TA could post any transcript).
- Typed replies work only in the practice panel. Closing the Follow-up dialog tab does not abandon the call (relies on the 15-min retire or the watchdog).
- Legacy or unreferenced: `WebCallPanel`, `endWebCall`, `recordVoiceCallSession`, simulation reservation functions, `getCandidateVoiceCalls`, `voiceEngine.ts`; grep callers before deleting.
- `prompt.ts` header cites `tests/auraprompt.test.ts`, which does not exist; prompt tests live in `tests/screeningcall.test.ts`. The worker accepts a 1,800-char JD while `callBrief` sends <= 1,500. The prompt promises a "two-minute chat" but a call can run to 8 minutes.
- Tests under `convex/**/__tests__` (`voiceAgentWebhook`, `voiceSessionPolicy`, `livekitSipPolicy`) are **not** run by `npm test` (`tests/run.mjs` runs only `tests/*.test.ts`); run them by hand (check the file header for the runner).
- Deploy: `docs/TEAM-WORKFLOW.md` says Voice is "changed by a release", but neither `.github/workflows/deploy-production.yml` nor `deploy-staging.yml` mentions voice and `deploy/production/docker-compose.yml` has no voice service. LiveKit and the agent are defined only in `deploy/staging/docker-compose.yml` (`ta-staging-livekit`, `ta-staging-voice-agent`, `ta-staging-voice-redis`, network `ta-staging-voice`, `docs/STAGING.md`); production's app joins that network and sets `LIVEKIT_URL: http://livekit:7880` (how that hostname resolves to staging's container is unverified in the repo). The agent is built and started by hand on the server; that needs the owner's explicit go-ahead.
- Staging compose passes `AURA_REALTIME_MODEL/VOICE/SILENCE_MS/VAD_THRESHOLD/AGENT_NAME/HEALTH_PORT` but not `AURA_SPEED` or `AURA_INTERRUPTIONS`; add them there to use them.

## How to change it safely

Where to edit:
- Call wording/steps: `voice-agent/src/prompt.ts` (`openingLine`, `systemPrompt`); update `tests/screeningcall.test.ts` (the opening is asserted word for word).
- Turn-taking/model/voice: `voice-agent/src/index.ts` constants and the `AURA_*` envs; update `voice-agent/README.md`, `docs/STAGING.md` and the compose env pass-through together. Measure with `reply first audio in N ms`. Read the comment above `INTERRUPTIONS` first: semantic VAD, local Silero VAD and interruptions-off were each tried and reverted (24 Sep, 2 Oct).
- What is collected: `detailsToCollect`/`screeningQuestions`/`standardFieldOf` in `convex/lib/screeningCall.ts`. A new field also needs `extractionPrompt`, `normaliseCallAnswers`, `CallAnswers`, the `applyCallAnswers` validator, `aiCalls` in `convex/schema.ts`, `callsFor`, `WebCallResults`, and the `taScreeningCalls` mapping in `convex/ta/model/tables.ts` if it is a file-store concept.
- Brief content: `callBrief` (keep client-name removal) and the `prepareWebCall` metadata; the worker's `readBrief` must accept any new key.
- Call lifecycle/UI: `AuraCallButton.tsx`, `voiceActions.ts`, `convex/ta/voice.ts`; keep `completeWebCall` idempotent.
- Dial path: `livekitSip.ts`, `livekitSipPolicy.ts` (extend `livekitSipPolicy.test.ts`); never read the candidate's phone in test mode.
- Bridge/state machine: `convex/lib/voiceAgentWebhook.ts` (+test), `voiceCalls.ts`, the http route. To connect the worker to the bridge, sign `timestamp.nonce.body` with `VOICE_AGENT_SHARED_SECRET` and stop the browser path double-writing.
- New table/index: `convex/schema.ts`, `convex/ta/openingDelete.ts`, `convex/integrations/partnerRead.ts`.

Tests and commands:
- `npm test` (runs `tests/*.test.ts`; voice ones: `tests/screeningcall.test.ts`, `tests/voice.test.ts`); `npx tsc --noEmit -p .`; `npx tsc --noEmit -p convex`; worker: `cd voice-agent && npm run typecheck` (separate package; `npm run dev` runs it locally against `.env.local`).
- Run the three `convex/**/__tests__` voice tests by hand.
- Run the app locally with `deploy/local/start-app.sh` (local backend, never a live address). End-to-end voice needs a local LiveKit and an OpenAI key; otherwise verify metadata and dialog states only.

Pre-merge checklist:
1. The browser path still dials no one; the SIP path still fails closed with `VOICE_ENGINE` unset.
2. Opening line says "AI"; brief and prompt never name the client; role is described only after the yes.
3. Candidate fields still blank-fill only; the `checkAndAdvanceFollowUp` stage side effect is considered.
4. New Convex functions are `internal*`; no secrets in code or docs.
5. Both `tsc` runs and `npm test` pass; this skill, `voice-agent/README.md` and `docs/STAGING.md` updated.

Repo hard rules that apply: never touch the live backend or VPS from a laptop (no `convex deploy/run/env set`, no starting or restarting the voice containers); all outbound goes through `convex/lib/outreachSafety.ts` and `outboundGuard.ts`; data changes are `dryRun` migrations run by the pipeline; work on a `<person>/<topic>` branch and merge by PR. Anything that changes what the candidate hears (prompt, opening, closing, questions) or what a TA sees recorded must be flagged to the owner to decide.

## History

- 2026-09-15 `637a766` Hold the AI screening call in a browser room (no SIP trunk): `ta/voice:prepareWebCall`, room and token minted by the Next server, results on the candidate's Call tab. `376c8a2` outbound lock (`C141_OUTBOUND_LOCK`) added to LiveKit SIP and ElevenLabs calls; dispatch calls require a desk user on the opening.
- 2026-09-16 `4d63446` Call / WhatsApp / Email per Follow-up candidate; Aura worker (LiveKit Agents) asks salary, expected, notice and the opening's questions; transcript read into the record (`voiceExtract`, `applyCallAnswers`); job questions repeating a standard detail are asked once.
- 2026-09-17 `e9dfe8e` "Voice agent" practice page (/voice): talk to Aura as the candidate, nothing saved. `f131740` prompt file made plain text in git.
- 2026-09-18 `e78fade` staging gets its own LiveKit + Redis + agent stack on separate ports and network (the practice page had borrowed production's server: connection loop, nobody spoke). `d73a06a` start-call action loads the desk roster (it returned 500). `e608b67` "answer in a second, not seventeen" (a 17 Sep call greeted at +33 s): CV platform turn settings, typed-answer handler, crash guards, OpenRouter fallback removed, "calling from Career141". `df59bcb` zod pinned 4.4.3. `77762ca` preemptive generation (merged `299ab9c`).
- 2026-09-21 `afdc997` Aura never names the hiring company; shorter reply waits; brief capped at 1,500 chars; timings via `AURA_*` envs.
- 2026-09-24 `ec13351` OpenAI Realtime `gpt-realtime-2.1-mini`, Deepgram dropped. `315c45b` server VAD instead of semantic (the wait was the pause), reply timing logged. `9657918` ask "good time", describe role, then questions. `4b7a1c9` fixed opening that says "AI" (a test call invented its own opening, named the client, took "good time" as the go-ahead for salary). `f30bb47` local Silero VAD to stop half-sentences; `d4b4b04` back to server VAD with interruptions off (Silero was slow on raw audio).
- 2026-10-02 `1306b28` `voice.practice` capability, TA seats lose the practice line. `3e7f73c` real voice calls also need `OUTREACH_LIVE=true`. `e5d6225` backend closed: public functions internal, ElevenLabs webhooks signed, `/api/twilio-callback` and `/api/r2-file` removed. `ba3902f` candidates can talk over Aura again (`AURA_INTERRUPTIONS`, speed 0.92, wait 600 ms, threshold 0.6, acknowledgements).
- 2026-10-05 `cd3cd8d` desk works on phone/tablet (mobile "Voice" tab). 2026-10-20 `c0a68c7` friendly error recovery touched the call panels.

<!-- skill-meta
verified-commit: cfe63488
verified-hash: 417f9c839915c5e768b2addad6ccc5d0e9c400cf
verified-date: 2026-10-30
sources:
  voice-agent/src/index.ts
  voice-agent/src/prompt.ts
  voice-agent/README.md
  voice-agent/Dockerfile
  convex/ta/voice.ts
  convex/ta/voiceExtract.ts
  convex/lib/screeningCall.ts
  convex/lib/voiceAgentWebhook.ts
  convex/aiCalls/**
  convex/integrations/livekitSip.ts
  convex/integrations/livekitSipPolicy.ts
  convex/integrations/elevenlabs.ts
  convex/http.ts
  convex/crons.ts
  convex/ta/model/tables.ts
  convex/ta/dispatch.ts
  convex/pipeline/followUpHelper.ts
  src/app/voiceActions.ts
  src/app/voiceTestActions.ts
  src/app/voice/page.tsx
  src/app/api/recording/route.ts
  src/lib/transcribe.ts
  src/lib/voice.ts
  src/lib/auth.ts
  src/components/AuraCallButton.tsx
  src/components/FollowUpActions.tsx
  src/components/WebCallResults.tsx
  src/components/voice/VoiceTestPanel.tsx
  tests/screeningcall.test.ts
  tests/voice.test.ts
  convex/integrations/__tests__/livekitSipPolicy.test.ts
  convex/lib/__tests__/voiceAgentWebhook.test.ts
  deploy/staging/docker-compose.yml
  deploy/staging/livekit.yaml
  deploy/production/docker-compose.yml
  docs/STAGING.md
-->
