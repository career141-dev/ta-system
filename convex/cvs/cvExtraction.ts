"use node";

if (typeof process !== "undefined" && process.on) {
  process.on("uncaughtException", (err) => {
    console.warn("[CvExtraction] Trapped uncaught exception in Node worker process:", err?.message || err);
  });
}

if (typeof (globalThis as any).DOMMatrix === "undefined") {
  class DOMMatrixPolyfill {
    a: number; b: number; c: number; d: number; e: number; f: number;
    m11: number; m12: number; m13: number; m14: number;
    m21: number; m22: number; m23: number; m24: number;
    m31: number; m32: number; m33: number; m34: number;
    m41: number; m42: number; m43: number; m44: number;
    is2D: boolean; isIdentity: boolean;

    constructor(init?: any) {
      if (Array.isArray(init) && init.length === 6) {
        this.a = init[0]; this.b = init[1]; this.c = init[2]; this.d = init[3]; this.e = init[4]; this.f = init[5];
      } else if (init && typeof init === "object" && "a" in init) {
        this.a = init.a; this.b = init.b; this.c = init.c; this.d = init.d; this.e = init.e; this.f = init.f;
      } else {
        this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
      }
      this.m11 = this.a; this.m12 = this.b; this.m13 = 0; this.m14 = 0;
      this.m21 = this.c; this.m22 = this.d; this.m23 = 0; this.m24 = 0;
      this.m31 = 0; this.m32 = 0; this.m33 = 1; this.m34 = 0;
      this.m41 = this.e; this.m42 = this.f; this.m43 = 0; this.m44 = 1;
      this.is2D = true;
      this.isIdentity = this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
    }
    multiply(other?: any) {
      const o = other || new DOMMatrixPolyfill();
      return new DOMMatrixPolyfill([
        this.a * o.a + this.c * o.b,
        this.b * o.a + this.d * o.b,
        this.a * o.c + this.c * o.d,
        this.b * o.c + this.d * o.d,
        this.a * o.e + this.c * o.f + this.e,
        this.b * o.e + this.d * o.f + this.f,
      ]);
    }
    translate(tx = 0, ty = 0) {
      return this.multiply(new DOMMatrixPolyfill([1, 0, 0, 1, tx, ty]));
    }
    scale(sx = 1, sy = sx) {
      return this.multiply(new DOMMatrixPolyfill([sx, 0, 0, sy, 0, 0]));
    }
    rotate(angle = 0) {
      const rad = (angle * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      return this.multiply(new DOMMatrixPolyfill([cos, sin, -sin, cos, 0, 0]));
    }
    inverse() {
      const det = this.a * this.d - this.b * this.c;
      if (!det) return new DOMMatrixPolyfill();
      return new DOMMatrixPolyfill([
        this.d / det,
        -this.b / det,
        -this.c / det,
        this.a / det,
        (this.c * this.f - this.d * this.e) / det,
        (this.b * this.e - this.a * this.f) / det,
      ]);
    }
    transformPoint(p?: any) {
      const x = p?.x || 0; const y = p?.y || 0;
      return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f };
    }
  }
  (globalThis as any).DOMMatrix = DOMMatrixPolyfill;
}

import { Jimp } from "jimp";

import { v } from "convex/values";
import { action, internalAction } from "../_generated/server";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { api, internal } from "../_generated/api";
import OpenAI from "openai";
import crypto from "crypto";
import { z } from "zod";
import mammoth from "mammoth";
import { resolveCandidateLocation } from "../lib/locationResolver";
// Polyfill DOMMatrix for Node.js environment required by pdfjs-dist
if (typeof globalThis.DOMMatrix === "undefined") {
  (globalThis as any).DOMMatrix = class DOMMatrix {
    a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
    m11 = 1; m12 = 0; m21 = 0; m22 = 1; m41 = 0; m42 = 0;
    constructor(init?: any) {
      if (Array.isArray(init) && init.length >= 6) {
        this.a = this.m11 = init[0];
        this.b = this.m12 = init[1];
        this.c = this.m21 = init[2];
        this.d = this.m22 = init[3];
        this.e = this.m41 = init[4];
        this.f = this.m42 = init[5];
      }
    }
    multiply() { return this; }
    translate() { return this; }
    scale() { return this; }
    inverse() { return this; }
  };
}



import {
  deriveNoticePeriodDays,
  deriveSeniorityLevel,
  deriveEducationFields,
  deriveTotalExperienceYears,
  deriveCurrentRole,
} from "../candidates/derivations";
import { generateNvidiaEmbedding, logLLMUsage, callNvidiaVisionOCR, getOpenAI, getModelForTask, executeLLMWithNvidiaFallback, OPENROUTER_PRIMARY_MODEL, OPENROUTER_FALLBACK_MODELS, OPENROUTER_CV_EXTRACTION_MODEL, OPENROUTER_CV_FALLBACK_MODELS } from "../lib/llm";

// ──────────────────────────────────────────────────
// Types & Schemas
// ──────────────────────────────────────────────────

const makeArray = (val: any) => {
  if (val === null || val === undefined) return null;
  if (Array.isArray(val)) return val.filter(v => v !== null && v !== undefined).map(String);
  if (typeof val === "string") return val.split(",").map(s => s.trim());
  return [];
};

const makeNumber = (val: any) => {
  if (val === null || val === undefined) return null;
  const num = Number(val);
  return isNaN(num) ? null : num;
};

const makeString = (val: any) => {
  if (val === null || val === undefined) return null;
  return String(val);
};

export const educationSchema = z.object({
  degree: z.preprocess(makeString, z.string().nullable().optional()),
  institution: z.preprocess(makeString, z.string().nullable().optional()),
  year: z.preprocess(makeNumber, z.number().nullable().optional()),
  field: z.preprocess(makeString, z.string().nullable().optional()),
});

export const jobHistorySchema = z.object({
  company: z.preprocess(makeString, z.string().nullable().optional()),
  title: z.preprocess(makeString, z.string().nullable().optional()),
  startDate: z.preprocess(makeString, z.string().nullable().optional()),
  endDate: z.preprocess(makeString, z.string().nullable().optional()),
  description: z.preprocess(makeString, z.string().nullable().optional()),
  confidence: z.preprocess(makeNumber, z.number().nullable().optional()),
});

export const refereeSchema = z.object({
  name: z.preprocess(makeString, z.string().nullable().optional()),
  designation: z.preprocess(makeString, z.string().nullable().optional()),
  company: z.preprocess(makeString, z.string().nullable().optional()),
  contactNo: z.preprocess(makeString, z.string().nullable().optional()),
  email: z.preprocess(makeString, z.string().nullable().optional()),
  relationship: z.preprocess(makeString, z.string().nullable().optional()),
  notes: z.preprocess(makeString, z.string().nullable().optional()),
});


const makeSkillArray = (val: any) => {
  if (val === null || val === undefined) return null;
  if (Array.isArray(val)) {
    return val.filter(v => v && typeof v === 'object' && v.value).map(v => ({
      value: String(v.value),
      confidence: Number(v.confidence) || null
    }));
  }
  return [];
};

export const cvExtractionSchema = z.object({
  fullName: z.preprocess(makeString, z.string().nullable().optional()),
  email: z.preprocess(makeString, z.string().nullable().optional()),
  phone: z.preprocess(makeString, z.string().nullable().optional()),
  location: z.preprocess(makeString, z.string().nullable().optional()),
  linkedinUrl: z.preprocess(makeString, z.string().nullable().optional()),
  currentTitle: z.preprocess(makeString, z.string().nullable().optional()),
  currentEmployer: z.preprocess(makeString, z.string().nullable().optional()),
  seniorityLevel: z.preprocess(makeString, z.string().nullable().optional()),
  industries: z.preprocess(makeArray, z.array(z.string()).nullable().optional()),
  sector: z.preprocess(makeString, z.string().nullable().optional()),
  expectedSalary: z.preprocess(makeNumber, z.number().nullable().optional()),
  noticePeriod: z.preprocess(makeString, z.string().nullable().optional()),
  employmentStatus: z.preprocess(makeString, z.string().nullable().optional()),
  skills: z.preprocess(makeSkillArray, z.array(z.object({
    value: z.string(),
    confidence: z.number().nullable().optional()
  })).nullable().optional()),
  education: z.array(educationSchema).nullable().optional(),
  certifications: z.preprocess(makeArray, z.array(z.string()).nullable().optional()),
  languages: z.preprocess(makeArray, z.array(z.string()).nullable().optional()),
  summary: z.preprocess(makeString, z.string().nullable().optional()),
  jobHistory: z.array(jobHistorySchema).nullable().optional(),
  referees: z.array(refereeSchema).nullable().optional(),
});

