"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Clean, full-height CV document viewer.
 *
 * - Renders the CV at full width and full document height.
 * - Completely removes the nested internal scrollbar by clipping the overflow.
 * - Provides a "Full screen" mode for distraction-free reading.
 */
export function CvFrame({
  src,
  title,
  fileName,
  downloadHref,
  preparedCvHref,
  height = 2600,
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
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setLoading(true);
    // PDF plugin inside iframe might not always dispatch standard DOM onLoad event
    const timer = setTimeout(() => setLoading(false), 1200);
    return () => clearTimeout(timer);
  }, [src]);

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

  const url = `${src.split("#")[0]}#toolbar=0&navpanes=0&view=FitH`;

  return (
    <div
      ref={containerRef}
      className={`flex flex-col bg-paper ${
        isFull
          ? "fixed inset-0 z-50 h-screen w-screen overflow-y-auto bg-slate-900 p-4"
          : "w-full overflow-hidden"
      }`}
    >
      {/* Top action bar with Full screen and document actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule bg-paper px-4 py-2.5">
        <span className="text-[12.5px] font-medium text-ink">
          {fileName ?? title}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={toggleFullscreen}
            className="flex items-center gap-1.5 rounded-full border border-rule bg-surface px-3.5 py-1.5 text-[12px] font-medium text-ink transition-colors hover:bg-tag hover:text-brand"
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
            className="rounded-full border border-rule bg-surface px-3.5 py-1.5 text-[12px] text-ink-soft transition-colors hover:bg-tag hover:text-ink"
          >
            Open in a new tab
          </a>
          {downloadHref && (
            <a
              href={downloadHref}
              className="rounded-full border border-rule bg-surface px-3.5 py-1.5 text-[12px] text-ink-soft transition-colors hover:bg-tag hover:text-ink"
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
              className="rounded-full border border-rule bg-surface px-3.5 py-1.5 text-[12px] text-ink-soft transition-colors hover:bg-tag hover:text-ink"
            >
              Prepared CV
            </a>
          )}
        </div>
      </div>

      {/* CV Iframe with clean scroll and responsive viewport */}
      <div
        className={`w-full bg-paper ${
          isFull ? "mx-auto max-w-5xl flex-1 rounded-xl shadow-2xl" : ""
        }`}
      >
        <div className="relative w-full" style={{ width: "100%" }}>
          {loading && (
            <div className="pointer-events-none absolute inset-0 z-10 flex min-h-[300px] flex-col items-center justify-center bg-paper/90 py-16 text-center backdrop-blur-xs transition-opacity duration-300">
              <div className="flex items-center gap-2 rounded-full border border-rule bg-surface px-4 py-2 text-[12.5px] font-medium text-ink shadow-xs">
                <svg className="h-4 w-4 animate-spin text-brand" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                <span>Loading document…</span>
              </div>
            </div>
          )}
          <iframe
            key={url}
            src={url}
            title={title}
            onLoad={() => setLoading(false)}
            className="w-full border-0 bg-paper"
            style={{
              height: isFull ? "calc(100vh - 80px)" : typeof height === "number" ? `${height}px` : height,
              minHeight: isFull ? "calc(100vh - 80px)" : "760px",
            }}
          />
        </div>
      </div>
    </div>
  );
}
