"use client";

import { useEffect, useRef, useState } from "react";
import { browserPdfJs } from "@/lib/pdfBrowser";

/**
 * Individual high-DPI canvas renderer for a single PDF page.
 * Keeps exact pixel dimensions to avoid any empty gaps, dark borders, or scrollbars.
 */
function PdfPageCanvas({
  doc,
  pageNum,
  numPages,
  containerWidth,
}: {
  doc: any;
  pageNum: number;
  numPages: number;
  containerWidth: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!doc || !canvasRef.current) return;
    let cancelled = false;
    let renderTask: any = null;

    (async () => {
      try {
        const page = await doc.getPage(pageNum);
        if (cancelled || !canvasRef.current) return;

        const base = page.getViewport({ scale: 1 });
        // Use full available container width, leaving small side margins
        const availableWidth = Math.max(300, Math.min(1000, containerWidth - 16));
        const scale = availableWidth / base.width;
        const ratio = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * ratio });

        const canvas = canvasRef.current;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / ratio)}px`;
        canvas.style.height = `${Math.floor(viewport.height / ratio)}px`;

        renderTask = page.render({ canvas, viewport });
        await renderTask.promise;
      } catch (err: any) {
        if (!cancelled && err?.name !== "RenderingCancelledException") {
          console.warn(`[CvFrame] Error rendering page ${pageNum}:`, err);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (renderTask) {
        try {
          renderTask.cancel();
        } catch {}
      }
    };
  }, [doc, pageNum, containerWidth]);

  return (
    <div className="relative flex flex-col items-center rounded-sm bg-white shadow-[0_1px_3px_rgba(0,0,0,0.08)] ring-1 ring-slate-900/5">
      {numPages > 1 && (
        <span className="absolute top-3 right-3 z-10 select-none rounded-md bg-slate-900/70 px-2 py-0.5 text-[11px] font-medium text-white shadow-xs backdrop-blur-xs">
          Page {pageNum} of {numPages}
        </span>
      )}
      <canvas ref={canvasRef} className="block rounded-sm bg-white" />
    </div>
  );
}

/**
 * Clean, full-height CV document viewer.
 *
 * - Renders all document pages onto exact-fit canvases (1 page = 1 page, 2 pages = 2 pages).
 * - Zero black background, zero extra spaces, zero nested internal scrollbars.
 * - Smooth Full Screen mode with clean enter & exit transitions.
 */
export function CvFrame({
  src,
  title,
  fileName,
  downloadHref,
  preparedCvHref,
}: {
  src: string;
  title: string;
  fileName?: string | null;
  downloadHref?: string;
  preparedCvHref?: string;
  height?: number | string;
}) {
  const [isFull, setIsFull] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pdfDoc, setPdfDoc] = useState<any>(null);
  const [numPages, setNumPages] = useState(0);
  const [containerWidth, setContainerWidth] = useState(850);
  const [useFallbackIframe, setUseFallbackIframe] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Monitor container width responsively
  useEffect(() => {
    if (!containerRef.current) return;
    const update = () => {
      if (containerRef.current && containerRef.current.clientWidth > 100) {
        setContainerWidth(containerRef.current.clientWidth);
      }
    };
    update();
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 100) {
          setContainerWidth(Math.round(entry.contentRect.width));
        }
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [isFull]);

  // Load PDF document once per src
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setUseFallbackIframe(false);
    setPdfDoc(null);
    setNumPages(0);

    (async () => {
      try {
        const pdfjs = await browserPdfJs();

        let doc: any = null;

        // Try fetching arrayBuffer first for maximum compatibility
        try {
          const res = await fetch(src, { credentials: "same-origin" });
          if (res.ok) {
            const buffer = await res.arrayBuffer();
            if (!cancelled) {
              doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
            }
          }
        } catch {
          // fetch error; will try direct URL
        }

        if (!doc && !cancelled) {
          doc = await pdfjs.getDocument({
            url: src,
            withCredentials: true,
          }).promise;
        }

        if (cancelled || !doc) return;
        setPdfDoc(doc);
        setNumPages(doc.numPages);
        setLoading(false);
      } catch (err: any) {
        if (!cancelled) {
          console.warn("[CvFrame] PDF.js failed, falling back to iframe:", err);
          setUseFallbackIframe(true);
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [src]);

  // Handle Fullscreen events
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFull(document.fullscreenElement === containerRef.current);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (containerRef.current) {
        await containerRef.current.requestFullscreen();
      }
    } catch {
      setIsFull((prev) => !prev);
    }
  };

  const iframeUrl = `${src.split("#")[0]}#toolbar=0&navpanes=0&view=FitH`;

  return (
    <div
      ref={containerRef}
      className={`flex flex-col ${
        isFull
          ? "fixed inset-0 z-50 h-screen w-screen overflow-y-auto bg-slate-900 p-4"
          : "w-full bg-paper"
      }`}
    >
      {/* Top action bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule bg-paper px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[12.5px] font-semibold text-ink">
            {fileName ?? title}
          </span>
          {numPages > 1 && (
            <span className="rounded-full bg-tag px-2 py-0.5 text-[11px] font-medium text-ink-soft">
              {numPages} pages
            </span>
          )}
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={toggleFullscreen}
            className="flex items-center gap-1.5 rounded-full border border-rule bg-surface px-3 py-1 text-[12px] font-medium text-ink transition-colors hover:bg-tag hover:text-brand"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              {isFull ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              )}
            </svg>
            {isFull ? "Exit full screen" : "Full screen"}
          </button>

          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="rounded-full border border-rule bg-surface px-3 py-1 text-[12px] text-ink-soft transition-colors hover:bg-tag hover:text-ink"
          >
            Open in a new tab
          </a>

          {downloadHref && (
            <a
              href={downloadHref}
              className="rounded-full border border-rule bg-surface px-3 py-1 text-[12px] text-ink-soft transition-colors hover:bg-tag hover:text-ink"
            >
              Download
            </a>
          )}

          {preparedCvHref && (
            <a
              href={preparedCvHref}
              target="_blank"
              rel="noreferrer"
              title="The Career141 version, with the green block on page one"
              className="rounded-full border border-rule bg-surface px-3 py-1 text-[12px] text-ink-soft transition-colors hover:bg-tag hover:text-ink"
            >
              Prepared CV
            </a>
          )}
        </div>
      </div>

      {/* Document View - exact page heights with zero empty space */}
      <div
        className={`w-full ${
          isFull ? "mx-auto max-w-5xl flex-1 py-4" : "py-3"
        }`}
      >
        {loading && (
          <div className="flex min-h-[300px] flex-col items-center justify-center bg-paper py-16 text-center">
            <div className="flex items-center gap-2 rounded-full border border-rule bg-surface px-4 py-2 text-[12.5px] font-medium text-ink shadow-xs">
              <svg className="h-4 w-4 animate-spin text-brand" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
              {/* A Word CV is converted to PDF first, which takes a few seconds (1 Oct). */}
              <span>{/\.(docx?|rtf|odt)$/i.test(fileName ?? "") ? "Preparing the Word CV… this can take a few seconds" : "Loading document…"}</span>
            </div>
          </div>
        )}

        {useFallbackIframe ? (
          <iframe
            key={iframeUrl}
            src={iframeUrl}
            title={title}
            className="w-full border-0 bg-white"
            style={{
              height: isFull ? "calc(100vh - 80px)" : "1000px",
              minHeight: "600px",
            }}
          />
        ) : (
          pdfDoc && (
            <div className="flex flex-col items-center gap-4 px-2">
              {Array.from({ length: numPages }, (_, i) => i + 1).map((pageNum) => (
                <PdfPageCanvas
                  key={`${src}-${pageNum}`}
                  doc={pdfDoc}
                  pageNum={pageNum}
                  numPages={numPages}
                  containerWidth={isFull ? Math.min(1100, containerWidth) : containerWidth}
                />
              ))}
            </div>
          )
        )}
      </div>
    </div>
  );
}