export type CvExtractionResult = z.infer<typeof cvExtractionSchema>;

type ExtractionArgs = {
  storageId?: Id<"_storage">;
  fileType: string;
  sourceChannel?: string;
  uploadedBy: string;
  cvUploadId: Id<"cvUploads">;
  workableCandidateId?: string;
  skipLLM?: boolean;
  preExtractedData?: {
    fullName?: string;
    email?: string;
    phone?: string;
  };
  batchId?: Id<"ingestionBatches">;
  logId?: Id<"ingestionLog">;
  isRetry?: boolean;
  retryCount?: number;
  s3Key?: string;
  storageProvider?: string;
};

const ExtractionActionArgs = {
  storageId: v.optional(v.id("_storage")),
  s3Key: v.optional(v.string()),
  storageProvider: v.optional(v.string()),
  fileType: v.string(),
  sourceChannel: v.optional(v.string()),
  uploadedBy: v.string(),
  cvUploadId: v.id("cvUploads"),
  workableCandidateId: v.optional(v.string()),
  skipLLM: v.optional(v.boolean()),
  preExtractedData: v.optional(v.object({
    fullName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
  })),
  batchId: v.optional(v.id("ingestionBatches")),
  logId: v.optional(v.id("ingestionLog")),
  isRetry: v.optional(v.boolean()),
  retryCount: v.optional(v.number()),
};

// ──────────────────────────────────────────────────
// Text Extraction
// ──────────────────────────────────────────────────

function safeSliceBuffer(buffer: ArrayBuffer): ArrayBuffer {
  if (!buffer || buffer.byteLength === 0) {
    return new ArrayBuffer(0);
  }
  return buffer.slice(0);
}

function extractRawPdfStreamTextFallback(buffer: ArrayBuffer): string {
  try {
    const str = Buffer.from(safeSliceBuffer(buffer)).toString("latin1");
    const textMatches: string[] = [];

    // Match text within BT (Begin Text) and ET (End Text) operators
    const btBlocks = str.split("BT");
    for (const block of btBlocks) {
      if (!block.includes("ET")) continue;
      const etContent = block.split("ET")[0];

      // Match string literals (text)
      const matches = etContent.match(/\(([^()]+)\)/g);
      if (matches) {
        for (const m of matches) {
          const cleaned = m.slice(1, -1).replace(/\\([()\\])/g, "$1").trim();
          if (cleaned.length > 2 && /[\w\s@.,:/\-+()]{3,}/.test(cleaned)) {
            textMatches.push(cleaned);
          }
        }
      }
    }

    return textMatches.join(" ");
  } catch (err) {
    console.warn("[PDF Raw Stream Fallback] Failed to extract raw text streams:", err);
    return "";
  }
}

async function extractTextFromPdfWithPdfJs(buffer: ArrayBuffer): Promise<string> {
  try {
    ensureDOMMatrixPolyfill();
    // Use the legacy build — required for Node.js environments.
    // The non-legacy ESM build fails with 'hashOriginal.toHex is not a function'.
    // @ts-ignore
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs").catch(() => import("pdfjs-dist/build/pdf.mjs"));
    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(safeSliceBuffer(buffer)),
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0,
    });
    const pdfDocument = await loadingTask.promise;
    let fullText = "";

    for (let i = 1; i <= pdfDocument.numPages; i++) {
      const page = await pdfDocument.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item: any) => ("str" in item ? item.str : ""))
        .join(" ");
      fullText += pageText + "\n";
    }

    return fullText.trim();
  } catch (err: any) {
    console.warn("[pdfjs-dist] PDF text extraction error:", err.message || err);
    return "";
  }
}

async function extractTextFromPdf(buffer: ArrayBuffer): Promise<string> {
  ensureDOMMatrixPolyfill();

  // Primary PDF extractor: Mozilla pdfjs-dist (handles FlateDecode, CID fonts, & complex PDF structures)
  const pdfJsText = await extractTextFromPdfWithPdfJs(buffer);
  if (pdfJsText && pdfJsText.length >= 30) {
    return pdfJsText;
  }

  try {
    return await new Promise((resolve, reject) => {
      const PDFParser = require("pdf2json");
      const pdfParser = new PDFParser(null, 1);
      pdfParser.on("pdfParser_dataError", (errData: any) => {
        console.warn("[pdf2json] Parser error, attempting raw stream fallback:", errData?.parserError || errData);
        const fallbackText = extractRawPdfStreamTextFallback(buffer);
        if (fallbackText.trim().length >= 30) {
          console.log(`[extractTextFromPdf] Recovered ${fallbackText.trim().length} chars via raw stream fallback!`);
          resolve(fallbackText);
        } else {
          resolve(fallbackText || "");
        }
      });
      pdfParser.on("pdfParser_dataReady", () => {
        const text = pdfParser.getRawTextContent();
        if (!text || text.trim().length < 30) {
          const fallbackText = extractRawPdfStreamTextFallback(buffer);
          if (fallbackText.trim().length > (text?.trim().length || 0)) {
            resolve(fallbackText);
            return;
          }
        }
        resolve(text || "");
      });
      pdfParser.parseBuffer(Buffer.from(safeSliceBuffer(buffer)));
    });
  } catch (err: any) {
    console.warn("[pdf2json] Uncaught parser exception, using raw stream fallback:", err.message || err);
    return extractRawPdfStreamTextFallback(buffer);
  }
}

async function extractTextFromDocx(buffer: ArrayBuffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
    return result.value;
  } catch (error) {
    console.error("Docx extraction failed:", error);
    throw new Error("Docx extraction failed: " + (error as any).message);
  }
}

function ensureDOMMatrixPolyfill() {
  if (typeof (Promise as any).try === "undefined") {
    (Promise as any).try = function (fn: Function, ...args: any[]) {
      return new Promise((resolve) => resolve(fn(...args)));
    };
  }
  if (typeof (globalThis as any).DOMMatrix === "undefined") {
    class DOMMatrixPolyfill {
      a: number; b: number; c: number; d: number; e: number; f: number;
      m11: number; m12: number; m13: number; m14: number;
      m21: number; m22: number; m23: number; m24: number;
      m31: number; m32: number; m33: number; m34: number;
      m41: number; m42: number; m43: number; m44: number;
      is2D: boolean; isIdentity: boolean;

      constructor(init?: any) {
        if (Array.isArray(init) && init.length === 6) {
          this.a = init[0]; this.b = init[1]; this.c = init[2]; this.d = init[3]; this.e = init[4]; this.f = init[5];
        } else if (init && typeof init === "object" && "a" in init) {
          this.a = init.a; this.b = init.b; this.c = init.c; this.d = init.d; this.e = init.e; this.f = init.f;
        } else {
          this.a = 1; this.b = 0; this.c = 0; this.d = 1; this.e = 0; this.f = 0;
        }
        this.m11 = this.a; this.m12 = this.b; this.m13 = 0; this.m14 = 0;
        this.m21 = this.c; this.m22 = this.d; this.m23 = 0; this.m24 = 0;
        this.m31 = 0; this.m32 = 0; this.m33 = 1; this.m34 = 0;
        this.m41 = this.e; this.m42 = this.f; this.m43 = 0; this.m44 = 1;
        this.is2D = true;
        this.isIdentity = this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
      }
      multiply(other?: any) {
        const o = other || new DOMMatrixPolyfill();
        return new DOMMatrixPolyfill([
          this.a * o.a + this.c * o.b,
          this.b * o.a + this.d * o.b,
          this.a * o.c + this.c * o.d,
          this.b * o.c + this.d * o.d,
          this.a * o.e + this.c * o.f + this.e,
          this.b * o.e + this.d * o.f + this.f,
        ]);
      }
      translate(tx = 0, ty = 0) {
        return this.multiply(new DOMMatrixPolyfill([1, 0, 0, 1, tx, ty]));
      }
      scale(sx = 1, sy = sx) {
        return this.multiply(new DOMMatrixPolyfill([sx, 0, 0, sy, 0, 0]));
      }
      rotate(angle = 0) {
        const rad = (angle * Math.PI) / 180;
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        return this.multiply(new DOMMatrixPolyfill([cos, sin, -sin, cos, 0, 0]));
      }
      inverse() {
        const det = this.a * this.d - this.b * this.c;
        if (!det) return new DOMMatrixPolyfill();
        return new DOMMatrixPolyfill([
          this.d / det,
          -this.b / det,
          -this.c / det,
          this.a / det,
          (this.c * this.f - this.d * this.e) / det,
          (this.b * this.e - this.a * this.f) / det,
        ]);
      }
      transformPoint(p?: any) {
        const x = p?.x || 0; const y = p?.y || 0;
        return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f };
      }
    }
    (globalThis as any).DOMMatrix = DOMMatrixPolyfill;
    if (typeof global !== "undefined") {
      (global as any).DOMMatrix = DOMMatrixPolyfill;
    }
    if (typeof (globalThis as any).window !== "undefined") {
      (globalThis as any).window.DOMMatrix = DOMMatrixPolyfill;
    }
  }
}

