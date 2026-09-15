"use node";

import OpenAI from "openai";
import type { ActionCtx } from "../_generated/server";


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
export const OPENROUTER_VISION_MODEL = "google/gemini-2.0-flash-lite-001";
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

export function getOpenAI(_taskType?: TaskType | string): OpenAI {
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
    defaultHeaders: {
      "HTTP-Referer": "https://career141.com",
      "X-Title": "Career141 System",
    },
    timeout: 30000,
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

export const OPENROUTER_VISION_MODELS = [
  "google/gemini-2.0-flash-lite-001",
];

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

  // 2. OpenRouter fallback if NVIDIA fails
  try {
    const openRouter = getOpenAI("cv_vision_ocr");
    for (const model of OPENROUTER_VISION_MODELS) {
      try {
        console.log(`[callNvidiaVisionOCR] Fallback: Invoking OpenRouter Vision OCR model: ${model}`);
        const response = await openRouter.chat.completions.create({
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

        const extractedText = response.choices[0]?.message?.content?.trim() || "";
        if (extractedText && extractedText.length > 10) {
          console.log(`[callNvidiaVisionOCR] Successfully extracted ${extractedText.length} chars using OpenRouter ${model}`);
          return extractedText;
        }
      } catch (err: any) {
        lastError = err?.message || String(err);
        console.warn(`[callNvidiaVisionOCR] OpenRouter Vision OCR failed with model ${model}: ${lastError}`);
      }
    }
  } catch (err: any) {
    lastError = err?.message || String(err);
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
): Promise<{ content: string; provider: "openrouter" | "nvidia"; model: string }> {
  if (IS_CV_EXTRACTION_TASK(taskType)) {
    const candidateModels = [
      OPENROUTER_CV_EXTRACTION_MODEL,
      NVIDIA_PRIMARY_MODEL,
    ];

    let lastError: any = null;

    for (const model of candidateModels) {
      const isNvidiaModel = model.startsWith("meta/");
      const maxRetries = isNvidiaModel ? 1 : 2;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const client = isNvidiaModel ? getNvidiaOpenAI() : getOpenAI(taskType);
          const response = await client.chat.completions.create({
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
              isNvidiaModel ? "nvidia" : "openrouter",
              options.sourceChannel
            );
          }

          const content = response.choices[0]?.message?.content?.trim() || "";
          if (content) {
            return { content, provider: isNvidiaModel ? "nvidia" : "openrouter", model };
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


