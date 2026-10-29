"use node";

import OpenAI from "openai";
import type { ActionCtx } from "../_generated/server";
import { isCompleteJson, hasCvDetailsJson } from "./jsonAnswer";


export type TaskType = 
  | "cv_structuring" 
  | "cv_criteria_match"
  | "criteria_expansion"
  | "cv_scoring" 
  | "reverse_matching" 
  | "search_ranking" 
  | "jd_extraction" 
  | "email_routing" 
  | "email_auto_reply" 
  | "cv_vision_ocr" 
  | "embedding"
  | "jd_matching"
  | "cv_location_resolution";

export const IS_CV_EXTRACTION_TASK = (taskType: string): boolean => {
  return (
    taskType === "cv_structuring" ||
    taskType === "cv_criteria_match" ||
    taskType === "cv_scoring" ||
    taskType === "reverse_matching" ||
    taskType === "email_routing" ||
    taskType === "email_auto_reply" ||
    taskType === "jd_matching" ||
    taskType === "jd_extraction" ||
    taskType === "cv_location_resolution"
  );
};

export const OPENROUTER_CV_EXTRACTION_MODEL = "deepseek/deepseek-v4-flash";
export const OPENROUTER_PRIMARY_MODEL = OPENROUTER_CV_EXTRACTION_MODEL;
export const OPENROUTER_VISION_MODEL = "anthropic/claude-haiku-4.5";
export const OPENROUTER_SCANNED_CV_MODEL = OPENROUTER_VISION_MODEL;
export const OPENROUTER_FALLBACK_MODELS = [OPENROUTER_CV_EXTRACTION_MODEL];
export const OPENROUTER_CV_FALLBACK_MODELS = [OPENROUTER_CV_EXTRACTION_MODEL];
export const OPENROUTER_VISION_FALLBACK_MODELS = [
  OPENROUTER_VISION_MODEL,
];
export const NVIDIA_PRIMARY_MODEL = "meta/llama-3.3-70b-instruct";
export const NVIDIA_FALLBACK_MODEL = "meta/llama-3.3-70b-instruct";

export function getModelForTask(taskType: TaskType | string): string {
  if (taskType === "cv_vision_ocr") {
    return OPENROUTER_VISION_MODEL;
  }
  return OPENROUTER_CV_EXTRACTION_MODEL;
}

let openRouterKeyIndex = 0;

export function getOpenAI(_taskType?: TaskType | string, timeoutMs = 30000): OpenAI {
  // Collect all available OpenRouter API keys from environment variables for round-robin rotation
  const keysFromEnv = [
    process.env.OPENROUTER_API_KEY,
    process.env.OPENROUTER_API_KEY_1,
    process.env.OPENROUTER_API_KEY_2,
    process.env.OPENROUTER_API_KEY_3,
    process.env.OPENROUTER_API_KEY_4,
    process.env.OPENROUTER_API_KEYS, // Comma-separated list option
  ]
    .filter(Boolean)
    .flatMap((val) => (val ? val.split(",") : []))
    .map((k) => k.trim())
    .filter((k) => k.length > 10);

  if (keysFromEnv.length === 0) {
    console.warn("[getOpenAI] OPENROUTER_API_KEY is not set in environment variables, falling back to NVIDIA NIM API");
    return getNvidiaOpenAI();
  }

  // Select key using round-robin index
  const apiKey = keysFromEnv[openRouterKeyIndex++ % keysFromEnv.length];

  return new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
    timeout: timeoutMs,
    maxRetries: 0,
  });
}

export function getNvidiaOpenAI(): OpenAI {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    throw new Error("NVIDIA_API_KEY is not set");
  }

  return new OpenAI({
    baseURL: "https://integrate.api.nvidia.com/v1",
    apiKey,
    timeout: 30000,
    maxRetries: 0,
  });
}

import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { embedText } from "../matching/agent2";

