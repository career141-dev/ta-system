"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A CV in the page, with the controls a reader needs.
 *
 * It was a bare iframe of fixed height inside a sheet that already covered
 * the screen: one compressed page at a time, no way to enlarge it short of a
 * new tab, and no way to put it away (testing, 21 Sep). This adds zoom, fit to
 * width / whole page, full screen and minimise. The browser's PDF viewer reads
 * the zoom from the address fragment (`#zoom=`, `#view=`), so a change reloads
 * the frame at that size. The last choice is remembered on this device.
 */
const ZOOMS = [50, 75, 100, 125, 150, 200];
const KEY = "cv-frame";

type Fit = "width" | "page" | number;

function remembered(): { fit: Fit; minimised: boolean } {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (raw && (raw.fit === "width" || raw.fit === "page" || ZOOMS.includes(raw.fit))) {
      return { fit: raw.fit, minimised: Boolean(raw.minimised) };
    }
  } catch {
    /* private window or blocked storage: the defaults */
  }
  return { fit: "width", minimised: false };
}

export function CvFrame({ src, title, height = 720 }: { src: string; title: string; height?: number }) {
  const [fit, setFit] = useState<Fit>("width");
  const [minimised, setMinimised] = useState(false);
  const [full, setFull] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const r = remembered();
    setFit(r.fit);
    setMinimised(r.minimised);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify({ fit, minimised }));
    } catch {
      /* not remembered, still works */
    }
  }, [fit, minimised]);
  useEffect(() => {
    const on = () => setFull(document.fullscreenElement === box.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  const fragment = fit === "width" ? "view=FitH" : fit === "page" ? "view=Fit" : `zoom=${fit}`;
  const url = `${src.split("#")[0]}#toolbar=1&${fragment}`;
  const zoomIndex = typeof fit === "number" ? ZOOMS.indexOf(fit) : ZOOMS.indexOf(100);
  const step = (d: 1 | -1) => setFit(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, zoomIndex + d))]);

  const toggleFull = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await box.current?.requestFullscreen();
    } catch {
      /* the browser refused; the page stays as it is */
    }
  };

  const btn = (active = false) =>
    `rounded-md px-2 py-1 text-[12px] transition-colors ${active ? "bg-brand-soft font-medium text-brand" : "text-ink-soft hover:bg-tag hover:text-ink"}`;

  return (
    <div ref={box} className={`flex flex-col bg-paper ${full ? "h-screen" : ""}`}>
      <div className="flex flex-wrap items-center gap-1 border-b border-rule bg-surface px-2 py-1.5">
        {!minimised && (
          <>
            <button type="button" onClick={() => step(-1)} className={btn()} aria-label="Zoom out" disabled={zoomIndex === 0 && typeof fit === "number"}>
              −
            </button>
            <span className="min-w-[44px] text-center text-[11.5px] tabular-nums text-ink-soft">
              {typeof fit === "number" ? `${fit}%` : fit === "width" ? "Width" : "Page"}
            </span>
            <button type="button" onClick={() => step(1)} className={btn()} aria-label="Zoom in">
              +
            </button>
            <span className="mx-1 h-4 w-px bg-rule" aria-hidden="true" />
            <button type="button" onClick={() => setFit("width")} className={btn(fit === "width")}>
              Fit width
            </button>
            <button type="button" onClick={() => setFit("page")} className={btn(fit === "page")}>
              Whole page
            </button>
            <button type="button" onClick={toggleFull} className={btn(full)}>
              {full ? "Exit full screen" : "Full screen"}
            </button>
          </>
        )}
        <button type="button" onClick={() => setMinimised((v) => !v)} className={`${btn()} ml-auto`}>
          {minimised ? "Show CV" : "Minimise"}
        </button>
      </div>
      {!minimised && (
        <iframe
          key={url}
          src={url}
          title={title}
          className="w-full flex-1 bg-paper"
          style={full ? undefined : { height }}
        />
      )}
    </div>
  );
}
