import { convexMutation } from "./convexServer";
import mammoth from "mammoth";

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

  // 1. PDF extraction via pdfjs-dist with newline and coordinate preservation
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
      const textContent = await page.getTextContent();
      let pageText = "";
      let lastY: number | null = null;
      for (const item of textContent.items) {
        if (!("str" in item)) continue;
        const y = item.transform ? item.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) {
          pageText += "\n";
        } else if (pageText.length > 0 && !pageText.endsWith("\n") && !pageText.endsWith(" ")) {
          pageText += " ";
        }
        pageText += item.str;
        if (item.hasEOL) {
          pageText += "\n";
        }
        lastY = y;
      }
      fullText += `\n${pageText}`;
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

  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY;

  if (apiKey) {
    try {
      const isDirectOpenAI = !!process.env.OPENAI_API_KEY;
      const endpoint = isDirectOpenAI
        ? "https://api.openai.com/v1/chat/completions"
        : "https://openrouter.ai/api/v1/chat/completions";
      const model = "gpt-4o-mini";

      const prompt = `Extract all professional and academic referees or references explicitly listed in this CV document.
Return ONLY a valid JSON array of objects with the following schema:
[
  {
    "name": "Full Name of referee (with honorific if present, e.g. Dr., Prof., Mr., Ms.)",
    "designation": "Job Title / Designation or null",
    "company": "Company / Organization / University / Institution or null",
    "contactNo": "Phone Number or null",
    "email": "Email Address or null"
  }
]
If there are no references listed, return []. Do not include markdown codeblocks or extra text, just the raw JSON array.

CV Content:
${rawText.slice(0, 15000)}`;

      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        const content = data.choices?.[0]?.message?.content?.trim() || "";
        const cleanJson = content.replace(/^```json/i, "").replace(/^```/i, "").replace(/```$/, "").trim();
        const parsed = JSON.parse(cleanJson);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const valid = parsed
            .filter((r) => r.name && typeof r.name === "string" && r.name.trim().length > 0)
            .map((r) => ({
              name: r.name.trim(),
              designation: r.designation?.trim() || undefined,
              company: r.company?.trim() || undefined,
              contactNo: r.contactNo?.trim() || undefined,
              email: r.email?.trim() || undefined,
            }));
          if (valid.length > 0) {
            return valid;
          }
        }
      } else {
        console.warn("[refereeExtractor] LLM API responded with status:", res.status);
      }
    } catch (llmErr) {
      console.warn("[refereeExtractor] LLM referee parsing failed, falling back to regex:", llmErr);
    }
  }

  // Fallback: Deterministic Rule-based Regex Parser
  return parseRefereesRegex(rawText);
}

/**
 * Deterministic fallback regex parser for REFERENCES / REFEREES section.
 */
export function parseRefereesRegex(text: string): ExtractedReferee[] {
  let refIndex = text.search(/\b(?:REFERENCES?|REFEREES?|NON[-\s]?RELATED\s+REFEREES?|PROFESSIONAL\s+REFEREES?|ACADEMIC\s+REFEREES?|CHARACTER\s+REFEREES?|WORK\s+REFEREES?)\b/i);
  let refSection = "";

  if (refIndex !== -1) {
    refSection = text.slice(refIndex).slice(0, 4000);
  } else {
    // If heading not found, scan the last 40% of the CV for contact blocks
    const lines = text.split(/\r?\n/);
    const startLine = Math.floor(lines.length * 0.5);
    refSection = lines.slice(startLine).join("\n");
  }

  const rawLines = refSection
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^(?:REFERENCES?|REFEREES?|NON[-\s]?RELATED\s+REFEREES?|PROFESSIONAL\s+REFEREES?):?$/i.test(l));

  // 1. Group lines into distinct referee blocks
  const blocks: string[][] = [];
  let currentBlock: string[] = [];

  for (const line of rawLines) {
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
    if (emailsInBlock.length > 1 && blk.length >= 3) {
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

      // 3. Clean leading prefixes like 'Email:', 'Tel:', 'Mobile:', 'Phone:', 'Contact:'
      line = line.replace(/^(?:email|e-mail|tel|telephone|mobile|phone|contact(?:\s*no)?)\s*[:\-]?\s*/i, "").trim();
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

    if (ref.name && ref.name.length > 2) {
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
  fileType?: string
): Promise<ExtractedReferee[]> {
  try {
    const rawText = await extractRawText(buffer, fileType);
    console.log(`[refereeExtractor] Extracted ${rawText.length} characters of text for candidate ${candidateId}`);
    const referees = await parseReferees(rawText);

    if (referees.length > 0) {
      console.log(`[refereeExtractor] Found ${referees.length} referees for candidate ${candidateId}:`, referees);
      await convexMutation("candidates/referees:saveExtractedReferees", {
        candidateId,
        referees,
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