export async function logLLMUsage(
  _ctx: ActionCtx,
  _taskType: string,
  _model: string,
  _inputTokens: number,
  _outputTokens: number,
  _success: boolean,
  _error?: string,
  _cvUploadId?: Id<"cvUploads">,
  _provider?: string,
  _sourceChannel?: string
): Promise<void> {
  // Token database tracking disabled for maximum throughput and zero DB overhead
  return;
}

export async function generateNvidiaEmbedding(
  ctx: ActionCtx,
  text: string,
  cvUploadId?: Id<"cvUploads">
): Promise<number[] | undefined> {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  // Safety truncate to avoid token limits
  const safeText = trimmed.slice(0, 15000);

  const maxRetries = 3;
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { embedding, usage } = await embedText(safeText, "passage");

      // Log successful call
      await logLLMUsage(
        ctx,
        "embedding",
        usage.model,
        usage.promptTokens,
        0,
        true,
        undefined,
        cvUploadId
      );

      return embedding;
    } catch (error: any) {
      lastError = error;
      const errorMessage = error?.message || String(error);
      
      // Log failed call attempt
      await logLLMUsage(
        ctx,
        "embedding",
        "nvidia/llama-3.2-nv-embedqa-1b-v2",
        0,
        0,
        false,
        errorMessage,
        cvUploadId
      );

      if (attempt < maxRetries) {
        const waitMs = Math.pow(2, attempt) * 1000;
        console.warn(`[Embedding] NVIDIA API error (attempt ${attempt}/${maxRetries}), retrying in ${waitMs}ms...`, errorMessage);
        await new Promise(resolve => setTimeout(resolve, waitMs));
      } else {
        break;
      }
    }
  }

  console.error("Embedding generation error:", lastError);
  return undefined;
}

export const NVIDIA_VISION_MODELS = [
  "meta/llama-3.2-11b-vision-instruct",
];

// Send the whole PDF so vector and font-encoded pages reach the reader too.
export async function callHaikuVisionOCR(
  file: { kind: "pdf" | "image"; mime: string; base64: string },
): Promise<string> {
  try {
    // getOpenAI otherwise silently falls back to NVIDIA, which cannot serve Haiku.
    if (![process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEY_1, process.env.OPENROUTER_API_KEY_2, process.env.OPENROUTER_API_KEY_3, process.env.OPENROUTER_API_KEY_4, process.env.OPENROUTER_API_KEYS].some(Boolean)) return "";
    const dataUrl = `data:${file.mime};base64,${file.base64}`;
    const content: any[] = [
      { type: "text", text: "Transcribe all visible text from every page accurately and verbatim in reading order. Return only the document text, with no commentary or markdown. Do not guess unclear text." },
      file.kind === "pdf"
        ? { type: "file", file: { filename: "cv.pdf", file_data: dataUrl } }
        : { type: "image_url", image_url: { url: dataUrl } },
    ];
    const response = await getOpenAI("cv_vision_ocr", 55_000).chat.completions.create({
      model: OPENROUTER_VISION_MODEL, messages: [{ role: "user", content }], temperature: 0.1, max_tokens: 4096,
    });
    if (response.choices[0]?.finish_reason === "length") return "";
    return response.choices[0]?.message?.content?.trim() || "";
  } catch (err: any) {
    console.warn("[callHaikuVisionOCR] Vision OCR failed:", err?.message || String(err));
    return "";
  }
}

