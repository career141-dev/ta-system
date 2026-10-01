import mammoth from "mammoth";
import { logAiFailure, modelFor, write } from "./ai";
import { extractPageTextWithLayout } from "./pdfLayout";
import { isPlausibleReferee } from "../../convex/lib/refereeCheck";

export interface ExtractedReferee {
  name: string;
  designation?: string;
  company?: string;
  contactNo?: string;
  email?: string;
  relationship?: string;
  notes?: string;
}

/**
 * Extracts plain text from a PDF or Word document buffer, preserving document layout.
 */
export async function extractRawText(buffer: Buffer, fileType?: string): Promise<string> {
  const isDocx = /word|docx/i.test(fileType ?? "");
  if (isDocx) {
    try {
      const result = await mammoth.extractRawText({ buffer });
      if (result.value && result.value.trim().length > 10) {
        return result.value;
      }
    } catch (err) {
      console.warn("[refereeExtractor] Mammoth docx extraction failed:", err);
    }
  }

  // 1. PDF extraction via pdfjs-dist with column/layout awareness
  try {
    // @ts-ignore
    const pdfjs: any = await import("pdfjs-dist/legacy/build/pdf.mjs").catch(() => import("pdfjs-dist/build/pdf.mjs"));
    const copy = Uint8Array.from(buffer);
    const loadingTask = pdfjs.getDocument({
      data: copy,
      useSystemFonts: true,
      disableFontFace: true,
      verbosity: 0,
    });
    const doc = await loadingTask.promise;
    let fullText = "";
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const pageText = extractPageTextWithLayout(textContent.items, viewport.width, viewport.height);
      if (pageText) {
        fullText += (fullText ? "\n\n" : "") + pageText;
      }
    }
    if (fullText.trim().length > 20) {
      return fullText;
    }
  } catch (err) {
    console.warn("[refereeExtractor] pdfjs text extraction failed, trying pdf2json:", err);
  }

  // 2. Fallback: PDF extraction via pdf2json
  try {
    const PDFParser = (await import("pdf2json")).default;
    const parser = new (PDFParser as any)(null, 1);
    const parsedText: string = await new Promise((resolve) => {
      parser.on("pdfParser_dataReady", () => {
        try {
          resolve(parser.getRawTextContent() || "");
        } catch {
          resolve("");
        }
      });
      parser.on("pdfParser_dataError", () => resolve(""));
      parser.parseBuffer(buffer);
    });
    if (parsedText && parsedText.trim().length > 20) {
      return parsedText;
    }
  } catch (err) {
    console.warn("[refereeExtractor] pdf2json text extraction failed:", err);
  }

  return buffer.toString("utf8");
}

/**
 * Extracts referees using OpenAI LLM if available, or deterministic rule-based parsing.
 */
export async function parseReferees(rawText: string): Promise<ExtractedReferee[]> {
  if (!rawText || rawText.trim().length < 20) return [];

  // Through the app's own AI layer, not a fetch of our own: that is where the
  // model for a task is chosen and where the spend cap is enforced. A hand
  // rolled call to api.openai.com billed a key nobody had pointed at this, on
  // every CV uploaded, and sent the candidate's CV to a provider the rest of
  // the system was not using (review, 23 Sep).
  try {
    const res = await write(
      "You read a CV and list the referees it names. You answer with JSON and nothing else.",
      `Extract every professional or academic referee explicitly listed in this CV.

Answer with a JSON array, and nothing else — no markdown, no explanation:
[{"name": "full name, with Dr./Prof./Mr./Ms. if the CV has it", "designation": "job title or null", "company": "organisation or null", "contactNo": "phone or null", "email": "email or null"}]

Nobody listed as a referee means []. Never invent one.

CV:
${rawText.slice(0, 16000)}`,
      1500,
      "parse",
    );
    if (res.ok) {
      const parsed = JSON.parse(res.text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim());
      if (Array.isArray(parsed)) {
        const valid = parsed
          .filter((r) => r && typeof r.name === "string" && r.name.trim().length > 0)
          .map((r) => ({
            name: String(r.name).trim(),
            designation: r.designation ? String(r.designation).trim() : undefined,
            company: r.company ? String(r.company).trim() : undefined,
            contactNo: r.contactNo ? String(r.contactNo).trim() : undefined,
            email: r.email ? String(r.email).trim() : undefined,
          }));
        if (valid.length > 0) return valid;
      }
    } else {
      logAiFailure("parse", modelFor("parse"), res);
    }
  } catch (err) {
    console.warn("[refereeExtractor] referee parsing failed, falling back to the rules:", err);
  }

  // Fallback: the deterministic rule-based parser below.
  return parseRefereesRegex(rawText);
}

