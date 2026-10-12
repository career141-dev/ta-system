/** Always use the worker shipped with this PDF.js API, including after upgrades. */
export async function browserPdfJs() {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = `/pdfjs/${pdfjs.version}/pdf.worker.min.mjs`;
  return pdfjs;
}
