export type VoiceSessionMode = "simulation" | "test" | "live";

/** Only a production live session may write candidate/application answers. */
export function isProductionVoiceMode(mode: VoiceSessionMode) {
  return mode === "live";
}

export function productionWritePolicy(mode: VoiceSessionMode) {
  const allowed = isProductionVoiceMode(mode);
  return {
    candidateFields: allowed,
    applicationFields: allowed,
    pipelineEvents: allowed,
    productionAiCallOutcome: allowed,
  } as const;
}