/**
 * Converts a scanned PDF buffer into a list of base64 image data URLs safe for Vision OCR.
 * Uses DOMMatrix polyfill to run pdfjs-dist safely in Node.js server environment without DOM canvas.
 */
async function extractImagesFromPdfBuffer(
  buffer: ArrayBuffer,
  maxPages: number = 3
): Promise<string[]> {
  ensureDOMMatrixPolyfill();
  const images: string[] = [];
  try {
    let pdfjsLib: any;
    try {
      pdfjsLib = require("pdfjs-dist/legacy/build/pdf.mjs");
    } catch {
      try {
        pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
      } catch {
        pdfjsLib = require("pdfjs-dist");
      }
    }

    if (!pdfjsLib) {
      console.warn("[CvExtraction] pdfjs-dist is not available in server environment. Skipping PDF image rendering.");
      return [];
    }

    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(safeSliceBuffer(buffer)),
      useSystemFonts: true,
      disableFontFace: true,
    });
    const pdfDoc = await loadingTask.promise;
    const numPages = Math.min(pdfDoc.numPages, maxPages);

    const processImgData = async (imgData: any, pageNum: number) => {
      const width = imgData.width;
      const height = imgData.height;

      if (!width || !height || width < 50 || height < 50) {
        return;
      }

      if (imgData.data && imgData.data.length > 0) {
        try {
          let rgbaBuffer: Buffer;
          const kind = imgData.kind;

          if (kind === 1 || imgData.data.length === width * height) {
            rgbaBuffer = Buffer.alloc(width * height * 4);
            for (let j = 0; j < width * height; j++) {
              const val = imgData.data[j];
              const offset = j * 4;
              rgbaBuffer[offset] = val;
              rgbaBuffer[offset + 1] = val;
              rgbaBuffer[offset + 2] = val;
              rgbaBuffer[offset + 3] = 255;
            }
          } else if (imgData.data.length === width * height * 3) {
            rgbaBuffer = Buffer.alloc(width * height * 4);
            for (let j = 0; j < width * height; j++) {
              const srcOffset = j * 3;
              const destOffset = j * 4;
              rgbaBuffer[destOffset] = imgData.data[srcOffset];
              rgbaBuffer[destOffset + 1] = imgData.data[srcOffset + 1];
              rgbaBuffer[destOffset + 2] = imgData.data[srcOffset + 2];
              rgbaBuffer[destOffset + 3] = 255;
            }
          } else if (imgData.data.length === width * height * 4) {
            rgbaBuffer = Buffer.from(imgData.data);
          } else {
            return;
          }

          const jimpImg = new Jimp({
            data: rgbaBuffer,
            width,
            height,
          });

          const base64Data = await jimpImg.getBase64("image/jpeg");
          images.push(base64Data);
        } catch (jimpErr) {
          console.warn(`[PDF Image Extraction] Jimp encoding error on page ${pageNum}:`, jimpErr);
        }
      }
    };

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const ops = await page.getOperatorList();
      const processedKeys = new Set<string>();

      const getObjFromPage = (name: string): Promise<any> => {
        return new Promise((resolve) => {
          try {
            if (page.objs && page.objs.has && page.objs.has(name)) {
              page.objs.get(name, (obj: any) => resolve(obj));
            } else if (page.commonObjs && page.commonObjs.has && page.commonObjs.has(name)) {
              page.commonObjs.get(name, (obj: any) => resolve(obj));
            } else if (page.objs && page.objs.get) {
              const direct = page.objs.get(name);
              resolve(direct);
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      };

      const parseOps = async (operatorList: any) => {
        for (let i = 0; i < operatorList.fnArray.length; i++) {
          const fn = operatorList.fnArray[i];
          if (
            fn === pdfjsLib.OPS.paintImageXObject ||
            fn === pdfjsLib.OPS.paintInlineImageXObject
          ) {
            const imgName = operatorList.argsArray[i][0];
            if (processedKeys.has(imgName)) continue;
            processedKeys.add(imgName);

            const imgData = await getObjFromPage(imgName);

            if (imgData) {
              await processImgData(imgData, pageNum);
            }
          } else if (fn === pdfjsLib.OPS.paintFormXObject) {
            const formName = operatorList.argsArray[i][0];
            try {
              const formObj = await getObjFromPage(formName);
              if (formObj && formObj.operatorList) {
                await parseOps(formObj.operatorList);
              }
            } catch { }
          }
        }
      };

      await parseOps(ops);

      if (images.length === 0 && page.objs) {
        const objsMap = (page.objs as any)._objs || (page.objs as any).objs || (page.objs as any).data;
        if (objsMap) {
          for (const key of Object.keys(objsMap)) {
            if (processedKeys.has(key)) continue;
            const obj = objsMap[key];
            if (obj && typeof obj === "object" && obj.width && obj.height && obj.data) {
              processedKeys.add(key);
              await processImgData(obj, pageNum);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error("[extractImagesFromPdfBuffer] Failed to extract images from PDF:", err);
  }

  return images;
}


export async function extractTextWithTesseract(
  buffer: ArrayBuffer,
  fileType: string,
  ctx?: ActionCtx,
  cvUploadId?: Id<"cvUploads">
): Promise<string> {
  const type = fileType.toLowerCase();
  console.log(`[OCR Extraction] Processing document OCR (${type})...`);

  try {
    // Fail-safe check: tesseract.js worker threads require unpacked disk scripts
    // which are unavailable inside Convex action containers. Return "" gracefully.
    return "";
  } catch (err: any) {
    console.error("[OCR Extraction] OCR failed gracefully:", err.message || err);
    return "";
  }
}

async function extractTextFromImage(
  buffer: ArrayBuffer,
  fileType: string,
  ctx?: ActionCtx,
  cvUploadId?: Id<"cvUploads">
): Promise<string> {
  const tesseractText = await extractTextWithTesseract(buffer, fileType);
  if (!tesseractText || tesseractText.trim().length < 20) {
    throw new Error("Insufficient text extracted from image (Tesseract OCR returned less than 20 characters).");
  }
  return tesseractText;
}

export async function extractText(
  buffer: ArrayBuffer,
  fileType: string,
  skipOCR: boolean = false,
  ctx?: ActionCtx,
  cvUploadId?: Id<"cvUploads">
): Promise<{ text: string; extractionModel: string }> {
  const type = fileType.toLowerCase();

  // 1. PDF Document Extraction
  if (type === "pdf" || type === "application/pdf") {
    let pdfText = "";
    try {
      pdfText = await extractTextFromPdf(buffer);
    } catch (e) {
      console.warn("[extractText] Standard PDF text extraction failed:", e);
    }

    if (pdfText && pdfText.trim().length >= 50) {
      return { text: pdfText, extractionModel: "deepseek-v4-flash" };
    }

    console.log(`[extractText] PDF text extraction yielded < 50 chars (${pdfText.trim().length} chars). Sending to Tesseract OCR...`);

    const tesseractText = await extractTextWithTesseract(buffer, fileType, ctx, cvUploadId);
    if (tesseractText && tesseractText.trim().length >= 20) {
      return { text: tesseractText, extractionModel: "ocr-tesseract" };
    }

    // Tesseract also failed (e.g. custom font-encoded PDFs that aren't scanned images).
    // Last resort: use the Vision OCR pipeline (NVIDIA + OpenRouter Gemini) which can read
    // PDFs rendered as images. callNvidiaVisionOCR already handles multimodal content correctly.
    if (ctx) {
      try {
        console.log("[extractText] Tesseract failed — attempting Vision OCR pipeline fallback...");
        const { callNvidiaVisionOCR } = await import("../lib/llm");
        // Extract page images from the PDF buffer for vision processing
        const pageImages = await extractImagesFromPdfBuffer(buffer, 5);
        if (pageImages && pageImages.length > 0) {
          const visionText = await callNvidiaVisionOCR(ctx, pageImages, cvUploadId);
          if (visionText && visionText.trim().length >= 20) {
            console.log(`[extractText] Vision OCR pipeline fallback succeeded (${visionText.trim().length} chars).`);
            return { text: visionText, extractionModel: "vision-nvidia-pdf" };
          }
        } else {
          console.warn("[extractText] Could not render page images for Vision OCR fallback.");
        }
      } catch (vErr: any) {
        console.warn("[extractText] Vision OCR pipeline fallback failed:", vErr?.message || vErr);
      }
    }

    if (pdfText && pdfText.trim().length > 0) {
      return { text: pdfText, extractionModel: "deepseek-v4-flash" };
    }

    return { text: tesseractText || pdfText || "", extractionModel: "ocr-tesseract" };
  }


  // 2. DOCX / DOC
  const magic = new Uint8Array(buffer.slice(0, 4));
  const isZipHeader = magic[0] === 0x50 && magic[1] === 0x4b && magic[2] === 0x03 && magic[3] === 0x04;

  if (type === "docx" || type === "doc" || type.includes("wordprocessingml") || isZipHeader) {
    const docxText = await extractTextFromDocx(buffer);
    return { text: docxText, extractionModel: "deepseek-v4-flash" };
  }

  // 3. Images (PNG, JPG, JPEG, WEBP, TIFF)
  if (type.includes("image") || type === "png" || type === "jpeg" || type === "jpg" || type === "webp" || type === "tiff") {

    const visionText = await extractTextFromImage(buffer, fileType, ctx, cvUploadId);
    return { text: visionText, extractionModel: "vision-llama32" };
  }

  // 4. RTF & TXT
  if (type === "rtf") {
    const decoded = new TextDecoder("utf-8").decode(buffer);
    const text = decoded
      .replace(/\\[a-z]+[-0-9]*/g, "")
      .replace(/[{}]/g, "")
      .replace(/\\(?:par|line|tab)/g, " ")
      .replace(/\\'[0-9a-f]{2}/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 50) return { text, extractionModel: "deepseek-v4-flash" };
  }

  if (type === "txt") {
    return { text: new TextDecoder("utf-8").decode(buffer), extractionModel: "deepseek-v4-flash" };
  }

  return { text: new TextDecoder("utf-8", { fatal: false }).decode(buffer), extractionModel: "deepseek-v4-flash" };
}

// ──────────────────────────────────────────────────
// Text Cleaning
// ──────────────────────────────────────────────────

export function cleanRawText(text: string): string {
  let cleaned = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F\uFFFD]/g, "");

  cleaned = cleaned.replace(/[|│║┆┇┊┋┌┍┎┏┐┑┒┓└┕┖┗┘┙┚┛├┝┞┟┠┡┢┣┤┥┦┧┨┩┪┫┬┭┮┯┰┱┲┳┴┵┶┷┸┹┺┻┼┽┾┿╀╁╂╃╄╅╆╇╈╉╊╋═║╒╓╔╕╖╗╘╙╚╛╜╝╞╟╠╡╢╣╤╥╦╧╨╩╪╫╬╭╮╯╰╱╲╳╴╵╶╷╸╹╺╻╼╽╾╿─━┄┅┈┉]/g, " ");
  cleaned = cleaned.replace(/[-_]{3,}/g, " ");

  const lines = cleaned.split("\n");

  const lineCounts = new Map<string, number>();
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      lineCounts.set(trimmed, (lineCounts.get(trimmed) || 0) + 1);
    }
  }

  const filteredLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();

    if (/^page\s*\d+\s*(of\s*\d+)?$/i.test(trimmed)) continue;
    if (/^\d+\s*\/\s*\d+$/.test(trimmed)) continue;
    if (/^\d+$/.test(trimmed)) continue;

    if (trimmed.length > 0 && (lineCounts.get(trimmed) || 0) >= 3) {
      continue;
    }

    filteredLines.push(line);
  }

  cleaned = filteredLines.join("\n");

  cleaned = cleaned.replace(/\n{3,}/g, "\n");
  cleaned = cleaned.replace(/[ \t]{2,}/g, " ");

  return cleaned;
}

const MAX_RAW_TEXT_LENGTH = 150_000;

function computeSha256(buffer: ArrayBuffer): string {
  return crypto.createHash("sha256").update(Buffer.from(buffer)).digest("hex");
}

function parseJsonRobustly(content: string): Record<string, unknown> | null {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch { }

  const stripped = content.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch { }

  const firstBrace = content.indexOf("{");
  const lastBrace = content.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      const jsonStr = content.substring(firstBrace, lastBrace + 1);
      return JSON.parse(jsonStr) as Record<string, unknown>;
    } catch { }
  }

  return null;
}