/**
 * Deterministic fallback regex parser for REFERENCES / REFEREES section.
 */
export function parseRefereesRegex(text: string): ExtractedReferee[] {
  let refIndex = text.search(/\b(?:REFERENCES?|REFEREES?|NON[-\s]?RELATED\s+REFEREES?|PROFESSIONAL\s+REFEREES?|ACADEMIC\s+REFEREES?|CHARACTER\s+REFEREES?|WORK\s+REFEREES?)\b/i);
  let refSection = "";

  // No heading, no referees. Reading the tail of the CV and calling whatever
  // was there a referee filed "EDUCATION / BSc" as a contactable person on a
  // real candidate (review, 23 Sep). The model handles a CV that lists them
  // without a heading; these rules do not guess.
  if (refIndex === -1) return [];
  refSection = text.slice(refIndex).slice(0, 4000);

  // Stop at the next major section heading if present
  const nextSectionIndex = refSection
    .slice(15)
    .search(
      /\n\s*(?:SUMMARY|PROFILE|ABOUT\s+ME|OBJECTIVE|EXPERIENCE|WORK\s+EXPERIENCE|EMPLOYMENT|PROJECTS?|KEY\s+PROJECTS?|INITIATIVES?|EDUCATION|SKILLS?|TECHNICAL\s+SKILLS?|AREA\s+OF\s+EXPERTISE|CERTIFICATIONS?|DECLARATION|AWARDS?|PUBLICATIONS?|VOLUNTEER(?:ING)?|INTERESTS?|HOBBIES?|LANGUAGES?|CONTACT|PERSONAL\s+DETAILS?)\b/i,
    );
  if (nextSectionIndex !== -1) {
    refSection = refSection.slice(0, 15 + nextSectionIndex);
  }

  const rawLines = refSection
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => !/^(?:REFERENCES?|REFEREES?|NON[-\s]?RELATED\s+REFEREES?|PROFESSIONAL\s+REFEREES?):?$/i.test(l))
    .filter((l) => !/^(?:https?:\/\/|www\.|linkedin\.com|github\.com|[a-z0-9]+\.(?:com|org|net|io|site|dev|website|lk))\b/i.test(l))
    .filter((l) => !/^(?:website|portfolio|github|linkedin)\b/i.test(l));

  // 1. Group lines into distinct referee blocks (by blank lines, prefixes, honorifics)
  const blocks: string[][] = [];
  let currentBlock: string[] = [];

  for (const line of rawLines) {
    if (line.length === 0) {
      if (currentBlock.length > 0) {
        blocks.push(currentBlock);
        currentBlock = [];
      }
      continue;
    }

    const isNewBlockStart =
      /^(?:\d+[\.\)]|[\u2022\*\-])\s+/.test(line) ||
      /^(?:Referee\s*\d*|Reference\s*\d*|Name)\s*[:\-]/i.test(line) ||
      /^(?:Mr\.|Ms\.|Mrs\.|Dr\.|Prof\.|Eng\.)\s+[A-Z]/i.test(line);

    if (isNewBlockStart && currentBlock.length > 0) {
      blocks.push(currentBlock);
      currentBlock = [];
    }
    currentBlock.push(line);
  }
  if (currentBlock.length > 0) blocks.push(currentBlock);

  // If there's only 1 big block but multiple emails/phones, split by email
  const finalBlocks: string[][] = [];
  for (const blk of blocks) {
    const emailsInBlock = blk.filter((l) => /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(l));
    if (emailsInBlock.length > 1 && blk.length >= 2) {
      let temp: string[] = [];
      for (const l of blk) {
        temp.push(l);
        if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(l)) {
          finalBlocks.push(temp);
          temp = [];
        }
      }
      if (temp.length > 0) finalBlocks.push(temp);
    } else {
      finalBlocks.push(blk);
    }
  }

  const referees: ExtractedReferee[] = [];

  for (const block of finalBlocks) {
    const ref: Partial<ExtractedReferee> = {};
    const unhandledLines: string[] = [];

    for (let line of block) {
      // 1. Email extraction
      const emailMatch = line.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (emailMatch) {
        ref.email = emailMatch[0];
        line = line.replace(emailMatch[0], "").trim();
      }

      // 2. Phone extraction (after removing email to avoid matching numbers in email)
      const phoneMatch = line.match(/(?:(?:\+|00)\d{1,4}[-.\s]?)?(?:\(?\d{2,5}\)?[-.\s]?)?\d{3,5}[-.\s]?\d{3,5}/);
      if (phoneMatch) {
        const digits = phoneMatch[0].replace(/\D/g, "");
        if (digits.length >= 7 && digits.length <= 15) {
          ref.contactNo = phoneMatch[0].trim();
          line = line.replace(phoneMatch[0], "").trim();
        }
      }

      // 3. Clean leading/trailing punctuation and prefixes like 'Email:', 'Tel:', 'Mobile:', 'Phone:', 'Contact:'
      line = line.replace(/^(?:email|e-mail|tel|telephone|mobile|phone|contact(?:\s*no)?)\s*[:\-]?\s*/i, "").trim();
      line = line.replace(/^[,\-–—·:]+/, "").replace(/[,\-–—·:]+$/, "").trim();
      if (!line) continue;

      // 4. Labeled fields
      const nameMatch = line.match(/^(?:name|referee(?:\s*\d*)?|reference(?:\s*\d*)?)\s*[:\-]\s*(.*)$/i);
      if (nameMatch) {
        ref.name = nameMatch[1].trim();
        continue;
      }

      const desigMatch = line.match(/^(?:designation|title|position|role|post)\s*[:\-]\s*(.*)$/i);
      if (desigMatch) {
        ref.designation = desigMatch[1].trim();
        continue;
      }

      const compMatch = line.match(/^(?:company|organization|organisation|institute|institution|university|workplace|employer)\s*[:\-]\s*(.*)$/i);
      if (compMatch) {
        ref.company = compMatch[1].trim();
        continue;
      }

      const relMatch = line.match(/^(?:relationship|relation)\s*[:\-]\s*(.*)$/i);
      if (relMatch) {
        ref.relationship = relMatch[1].trim();
        continue;
      }

      // Remove bullet or number prefix from remaining line
      line = line.replace(/^(?:\d+[\.\)]|[\u2022\*\-])\s*/, "").trim();
      if (line) unhandledLines.push(line);
    }

    // Assign from unhandled lines
    if (!ref.name && unhandledLines.length > 0) {
      const firstLine = unhandledLines.shift()!;
      // Check if firstLine is 'Name, Designation, Company'
      const parts = firstLine.split(/[,\-–—·]\s*/);
      if (parts.length >= 2) {
        ref.name = parts[0].trim();
        if (!ref.designation && parts[1]) ref.designation = parts[1].trim();
        if (!ref.company && parts[2]) ref.company = parts[2].trim();
      } else {
        ref.name = firstLine;
      }
    }

    for (const line of unhandledLines) {
      if (!ref.designation && /analyst|lecturer|manager|engineer|director|lead|consultant|professor|doctor|officer|executive|head|specialist|teacher|architect|dean|developer|instructor|coordinator|advisor/i.test(line)) {
        ref.designation = line;
      } else if (!ref.company && /bank|university|institute|college|hospital|ltd|pvt|plc|inc|corp|technologies|solutions|group|services/i.test(line)) {
        ref.company = line;
      } else if (!ref.designation) {
        ref.designation = line;
      } else if (!ref.company) {
        ref.company = line;
      }
    }

    // Clean up designation / company if designation contains comma or dash
    if (ref.designation && !ref.company && /[,\-–—·]/.test(ref.designation)) {
      const parts = ref.designation.split(/[,\-–—·]\s*/);
      if (parts.length >= 2) {
        ref.designation = parts[0].trim();
        ref.company = parts.slice(1).join(", ").trim();
      }
    }

    if (ref.name && isPlausibleReferee(ref)) {
      referees.push(ref as ExtractedReferee);
    }
  }

  return referees;
}

/**
 * End-to-end referee extraction and database persistence.
 */
export async function extractAndSaveReferees(
  candidateId: string,
  buffer: Buffer,
  fileType?: string,
  /** Only add referees when the candidate has none — a replaced CV (29 Sep). */
  onlyIfNone = false,
): Promise<ExtractedReferee[]> {
  try {
    const rawText = await extractRawText(buffer, fileType);
    console.log(`[refereeExtractor] Extracted ${rawText.length} characters of text for candidate ${candidateId}`);
    const referees = await parseReferees(rawText);

    if (referees.length > 0) {
      const { convexMutation } = await import("./convexServer");
      console.log(`[refereeExtractor] Found ${referees.length} referees for candidate ${candidateId}:`, referees);
      await convexMutation("candidates/referees:saveExtractedReferees", {
        candidateId,
        referees,
        ...(onlyIfNone ? { onlyIfNone: true } : {}),
      });
      console.log(`[refereeExtractor] Successfully saved ${referees.length} referees to database for candidate ${candidateId}`);
    } else {
      console.log(`[refereeExtractor] No referees found in CV for candidate ${candidateId}`);
    }
    return referees;
  } catch (err) {
    console.error("[refereeExtractor] Failed to extract and save referees:", err);
    return [];
  }
}