export async function callNvidiaVisionOCR(
  ctx: ActionCtx,
  imageBase64DataUrls: string[],
  cvUploadId?: Id<"cvUploads">
): Promise<string> {
  if (!imageBase64DataUrls || imageBase64DataUrls.length === 0) {
    throw new Error("No image content provided for Vision OCR");
  }

  const contentItems: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
    {
      type: "text",
      text: "Transcribe all visible text from the provided document image(s) accurately, completely, and verbatim in top-to-bottom reading order. Return ONLY the extracted document text with no markdown wrapper, no conversational preambles, and no explanation.",
    },
  ];

  for (const imageUrl of imageBase64DataUrls) {
    contentItems.push({
      type: "image_url",
      image_url: { url: imageUrl },
    });
  }

  let lastError = "";

  // 1. Try NVIDIA NIM API first (Free & No OpenRouter Privacy Limits)
  try {
    const nvidiaOpenAI = getNvidiaOpenAI();
    for (const model of NVIDIA_VISION_MODELS) {
      try {
        console.log(`[callNvidiaVisionOCR] Invoking NVIDIA NIM Vision OCR model: ${model}`);
        const response = await nvidiaOpenAI.chat.completions.create({
          model,
          messages: [
            {
              role: "user",
              content: contentItems as any,
            },
          ],
          temperature: 0.1,
          max_tokens: 4096,
        });

        if (response.usage) {
          await logLLMUsage(
            ctx,
            "cv_vision_ocr",
            model,
            response.usage.prompt_tokens,
            response.usage.completion_tokens,
            true,
            undefined,
            cvUploadId,
            "nvidia"
          );
        }

        const extractedText = response.choices[0]?.message?.content?.trim() || "";
        if (extractedText && extractedText.length > 10) {
          console.log(`[callNvidiaVisionOCR] Successfully extracted ${extractedText.length} chars using NVIDIA ${model}`);
          return extractedText;
        }
      } catch (err: any) {
        lastError = err?.message || String(err);
        console.warn(`[callNvidiaVisionOCR] NVIDIA Vision OCR failed with model ${model}: ${lastError}`);
      }
    }
  } catch (err: any) {
    console.warn("[callNvidiaVisionOCR] Failed to initialize NVIDIA client:", err);
  }

  await logLLMUsage(
    ctx,
    "cv_vision_ocr",
    NVIDIA_VISION_MODELS[0],
    0,
    0,
    false,
    lastError,
    cvUploadId,
    "nvidia"
  );

  throw new Error(`Vision OCR failed to extract text from candidate document: ${lastError}`);
}

export interface LLMCompletionOptions {
  messages: Array<OpenAI.Chat.Completions.ChatCompletionMessageParam>;
  temperature?: number;
  max_tokens?: number;
  response_format?: { type: "json_object" | "text" };
  cvUploadId?: Id<"cvUploads">;
  sourceChannel?: string;
}