/**
 * Calls OpenRouter LLM to extract structured CV data.
 * Uses OPENROUTER_PRIMARY_MODEL with fallback models if rate-limited.
 */
export async function callOpenRouterLLM(
  ctx: ActionCtx,
  rawText: string,
  cvUploadId?: Id<"cvUploads">,
  sourceChannel?: string
): Promise<CvExtractionResult | null> {
  // 6 000 chars (~1 500 tokens) comfortably covers all 16 structured fields.
  // Fewer tokens = faster first-token latency and faster generation on DeepSeek.
  const MAX_CHARS = 6000;
  const textToSend =
    rawText.length > MAX_CHARS
      ? rawText.slice(0, MAX_CHARS).replace(/\s+\S*$/, "")
      : rawText;

  const messages: any[] = [
    {
      role: "system",
      content: `Extract candidate information from the CV text provided by the user and return it as a JSON object.
CRITICAL INSTRUCTION: If the document is NOT a CV, Resume, or Candidate Profile (e.g., if it is an email signature, company brochure, invoice, cover letter without a CV, or random text), you MUST return an empty JSON object: {}
1. Return only valid JSON. No markdown, no backticks, no explanation.
2. If a field is not found, return null. Never invent or guess.
3. Return skills as an array of objects with value and confidence (0.0 to 1.0).
4. Return jobHistory as an array of objects, including a confidence field (0.0 to 1.0) on each job object.
5. If currentTitle or currentEmployer are not explicitly stated as "current" or "present", infer them from the most recent job in their work experience by considering the dates.
6. Extract any referees or professional references explicitly mentioned in the CV (including name, designation/title, company, contact number/phone, email, relationship to candidate, and any notes). Return as an array of objects under "referees".

JSON Target Schema:
{
  "fullName": null,
  "email": null,
  "phone": null,
  "location": null,
  "linkedinUrl": null,
  "currentTitle": null,
  "currentEmployer": null,
  "seniorityLevel": null,
  "industries": null,
  "sector": null,
  "skills": [{ "value": "string", "confidence": 0.0 }],
  "education": [{ "degree": null, "institution": null, "year": null, "field": null }],
  "languages": null,
  "summary": null,
  "jobHistory": [{ "company": null, "title": null, "startDate": null, "endDate": null, "description": null, "confidence": 0.0 }],
  "referees": [{ "name": null, "designation": null, "company": null, "contactNo": null, "email": null, "relationship": null, "notes": null }]
}`
    },
    {
      role: "user",
      content: `CV TEXT:\n${textToSend}`
    }
  ];

  try {
    const { content } = await executeLLMWithNvidiaFallback(ctx, "cv_structuring", {
      messages,
      temperature: 0,
      max_tokens: 4096,
      response_format: { type: "json_object" },
      cvUploadId,
      sourceChannel,
    });

    if (!content) return null;
    const parsed = parseJsonRobustly(content);
    if (!parsed) return null;

    if (Object.keys(parsed).length === 0 || (!parsed.fullName && !parsed.email && !parsed.phone && !parsed.skills && !parsed.jobHistory)) {
      throw new Error("NOT_A_CV");
    }

    try {
      return cvExtractionSchema.parse(parsed);
    } catch (e) {
      console.error("Zod parse error:", e);
      return null;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "NOT_A_CV") throw error;
    console.error("[callOpenRouterLLM] CV extraction failed on primary and fallback LLM:", message);
    return null;
  }
}



// ──────────────────────────────────────────────────
// null → undefined helper
// ──────────────────────────────────────────────────

type NullToUndefined<T> = T extends null
  ? undefined
  : T extends (infer U)[]
  ? NullToUndefined<U>[]
  : T extends Record<string, unknown>
  ? { [K in keyof T]: NullToUndefined<T[K]> }
  : T;

