export const MAX_REFERENCE_CV_BYTES = 10 * 1024 * 1024;

/** The formats the extraction path can honestly read on every app host. */
export function referenceCvFileProblem(name: string, size: number): string | null {
  if (size <= 0) return "Please select a PDF, DOCX or TXT CV.";
  if (size > MAX_REFERENCE_CV_BYTES) return "That CV is over 10 MB. Choose a smaller PDF, DOCX or TXT file.";
  const lower = name.toLowerCase();
  if (lower.endsWith(".doc")) return "Old .doc files cannot be read reliably. Save the CV as PDF or DOCX and try again.";
  if (!/\.(pdf|docx|txt)$/i.test(lower)) return "Choose a PDF, DOCX or TXT CV.";
  return null;
}