export async function executeLLMWithNvidiaFallback(
  ctx: ActionCtx,
  taskType: TaskType | string,
  options: LLMCompletionOptions
): Promise<{ content: string; provider: "openrouter" | "nvidia"; model: string; primaryError?: string }> {
  if (IS_CV_EXTRACTION_TASK(taskType)) {
    const candidateModels = [
      OPENROUTER_CV_EXTRACTION_MODEL,
      NVIDIA_PRIMARY_MODEL,
    ];

    let lastError: any = null;
    // Why DeepSeek gave no answer, when the fallback is the one that answers.
    let primaryError: string | undefined;

    for (const model of candidateModels) {
      const isNvidiaModel = model.startsWith("meta/");
      if (isNvidiaModel && lastError) primaryError = lastError?.message || String(lastError);
      const maxRetries = isNvidiaModel ? 1 : 2;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          // Reading a whole CV into JSON takes deepseek-v4-flash 30–45 seconds
          // (measured on real linkedin@ CVs, 17 September). At the old 30s
          // limit both tries timed out, the fallback model answered with an
          // empty object, and 141 real CVs were rejected as "not a CV".
          // Two tries at 75s stay inside the extraction's 210s deadline.
          const client = isNvidiaModel ? getNvidiaOpenAI() : getOpenAI(taskType, 75_000);
          const response = await client.chat.completions.create({
            model,
            messages: options.messages,
            temperature: options.temperature ?? 0.1,
            max_tokens: options.max_tokens ?? 4096,
            ...(options.response_format ? { response_format: options.response_format } : {}),
            // deepseek-v4-flash "thinks" first, and the thinking is billed
            // against max_tokens: on a long CV it used most of the 8,192 and the
            // JSON stopped after a few hundred characters ("not readable JSON
            // (323 characters — likely cut off)", 28 Oct), after up to two
            // 75-second tries. Reading a CV into fields needs no reasoning —
            // the JD parser and Desk Copilot turned it off for the same
            // reason (17 Sep). OpenRouter-only field; NVIDIA does not get it.
            ...(isNvidiaModel ? {} : ({ reasoning: { enabled: false } } as object)),
          });

          if (response.usage) {
            await logLLMUsage(
              ctx,
              taskType,
              model,
              response.usage.prompt_tokens,
              response.usage.completion_tokens,
              true,
              undefined,
              options.cvUploadId,
              isNvidiaModel ? "nvidia" : "openrouter",
              options.sourceChannel
            );
          }

          const content = response.choices[0]?.message?.content?.trim() || "";
          // A cut-off JSON answer used to be handed straight back and the CV
          // failed on it; it now counts as a failed try, so the second try and
          // then the fallback model get their turn (28 Oct).
          if (content && options.response_format?.type === "json_object" && !isCompleteJson(content)) {
            throw new Error(`${model} gave JSON that stops part-way (${content.length} characters, finish: ${response.choices[0]?.finish_reason ?? "unknown"})`);
          }
          if (content) {
            if (taskType === "cv_structuring" && !hasCvDetailsJson(content)) {
              throw new Error(`${model} found no candidate details`);
            }
            return { content, provider: isNvidiaModel ? "nvidia" : "openrouter", model, ...(isNvidiaModel ? { primaryError } : {}) };
          }
          throw new Error(`${model} returned empty response`);
        } catch (err: any) {
          lastError = err;
          const errorMsg = err?.message || String(err);
          console.warn(`[executeLLMWithNvidiaFallback] Model ${model} attempt ${attempt}/${maxRetries} failed: ${errorMsg}`);

          if (attempt < maxRetries) {
            const waitMs = Math.pow(2, attempt) * 1000;
            await new Promise((r) => setTimeout(r, waitMs));
          }
        }
      }
    }

    const finalErrorMsg = lastError?.message || String(lastError);
    await logLLMUsage(
      ctx,
      taskType,
      OPENROUTER_CV_EXTRACTION_MODEL,
      0,
      0,
      false,
      `CV Extraction Failed across all fallback models: ${finalErrorMsg}`,
      options.cvUploadId,
      "openrouter",
      options.sourceChannel
    );

    throw lastError || new Error("CV extraction LLM call failed across primary and fallback models");
  }

  // Non-CV Tasks (Reverse Match, Search, JD Extraction, Email Routing, etc.): Use NVIDIA NIM API
  const model = NVIDIA_PRIMARY_MODEL;
  try {
    const nvidiaOpenAI = getNvidiaOpenAI();
    const response = await nvidiaOpenAI.chat.completions.create({
      model,
      messages: options.messages,
      temperature: options.temperature ?? 0.1,
      max_tokens: options.max_tokens ?? 4096,
      ...(options.response_format ? { response_format: options.response_format } : {}),
    });

    if (response.usage) {
      await logLLMUsage(
        ctx,
        taskType,
        model,
        response.usage.prompt_tokens,
        response.usage.completion_tokens,
        true,
        undefined,
        options.cvUploadId,
        "nvidia",
        options.sourceChannel
      );
    }

    const content = response.choices[0]?.message?.content?.trim() || "";
    if (content) {
      return { content, provider: "nvidia", model };
    }
    throw new Error(`NVIDIA ${model} returned empty response`);
  } catch (nvidiaError: any) {
    const errorMsg = nvidiaError?.message || String(nvidiaError);
    console.error(`[executeLLMWithNvidiaFallback] Non-CV task call (${model}) failed for task "${taskType}": ${errorMsg}`);
    
    await logLLMUsage(
      ctx,
      taskType,
      model,
      0,
      0,
      false,
      `NVIDIA Call Failed: ${errorMsg}`,
      options.cvUploadId,
      "nvidia",
      options.sourceChannel
    );

    throw nvidiaError;
  }
}


