# Aura — the TA System's screening call agent

A LiveKit Agents worker, modelled on the CV pipeline's Aura agent. When a TA
presses **Call** on a candidate in Follow-up, the TA System creates a call room,
dispatches this agent into it (agent name `career141-aura`, or `AURA_AGENT_NAME`)
and opens the call in a pop-up. Aura says hi, says it is calling from Career141
about the role, and asks current salary, expected salary, notice period and the
opening's own questions. Each line goes to the pop-up; when the call ends the
transcript is sent back and the answers are read into the candidate's record
(`convex/ta/voice.ts`, `convex/ta/voiceExtract.ts`).

## Run locally

It reads the TA System's `.env.local`: `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET` and `OPENAI_API_KEY`. The whole call — hearing, thinking
and speaking — runs on one OpenAI Realtime model; there is no Deepgram key.

Optional: `AURA_REALTIME_MODEL` (default `gpt-realtime-2.1-mini`) and
`AURA_REALTIME_VOICE` (default `marin`; also `cedar`, `alloy`, `coral`, `sage`,
`verse`…).

Turn-taking runs on OpenAI's server VAD, and nothing cuts Aura off mid-sentence.
`AURA_SILENCE_MS` (default 400) is how long after the candidate stops that Aura
answers; raise it if she talks over people who pause. `AURA_VAD_THRESHOLD`
(default 0.5) — raise it if room noise starts turns. Each reply logs
`[Aura] reply first audio in … ms`.

```bash
cd voice-agent && npm install && npm run dev
```

It logs `registered worker … agentName: "career141-aura"` when ready.

## Deploy

`Dockerfile` builds the worker (`node dist/index.js start`). It needs the same
variables, pointed at the LiveKit server the TA System's `LIVEKIT_URL` uses.