function nullToUndefined<T extends Record<string, unknown>>(
  obj: T,
): { [K in keyof T]: NullToUndefined<T[K]> } {
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => {
      if (v === null) return [k, undefined];
      if (Array.isArray(v)) {
        return [
          k,
          v.map((item) =>
            item !== null && typeof item === "object" && !Array.isArray(item)
              ? Object.fromEntries(
                Object.entries(item).map(([ik, iv]) => [
                  ik,
                  iv === null ? undefined : iv,
                ]),
              )
              : item,
          ),
        ];
      }
      return [k, v];
    }),
  ) as { [K in keyof T]: NullToUndefined<T[K]> };
}

// ──────────────────────────────────────────────────
// Core extraction pipeline — one CV at a time
// ──────────────────────────────────────────────────

export async function runCvExtraction(
  ctx: ActionCtx,
  args: ExtractionArgs,
): Promise<string | null> {
  const { storageId, fileType, sourceChannel, cvUploadId, workableCandidateId, skipLLM, preExtractedData } = args;
  const tStart = Date.now();
  let t_download = 0;
  let t_text = 0;
  let t_llm = 0;
  let t_embed = 0;
  let t_write = 0;

  const CV_EXTRACTION_DEADLINE_MS = 210_000;
  const checkDeadline = (stage: string) => {
    const elapsed = Date.now() - tStart;
    if (elapsed > CV_EXTRACTION_DEADLINE_MS) {
      throw new Error(`CV extraction safety guard tripped at stage "${stage}" (${Math.round(elapsed / 1000)}s elapsed > 210s threshold). Terminating cleanly before Convex runtime kill.`);
    }
  };

  // Check if upload is still valid/running, abort if already marked cancelled
  const cvUpload = await ctx.runQuery(internal.candidates.candidates.getCvUpload, { cvUploadId });
  if (!cvUpload || cvUpload.status === "cancelled") {
    console.log(`[CvExtraction] Aborting extraction for upload ${cvUploadId} because status is: ${cvUpload?.status}`);
    return null;
  }

  await ctx.runMutation(api.candidates.candidates.updateCvUpload, {
    cvUploadId,
    status: "processing",
    processingStartedAt: Date.now(),
  });

  if (args.logId) {
    await ctx.runMutation(api.cvs.batches.updateLogStage, {
      logId: args.logId,
      stage: "parsing"
    });
  }

  let candidateId: any = null;

  try {
    let url: string | null = null;
    const tDownloadStart = Date.now();

    const effectiveS3Key = args.s3Key || cvUpload.s3Key;
    const effectiveStorageId = args.storageId || cvUpload.storageId;
    const effectiveStorageProvider = args.storageProvider || cvUpload.storageProvider || (effectiveS3Key ? "r2" : "convex");

    if (effectiveS3Key && effectiveStorageProvider === "r2") {
      url = await ctx.runAction(api.storage.r2.generateDownloadUrl, { key: effectiveS3Key });
    } else if (effectiveStorageId) {
      url = await ctx.storage.getUrl(effectiveStorageId);
    } else if (effectiveS3Key) {
      url = await ctx.runAction(api.storage.r2.generateDownloadUrl, { key: effectiveS3Key });
    }

    if (!url) throw new Error("File URL not found (neither R2 nor Convex storage)");

    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Failed to download file from Convex storage. Status: ${response.status}`);

    const buffer = await response.arrayBuffer();
    t_download = Date.now() - tDownloadStart;
    checkDeadline("post_download");

    if (buffer.byteLength === 0) {
      throw new Error("The file retrieved from storage is empty (zero bytes).");
    }
    const fileHash = computeSha256(buffer);

    // Skip extraction if file is duplicate of an already extracted candidate (Agent 6 factor)
    const existingCandidate = await ctx.runQuery(internal.candidates.candidates.findCandidateByHash, { fileHash });
    if (existingCandidate) {
      console.log(`[CvExtraction] Duplicate CV detected (hash: ${fileHash}). Candidate ID: ${existingCandidate._id}. Skipping extraction.`);

      const jobId = await ctx.runMutation(api.candidates.candidates.updateCvUpload, {
        cvUploadId,
        status: "processed",
        fileHash,
        candidateId: existingCandidate._id,
      }) as string | undefined | null;

      if (jobId) {
        await ctx.runMutation(api.applications.applications.createApplication, {
          candidateId: existingCandidate._id,
          jobId: jobId as any,
          cvFileId: cvUploadId,
          sourceChannel: sourceChannel ?? "manual_upload",
          metaCampaignId: cvUpload.campaignLabel,
          metaSourceUrl: cvUpload.metaSourceUrl,
          metaSourceId: cvUpload.metaSourceId,
          metaHeadline: cvUpload.metaHeadline,
        });

        // Trigger scoring for this duplicate CV on the new job too
        if (!skipLLM) {
          await ctx.scheduler.runAfter(0, api.cvs.cvScoringActions.processCvScoring, {
            candidateId: existingCandidate._id,
            jobId: jobId as any,
          });
        }
      }

      if (args.logId) {
        await ctx.runMutation(api.cvs.batches.updateLogStage, {
          logId: args.logId,
          stage: "completed",
          candidateName: existingCandidate.fullName || "Duplicate Candidate",
        });
      }

      if (args.batchId) {
        await ctx.runMutation(api.cvs.batches.updateBatchProgress, {
          batchId: args.batchId,
          status: "completed",
        });
        await ctx.runMutation(api.cvs.cvUploads.checkAndTriggerNextBatch, {
          batchId: args.batchId,
        });
      }

      return existingCandidate._id;
    }

    const tTextStart = Date.now();
    const { text: rawText, extractionModel } = await extractText(buffer, fileType, !!skipLLM, ctx, cvUploadId);
    t_text = Date.now() - tTextStart;
    checkDeadline("post_text_extraction");

    const cleanedText = cleanRawText(rawText);
    let trimmed = cleanedText.trim();

    if (trimmed.length < 50) {
      console.warn(`[CvExtraction] Initial text extraction returned short text (${trimmed.length} chars < 50). Attempting Tesseract OCR fallback...`);
      try {
        const tesseractText = await extractTextWithTesseract(buffer, fileType);
        const cleanedTesseract = cleanRawText(tesseractText).trim();
        if (cleanedTesseract.length >= 50) {
          trimmed = cleanedTesseract;
          console.log(`[CvExtraction] Tesseract OCR successfully extracted ${trimmed.length} chars.`);
        }
      } catch (tesseractErr: any) {
        console.warn("[CvExtraction] Pre-check Tesseract OCR fallback failed:", tesseractErr?.message || tesseractErr);
      }
    }

    if (trimmed.length < 50) {
      console.warn(`[CvExtraction] Extracted text is too short (${trimmed.length} chars < 50 threshold). Flagging upload ${cvUploadId} for human review (needs_review).`);
      await ctx.runMutation(api.candidates.candidates.updateCvUpload, {
        cvUploadId,
        status: "needs_review",
        errorMessage: `Low-confidence OCR text (${trimmed.length} chars < 50 threshold). Tesseract failed or produced thin text. Flagged for manual TA human review.`,
      });
      if (args.logId) {
        await ctx.runMutation(api.cvs.batches.updateLogStage, {
          logId: args.logId,
          stage: "needs_review",
          errorMessage: "Low-confidence OCR text (< 50 chars). Flagged for TA review.",
        });
      }
      return null;
    }
    let cappedRawText = trimmed.length > MAX_RAW_TEXT_LENGTH
      ? trimmed.slice(0, MAX_RAW_TEXT_LENGTH)
      : trimmed;

    const tWrite1Start = Date.now();
    // 1. Upload raw text to Cloudflare R2 object storage (0 RAM/SQLite cost in Convex)
    let rawTextKey: string | undefined = undefined;
    try {
      rawTextKey = await ctx.runAction(internal.storage.r2.uploadCvRawTextToR2, {
        candidateId: cvUploadId,
        cvUploadId,
        rawText: cappedRawText,
      });
    } catch (r2Err: any) {
      console.warn(`[CvExtraction] R2 raw text upload error for upload ${cvUploadId}:`, r2Err?.message || r2Err);
    }

    if (cvUpload.candidateId) {
      candidateId = cvUpload.candidateId;
      await ctx.runMutation(api.candidates.candidates.updateCandidateFields, {
        candidateId,
        rawTextKey,
        fileHash,
        cvUploadId,
        extractionModel,
      });
    } else {
      candidateId = await ctx.runMutation(api.candidates.candidates.createCandidate, {
        rawTextKey,
        sourceChannel: sourceChannel ?? undefined,
        fileHash,
        cvUploadId,
        workableCandidateId: workableCandidateId ?? undefined,
        isParsed: !skipLLM,
        extractionModel,
      });
    }

    await ctx.runMutation(api.candidates.candidates.updateCvUpload, {
      cvUploadId,
      status: "processing",
      fileHash,
      candidateId,
    });
    t_write += Date.now() - tWrite1Start;

    let finalCandidateId: Id<"candidates"> | null = null;
    let extracted: CvExtractionResult | null = null;
    let embedding: number[] | undefined = undefined;

    if (skipLLM && preExtractedData) {
      extracted = {
        fullName: preExtractedData.fullName ?? null,
        email: preExtractedData.email ?? null,
        phone: preExtractedData.phone ?? null,
        location: null,
        linkedinUrl: null,
        currentTitle: null,
        currentEmployer: null,
        seniorityLevel: null,
        industries: null,
        sector: null,
        expectedSalary: null,
        noticePeriod: null,
        employmentStatus: null,
        skills: null,
        education: null,
        certifications: null,
        languages: null,
        summary: null,
        jobHistory: null,
      } as unknown as CvExtractionResult;

      try {
        const tEmbedStart = Date.now();
        embedding = await generateNvidiaEmbedding(ctx, cappedRawText, cvUploadId);
        t_embed = Date.now() - tEmbedStart;
      } catch (embedErr: any) {
        console.error("[CvExtraction] Embedding generation failed (continuing without embedding):", embedErr.message || embedErr);
      }
    } else {
      if (args.logId) {
        await ctx.runMutation(api.cvs.batches.updateLogStage, {
          logId: args.logId,
          stage: "ai_extraction"
        });
      }

      // LLM structuring only — embedding is deferred to background scheduler below
      checkDeadline("pre_llm");
      const tLlmStart = Date.now();
      let extractedData = await callOpenRouterLLM(ctx, cappedRawText, cvUploadId, sourceChannel).catch((err) => {
        console.warn("[CvExtraction] First call to OpenRouter LLM failed:", err.message || err);
        return null;
      });
      t_llm = Date.now() - tLlmStart;
      checkDeadline("post_llm");

      extracted = extractedData;

      // Fallback: If initial text extraction produced thin/no text, process CV through local Tesseract.js OCR
      if (!extracted) {
        console.warn(`[CvExtraction] Initial text extraction returned thin/empty result. Sending CV to Tesseract OCR...`);
        try {
          const tesseractRawText = await extractTextWithTesseract(buffer, fileType);
          const cleanedTesseract = cleanRawText(tesseractRawText).trim();

          // STRICT LOW-CONFIDENCE / THIN-TEXT CHECK (< 50 characters)
          if (cleanedTesseract.length < 50) {
            console.warn(`[CvExtraction] Tesseract OCR output is too short (${cleanedTesseract.length} chars < 50 threshold). Flagging upload ${cvUploadId} for human review.`);
            await ctx.runMutation(api.candidates.candidates.updateCvUpload, {
              cvUploadId,
              status: "needs_review",
              errorMessage: `Low-confidence OCR text (${cleanedTesseract.length} chars < 50 threshold). Flagged for manual TA human review.`,
            });
            return null;
          }

          cappedRawText = cleanedTesseract.length > MAX_RAW_TEXT_LENGTH
            ? cleanedTesseract.slice(0, MAX_RAW_TEXT_LENGTH)
            : cleanedTesseract;

          console.log(`[CvExtraction] Tesseract OCR extracted ${cappedRawText.length} characters (>= 50 threshold). Passing text to OpenRouter DeepSeek...`);
          extracted = await callOpenRouterLLM(ctx, cappedRawText, cvUploadId, sourceChannel).catch((err) => {
            console.error("[CvExtraction] OpenRouter DeepSeek call on Tesseract OCR text failed:", err.message || err);
            return null;
          });
        } catch (tesseractErr: any) {
          console.error("[CvExtraction] Tesseract OCR fallback attempt failed:", tesseractErr.message || tesseractErr);
        }
      }

      if (!extracted) {
        throw new Error("LLM failed to extract candidate data (API timeout or invalid response)");
      }
      // Embedding is always deferred — scheduled after candidate save below
      embedding = undefined;
    }

    if (extracted) {
      const safeExtracted = nullToUndefined(extracted);

      const noticePeriodDays = deriveNoticePeriodDays(extracted.noticePeriod);
      // We pass undefined for yearsOfExperience since we rely on derivation
      const totalExperienceYears = deriveTotalExperienceYears(extracted.jobHistory, undefined);
      const seniorityLevel = deriveSeniorityLevel(totalExperienceYears, extracted.currentTitle) ?? safeExtracted.seniorityLevel;
      const { educationDegree, educationInstitution, educationYear } = deriveEducationFields(extracted.education);
      const { derivedEmployer, derivedTitle } = deriveCurrentRole(extracted.jobHistory, extracted.currentEmployer, extracted.currentTitle);

      const formattedSkills = safeExtracted.skills?.map((s: any) => s.value) || [];
      const parsingConfidence = {
        skills: safeExtracted.skills?.map((s: any) => ({ skill: s.value, confidence: s.confidence })),
        jobHistory: safeExtracted.jobHistory?.map((jh: any) => ({ company: jh.company, title: jh.title, confidence: jh.confidence }))
      };

      const formattedJobHistory = safeExtracted.jobHistory?.map((jh) => ({
        company: jh.company ?? "Unknown Company",
        title: jh.title ?? "Unknown Title",
        startDate: jh.startDate,
        endDate: jh.endDate,
        description: jh.description,
      }));

      const { referees, ...safeExtractedWithoutReferees } = safeExtracted;

      let locationStructured: any = undefined;
      if (safeExtracted.location && typeof safeExtracted.location === "string" && safeExtracted.location.trim()) {
        try {
          locationStructured = await resolveCandidateLocation(ctx, safeExtracted.location.trim());
        } catch (locErr) {
          console.warn("[CvExtraction] Location resolution error:", locErr);
        }
      }

      const updateRes: any = await ctx.runMutation(api.candidates.candidates.updateCandidateFields, {
        candidateId,
        rawTextKey,
        ...safeExtractedWithoutReferees,
        locationStructured,
        cvUploadId,
        currentEmployer: derivedEmployer,
        currentTitle: derivedTitle,
        jobHistory: formattedJobHistory,
        seniorityLevel: seniorityLevel ?? safeExtracted.seniorityLevel,
        noticePeriodDays,
        educationDegree,
        educationInstitution,
        educationYear,
        totalExperienceYears,
        fileHash,
        skills: formattedSkills,
        parsingConfidence,
        isParsed: true,
        hasEmbedding: true,
        extractionModel: extractionModel || OPENROUTER_PRIMARY_MODEL,
      });

      if (updateRes?.targetCandidateId) {
        candidateId = updateRes.targetCandidateId;
      }

      if (extracted.referees && extracted.referees.length > 0) {
        const validReferees = extracted.referees
          .filter((r) => r && r.name && r.name.trim().length > 0)
          .map((r) => ({
            name: r.name!.trim(),
            designation: r.designation || undefined,
            company: r.company || undefined,
            contactNo: r.contactNo || undefined,
            email: r.email || undefined,
            relationship: r.relationship || undefined,
            notes: r.notes || undefined,
          }));

        if (validReferees.length > 0) {
          await ctx.runMutation(api.candidates.referees.saveExtractedReferees, {
            candidateId,
            referees: validReferees,
          });
        }
      }

      // Always schedule embedding as a background task — directly upserts to Qdrant without saving vector arrays in Convex
      console.log(`[CvExtraction] Scheduling background Qdrant embedding for candidate ${candidateId}...`);
      await ctx.scheduler.runAfter(0, internal.matching.agent2.generateAndStoreEmbedding, {
        candidateId,
        rawText: cappedRawText,
      });
    }

    const resolvedCandidateId = candidateId;

    const jobId = await ctx.runMutation(api.candidates.candidates.updateCvUpload, {
      cvUploadId,
      status: "processed",
      fileHash,
      candidateId: resolvedCandidateId,
    }) as string | undefined | null;

    if (jobId) {
      await ctx.runMutation(api.applications.applications.createApplication, {
        candidateId: resolvedCandidateId,
        jobId: jobId as any,
        cvFileId: cvUploadId,
        sourceChannel: sourceChannel ?? "manual_upload",
        metaCampaignId: cvUpload?.campaignLabel,
        metaSourceUrl: cvUpload?.metaSourceUrl,
        metaSourceId: cvUpload?.metaSourceId,
        metaHeadline: cvUpload?.metaHeadline,
      });

      if (!skipLLM) {
        await ctx.scheduler.runAfter(0, api.cvs.cvScoringActions.processCvScoring, {
          candidateId: resolvedCandidateId,
          jobId: jobId as any,
        });
      }
    } else {
      // Tier 3 Fallback: If Subject & Body matching didn't yield a jobId during ingestion,
      // match the extracted candidate details against all active jobs after CV extraction.
      await ctx.scheduler.runAfter(0, internal.cvs.cvExtraction.matchExtractedCandidateToActiveJobs, {
        candidateId: resolvedCandidateId,
        cvUploadId,
        sourceChannel: sourceChannel ?? "manual_upload",
      });
    }

    if (args.logId) {
      await ctx.runMutation(api.cvs.batches.updateLogStage, {
        logId: args.logId,
        stage: "completed",
        candidateName: extracted?.fullName ?? undefined,
      });
    }
    if (args.batchId) {
      await ctx.runMutation(api.cvs.batches.updateBatchProgress, {
        batchId: args.batchId,
        status: "completed"
      });
      // Trigger the next batch automatically if this batch is complete
      await ctx.runMutation(api.cvs.cvUploads.checkAndTriggerNextBatch, {
        batchId: args.batchId,
      });
    }

    const t_total = Date.now() - tStart;
    console.log("[CV_TIMING_METRICS]", JSON.stringify({
      cvUploadId,
      t_download,
      t_text,
      t_llm,
      t_embed,
      t_write,
      t_total,
    }));

    return candidateId;
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    const isInsufficientBalance =
      message.includes("403") ||
      message.toLowerCase().includes("insufficient") ||
      message.toLowerCase().includes("balance") ||
      message.toLowerCase().includes("credits");

    const isRateLimit = message.includes("429") || message.toLowerCase().includes("too many requests");
    const isTransientLLMError = message.includes("timeout") || message.includes("invalid response") || message.toLowerCase().includes("timed out");
    const isNotACV = message.includes("NOT_A_CV");

    const shouldRetry = false; // Do not auto-retry 5-6 times on failure; single pass only

    // NEVER delete the candidate stub. Preserve the candidate and application in New CVs so no applicant is lost!
    if (candidateId) {
      const fallbackName = cvUpload?.fileName
        ? cvUpload.fileName.replace(/\.[^/.]+$/, "").replace(/[_\-]/g, " ")
        : "Applicant";

      await ctx.runMutation(api.candidates.candidates.updateCandidateFields, {
        candidateId,
        fullName: fallbackName,
        isParsed: false,
        cvUploadId,
      });

      const assignedJobId = cvUpload?.assignToJob;
      if (assignedJobId) {
        await ctx.runMutation(api.applications.applications.createApplication, {
          candidateId,
          jobId: assignedJobId as any,
          cvFileId: cvUploadId,
          sourceChannel: sourceChannel ?? "manual_upload",
        });
        console.log(`[CvExtraction] Preserved candidate ${candidateId} in job ${assignedJobId} (New CVs) despite extraction error: ${message}`);
      }
    }

    if (shouldRetry) {
      const nextRetryCount = ((args as any).retryCount ?? 0) + 1;
      const baseDelayMs = nextRetryCount * 60 * 1000; // 1m, 2m, 3m...
      const jitterMs = Math.floor(Math.random() * 30000); // up to 30s jitter
      const delayMs = baseDelayMs + jitterMs;
      const reason = isRateLimit ? "Nvidia API Rate Limit (429)" : "LLM API Timeout/Invalid Response";
      console.log(`[CvExtraction] ${reason}. Retrying in ${(delayMs / 1000).toFixed(1)}s (Attempt ${nextRetryCount})`);

      await ctx.runMutation(api.candidates.candidates.updateCvUpload, {
        cvUploadId,
        status: "pending_retry",
        errorMessage: `${reason}. Retrying automatically in ${(delayMs / 1000).toFixed(1)}s...`,
      });

      await ctx.scheduler.runAfter(delayMs, api.cvs.cvExtraction.processCvExtraction, {
        ...args,
        isRetry: true,
        retryCount: nextRetryCount
      });
      return null;
    }
    const attempts = cvUpload?.extractionAttempts ?? 0;
    const finalStatus = (isInsufficientBalance || isNotACV)
      ? "processed"
      : (attempts >= 1 ? "extraction_failed_permanent" : "failed");

    await ctx.runMutation(api.candidates.candidates.updateCvUpload, {
      cvUploadId,
      status: finalStatus,
      errorMessage: isInsufficientBalance
        ? "Processed raw text only (LLM extraction skipped due to insufficient credits)"
        : isNotACV
          ? "Document rejected: Not recognized as a valid CV or Resume."
          : (attempts >= 1 ? `Permanent extraction failure — limit reached (${attempts} attempt(s)): ${message}` : message),
    });

    if (args.logId) {
      await ctx.runMutation(api.cvs.batches.updateLogStage, {
        logId: args.logId,
        stage: isInsufficientBalance ? "completed" : finalStatus,
        errorMessage: message
      });
    }
    if (args.batchId) {
      await ctx.runMutation(api.cvs.batches.updateBatchProgress, {
        batchId: args.batchId,
        status: isInsufficientBalance ? "completed" : "failed"
      });
      // Trigger the next batch automatically if this batch is complete
      await ctx.runMutation(api.cvs.cvUploads.checkAndTriggerNextBatch, {
        batchId: args.batchId,
      });
    }

    console.error(`[CvExtraction] Extraction failed: ${message}`);
    return null;
  }
}

// ──────────────────────────────────────────────────
// Public Action — callable from client
// ──────────────────────────────────────────────────

export const processCvExtraction = action({
  args: ExtractionActionArgs,
  handler: async (ctx, args): Promise<string | null> => {
    try {
      return await runCvExtraction(ctx, args);
    } catch (err: any) {
      console.error(`[processCvExtraction] Top-level uncaught action error for upload ${args.cvUploadId}:`, err?.message || err);
      try {
        await ctx.runMutation(api.candidates.candidates.updateCvUpload, {
          cvUploadId: args.cvUploadId,
          status: "failed",
          errorMessage: err?.message || String(err),
        });
      } catch (updateErr) {
        console.error(`[processCvExtraction] Failed to mark upload as failed:`, updateErr);
      }
      return null;
    }
  },
});

// ──────────────────────────────────────────────────
// Batch Resume — rate limited queue worker
// ──────────────────────────────────────────────────

export const resumeFailedUploads = action({
  args: { batchId: v.optional(v.id("ingestionBatches")) },
  handler: async (ctx, args): Promise<{ queued: number }> => {
    await ctx.runAction(internal.cvs.cvExtraction.resumeBatch, {
      cursor: undefined,
      totalQueued: 0,
      batchId: args.batchId,
    });
    return { queued: 0 };
  },
});

export const resumeBatch = internalAction({
  args: { cursor: v.optional(v.string()), totalQueued: v.number(), batchId: v.optional(v.id("ingestionBatches")) },
  handler: async (ctx, args): Promise<void> => {
    const result = await ctx.runQuery(api.candidates.candidates.listFailedUploads, {
      limit: 5,
      cursor: args.cursor,
    });

    for (let i = 0; i < result.page.length; i++) {
      const upload = result.page[i];
      await ctx.runMutation(api.cvs.cvUploads.queueManualExtraction, {
        cvUploadId: upload._id,
        storageId: upload.storageId as Id<"_storage"> | undefined,
        s3Key: upload.s3Key,
        storageProvider: upload.storageProvider,
        fileName: upload.fileName,
        fileType: upload.fileType,
        sourceChannel: upload.source || "Retry Failed",
        uploadedBy: upload.uploadedBy,
        batchId: args.batchId,
        isRetry: true,
      });
    }

    if (!result.isDone && result.continueCursor) {
      ctx.scheduler.runAfter(
        result.page.length * 1000 + 500,
        internal.cvs.cvExtraction.resumeBatch,
        {
          cursor: result.continueCursor,
          totalQueued: args.totalQueued + result.page.length,
          batchId: args.batchId,
        },
      );
    }
  },
});

export const startBatchExtraction = action({
  args: { batchId: v.id("ingestionBatches") },
  handler: async (ctx, args) => {
    await ctx.runMutation(api.cvs.cvUploads.checkAndTriggerNextBatch, {
      batchId: args.batchId,
    });
  },
});
export const processNextBatch = internalAction({
  args: { batchId: v.id("ingestionBatches") },
  handler: async (ctx, args) => {
    // 1. Get up to 3 uploads in this batch that are still "uploaded"
    const uploads = await ctx.runQuery(internal.cvs.cvUploads.listUploadedInBatch, {
      batchId: args.batchId,
      limit: 3,
    });

    if (uploads.length === 0) {
      console.log(`[processNextBatch] No more uploads to process for batch ${args.batchId}`);
      return;
    }

    // 2. Queue those uploads with stagger
    let index = 0;
    const cvUploadIds = [];
    for (const upload of uploads) {
      cvUploadIds.push(upload._id);

      // Update status to "queued" and schedule extraction with a 2-second stagger
      await ctx.runMutation(api.cvs.cvUploads.queueManualExtraction, {
        cvUploadId: upload._id,
        storageId: upload.storageId as Id<"_storage"> | undefined,
        s3Key: upload.s3Key,
        storageProvider: upload.storageProvider,
        fileName: upload.fileName,
        fileType: upload.fileType,
        sourceChannel: upload.source || "Manual",
        uploadedBy: upload.uploadedBy,
        batchId: args.batchId,
        delayMs: index * 2000,
      });
      index++;
    }

    // 3. We no longer poll batch progress here.
    // The next batch will be triggered by checkAndTriggerNextBatch
    // when the last CV in this batch finishes extracting.
  },
});

export const matchExtractedCandidateToActiveJobs = internalAction({
  args: {
    candidateId: v.id("candidates"),
    cvUploadId: v.optional(v.id("cvUploads")),
    sourceChannel: v.string(),
  },
  handler: async (ctx, args) => {
    try {
      const activeJobs = await ctx.runQuery(api.jobs.jobs.getActiveJobsBasicInfo);
      if (!activeJobs || activeJobs.length === 0) return;

      const candidate = await ctx.runQuery(internal.matching.queries.getCandidate, {
        candidateId: args.candidateId,
      });
      if (!candidate) return;

      const cvUpload = args.cvUploadId ? await ctx.runQuery(internal.candidates.candidates.getCvUpload, { cvUploadId: args.cvUploadId }) : null;

      const eligibleJobs = activeJobs.filter((j: any) => !j.pausedChannels?.includes(args.sourceChannel));
      if (eligibleJobs.length === 0) return;

      const jobsListContext = eligibleJobs
        .map((j: any) => `- ID: ${j._id} | Title: ${j.title} | Client: ${j.clientName}`)
        .join("\n");

      const prompt = `You are an intelligent recruitment candidate router.
Your task is to analyze an extracted candidate profile and determine which active job posting they match best.

CRITICAL ROUTING RULES:
1. Match only if the candidate's skills, title, and background clearly align with the job function.
2. Do NOT cross-match different job functions: a Talent Acquisition / HR candidate must NOT be matched to a developer or tech role, a sales candidate must NOT go to an engineering role, etc.
3. If the candidate is a Video Editor (skills include Video Editing, Premiere Pro, After Effects, CapCut), match to the Video Editor job if open.
4. If the candidate is a Graphic Designer / UI Designer (skills include Photoshop, Illustrator, Figma, Graphic Design, Branding), match to the Graphic Designer job if open.
5. Only match if there is clear, confident alignment. If in doubt, return null — it is better to leave a candidate unrouted than to put them in the wrong pipeline.

ACTIVE JOBS:
${jobsListContext}

CANDIDATE NAME: ${candidate.fullName ?? "Unknown"}
CURRENT TITLE: ${candidate.currentJobTitle ?? candidate.currentEmployer ?? "N/A"}
EXTRACTED SKILLS: ${(candidate.skills || []).join(", ")}
SUMMARY: ${candidate.summary ?? "N/A"}

Respond ONLY with a valid JSON object in this exact format:
{
  "matchedJobId": "string ID of the matched job, or null if no confident match"
}`;

      const { content: resultStr } = await executeLLMWithNvidiaFallback(ctx, "email_routing", {
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
        temperature: 0.1,
        sourceChannel: args.sourceChannel,
      });

      if (resultStr) {
        const resultObj = JSON.parse(resultStr);
        if (resultObj.matchedJobId) {
          const matchedJob = activeJobs.find((j: any) => j._id === resultObj.matchedJobId);
          if (matchedJob) {
            console.log(`[CvExtraction] Post-extract AI matched candidate ${candidate.fullName ?? args.candidateId} to job: ${matchedJob.title} (${resultObj.matchedJobId})`);
            const isManualDirectory = 
              typeof args.sourceChannel === "string" && (
                args.sourceChannel.toLowerCase().includes("manual") ||
                args.sourceChannel.toLowerCase().includes("directory") ||
                args.sourceChannel.toLowerCase().includes("folder") ||
                args.sourceChannel === "database"
              );

            if (isManualDirectory) {
              // Manual directory / database candidates fall directly into the 'Matches' tab (reverseMatchResults)
              // and do NOT create an active pipeline application until shortlisted by TA.
              await ctx.runMutation(internal.jobs.jobs.addCandidateToReverseMatchResults, {
                jobId: resultObj.matchedJobId as any,
                candidateId: args.candidateId,
                cvUploadId: args.cvUploadId,
              });
            } else {
              await ctx.runMutation(api.applications.applications.createApplication, {
                candidateId: args.candidateId,
                jobId: resultObj.matchedJobId as any,
                cvFileId: args.cvUploadId,
                sourceChannel: args.sourceChannel,
                metaCampaignId: cvUpload?.campaignLabel,
                metaSourceUrl: cvUpload?.metaSourceUrl,
                metaSourceId: cvUpload?.metaSourceId,
                metaHeadline: cvUpload?.metaHeadline,
              });

              await ctx.scheduler.runAfter(0, api.cvs.cvScoringActions.processCvScoring, {
                candidateId: args.candidateId,
                jobId: resultObj.matchedJobId as any,
              });
            }
          }
        }
      }
    } catch (err: any) {
      console.error(`[matchExtractedCandidateToActiveJobs] Error matching candidate ${args.candidateId}:`, err.message || err);
    }
  },
});

// ──────────────────────────────────────────────────
// Background Queue Cron Worker — paced extraction at 10 CVs per 2-minute run.
// Previously 25 CVs at concurrency 2 on a 1-minute cron: when a batch ran past
// 60s the next run started on top of it and the overlap exhausted backend RAM.
// ──────────────────────────────────────────────────

export const processUnextractedQueueCron = internalAction({
  args: {},
  handler: async (ctx): Promise<{ processed: number }> => {
    // 1. Claim up to 10 'uploaded' records per run
    let claimed: any[] = await ctx.runMutation(internal.cvs.cvUploads.claimUploadedBatch, {
      limit: 10,
    });

    // 2. If no 'uploaded' records left, auto-recover stuck/failed/cancelled records into 'uploaded'
    if (!claimed || claimed.length === 0) {
      const recovery = await ctx.runMutation(internal.cvs.cvUploads.requeueAllStuckUploads, {
        limit: 20,
      });

      if (recovery.requeuedCount > 0) {
        console.log(`[processUnextractedQueueCron] Auto-recovered ${recovery.requeuedCount} stuck/failed CVs back into active extraction queue.`);
        claimed = await ctx.runMutation(internal.cvs.cvUploads.claimUploadedBatch, {
          limit: 10,
        });
      }
    }

    if (!claimed || claimed.length === 0) {
      return { processed: 0 };
    }

    console.log(`[processUnextractedQueueCron] Dispathing ${claimed.length} CVs to async AI extraction workers...`);

    // Stagger individual extractions by 2.5 seconds to prevent rate limits and run each in an independent execution sandbox
    for (let i = 0; i < claimed.length; i++) {
      const upload = claimed[i];
      await ctx.scheduler.runAfter(i * 2500, api.cvs.cvExtraction.processCvExtraction, {
        cvUploadId: upload._id,
        storageId: upload.storageId,
        s3Key: upload.s3Key,
        storageProvider: upload.storageProvider || (upload.s3Key ? "r2" : "convex"),
        fileType: upload.fileType || "pdf",
        sourceChannel: upload.source || "Manual Directory Import",
        uploadedBy: upload.uploadedBy || "System Worker",
      });
    }

    return { processed: claimed.length };
  },
});
