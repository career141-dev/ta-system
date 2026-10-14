"use client";

import { useState, useTransition, useRef } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { submitFeedbackAction, uploadFeedbackScreenshotAction } from "@/app/actions";
import type { FeedbackCategory, FeedbackPriority } from "@/data/types";

export function FeedbackWidget({ isTa = true }: { isTa?: boolean } = {}) {
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [screenshotFile, setScreenshotFile] = useState<File | null>(null);
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null);
  const [screenshotName, setScreenshotName] = useState<string | null>(null);
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pathname = usePathname();

  // Extract opening ID if currently on an opening route
  const openingMatch = pathname.match(/\/openings\/([^/?#]+)/);
  const openingId = openingMatch ? openingMatch[1] : undefined;

  // Process image file
  const processImageFile = (file: File) => {
    const MAX_BYTES = 3 * 1024 * 1024; // 3 MB
    if (file.size > MAX_BYTES) {
      setErrorMessage("Screenshot file size must be under 3 MB. Please choose a smaller image.");
      return;
    }
    if (!file.type.startsWith("image/")) {
      setErrorMessage("Please select a valid image file (PNG, JPG, WebP, GIF).");
      return;
    }
    if (screenshotPreview) URL.revokeObjectURL(screenshotPreview);
    setScreenshotFile(file);
    setScreenshotPreview(URL.createObjectURL(file));
    setScreenshotName(file.name || "screenshot.png");
    setErrorMessage(null);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processImageFile(file);
  };

  // Support pasting image from clipboard (Ctrl+V)
  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        const file = items[i].getAsFile();
        if (file) {
          processImageFile(file);
          break;
        }
      }
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    const finalDescription = description.trim();
    if (!finalDescription) {
      setErrorMessage("Please describe the feedback or issue in detail.");
      return;
    }

    const firstLine = finalDescription.split("\n")[0].trim();
    const finalTitle = (firstLine.length > 70 ? `${firstLine.slice(0, 67)}...` : firstLine) || "TA Feedback";
    const finalCategory: FeedbackCategory = "other";
    const finalPriority: FeedbackPriority = "medium";

    // Don't attach page URL if on the feedback desk itself
    const currentUrl =
      pathname === "/feedback"
        ? undefined
        : typeof window !== "undefined"
        ? window.location.pathname + window.location.search
        : pathname;

    startTransition(async () => {
      try {
        let uploadedStorageId: string | undefined = undefined;
        if (screenshotFile) {
          const fd = new FormData();
          fd.append("file", screenshotFile);
          const uploadRes = await uploadFeedbackScreenshotAction(fd);
          if (!uploadRes.ok) {
            setErrorMessage(uploadRes.message);
            return;
          }
          uploadedStorageId = uploadRes.storageId;
        }

        const res = await submitFeedbackAction({
          category: finalCategory,
          priority: finalPriority,
          title: finalTitle,
          description: finalDescription,
          pageUrl: currentUrl,
          openingId,
          screenshot: uploadedStorageId,
        });

        if (res.ok) {
          setSubmittedId(res.id);
          setDescription("");
          if (screenshotPreview) URL.revokeObjectURL(screenshotPreview);
          setScreenshotFile(null);
          setScreenshotPreview(null);
          setScreenshotName(null);
        } else {
          setErrorMessage(res.message);
        }
      } catch (err: unknown) {
        setErrorMessage(err instanceof Error ? err.message : "Failed to submit feedback.");
      }
    });
  };

  const handleReset = () => {
    setSubmittedId(null);
    setErrorMessage(null);
    if (screenshotPreview) URL.revokeObjectURL(screenshotPreview);
    setScreenshotFile(null);
    setScreenshotPreview(null);
    setScreenshotName(null);
    setOpen(false);
  };

  return (
    <>
      {/* Floating Trigger Pill */}
      {!open && (
        <button
          onClick={() => {
            setSubmittedId(null);
            setErrorMessage(null);
            setOpen(true);
          }}
          className="fixed bottom-5 right-24 z-40 flex items-center gap-1.5 rounded-full border border-rule bg-surface px-3.5 py-2 text-[12.5px] font-medium text-ink-soft shadow-[0_2px_10px_rgba(23,28,24,0.08)] transition-all hover:border-brand-line hover:text-brand hover:shadow-md"
          aria-label="Send Feedback or Report Bug"
          title="Submit feedback or report an issue"
        >
          <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 3h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5l-3 3V4a1 1 0 0 1 1-1z" />
            <path d="M8 6v2M8 10h.01" />
          </svg>
          Feedback
        </button>
      )}

      {/* Modal Dialog */}
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs animate-in fade-in duration-150">
          <div
            className="flex max-h-[90vh] w-full max-w-[540px] flex-col overflow-hidden rounded-2xl border border-rule bg-surface shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-dialog-title"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-rule px-5 py-4">
              <div>
                <h2 id="feedback-dialog-title" className="text-[16px] font-semibold text-ink">
                  TA Feedback & Support
                </h2>
                <p className="text-[12px] text-ink-faint">
                  Reviewed by TA Lead, then escalated directly to Admin / Engineering.
                </p>
              </div>
              <button
                onClick={handleReset}
                className="grid h-8 w-8 place-items-center rounded-lg text-ink-faint transition-colors hover:bg-paper hover:text-ink"
                aria-label="Close"
              >
                <svg width={16} height={16} viewBox="0 0 16 16" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" fill="none">
                  <path d="M4 4l8 8M12 4l-8 8" />
                </svg>
              </button>
            </div>

            {/* Content / Form */}
            {submittedId ? (
              <div className="flex flex-col items-center justify-center p-8 text-center">
                <div className="mb-3.5 grid h-12 w-12 place-items-center rounded-full bg-ok/10 text-ok">
                  <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </div>
                <h3 className="text-[16px] font-semibold text-ink">Feedback Submitted!</h3>
                <p className="mt-1.5 max-w-sm text-[13px] text-ink-soft">
                  {isTa ? (
                    <>
                      Your submission has been sent to the <span className="font-semibold text-ink">TA Lead Review Queue</span>. Once reviewed and endorsed, it will be prioritized for Admin action.
                    </>
                  ) : (
                    <>
                      Your submission has been escalated directly to the <span className="font-semibold text-ink">Admin Queue</span> for prioritization and action.
                    </>
                  )}
                </p>
                <div className="mt-6 flex flex-wrap items-center justify-center gap-2.5">
                  {!isTa && (
                    <Link
                      href="/feedback"
                      onClick={handleReset}
                      className="rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
                    >
                      View Feedback Desk
                    </Link>
                  )}
                  <button
                    onClick={() => {
                      setSubmittedId(null);
                    }}
                    className="rounded-lg border border-rule bg-paper px-4 py-2 text-[13px] font-medium text-ink transition-colors hover:bg-surface"
                  >
                    Submit Another
                  </button>
                  {isTa && (
                    <button
                      onClick={handleReset}
                      className="rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
                    >
                      Done
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmit} onPaste={handlePaste} className="flex flex-1 flex-col overflow-y-auto px-5 py-4">
                {errorMessage && (
                  <div className="mb-4 rounded-lg border border-danger/20 bg-danger/10 px-3.5 py-2.5 text-[12.5px] text-danger">
                    {errorMessage}
                  </div>
                )}

                {/* Description */}
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-1.5">
                    <label htmlFor="fb-desc" className="block text-[12.5px] font-semibold text-ink">
                      Details & Steps
                    </label>
                    <span className="text-[11px] text-ink-faint">Tip: You can paste a screenshot with Ctrl+V</span>
                  </div>
                  <textarea
                    id="fb-desc"
                    required
                    rows={5}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe what happened, what you expected, candidate or opening names involved..."
                    className="w-full resize-none rounded-lg border border-rule bg-paper p-3 text-[13px] text-ink outline-none transition-colors placeholder:text-ink-faint focus:border-brand focus:bg-surface"
                  />
                </div>

                {/* Screenshot Attachment Option */}
                <div className="mb-4">
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[12.5px] font-semibold text-ink">
                      Attach Screenshot (optional)
                    </label>
                  </div>

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleFileChange}
                    className="hidden"
                  />

                  {screenshotPreview ? (
                    <div className="relative flex items-center gap-3 rounded-lg border border-rule bg-paper p-2.5">
                      <div className="relative h-14 w-20 shrink-0 overflow-hidden rounded border border-rule bg-surface">
                        <Image
                          src={screenshotPreview}
                          alt="Screenshot Preview"
                          fill
                          unoptimized
                          className="object-cover"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-medium text-ink">
                          {screenshotName || "Screenshot attached"}
                        </p>
                        <p className="text-[11px] text-ok font-medium">Ready to submit with report</p>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          if (screenshotPreview) URL.revokeObjectURL(screenshotPreview);
                          setScreenshotFile(null);
                          setScreenshotPreview(null);
                          setScreenshotName(null);
                          if (fileInputRef.current) fileInputRef.current.value = "";
                        }}
                        className="grid h-7 w-7 place-items-center rounded-md text-ink-faint hover:bg-surface hover:text-danger"
                        title="Remove screenshot"
                      >
                        <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2}>
                          <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                        </svg>
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-rule bg-paper/50 py-2.5 text-[12.5px] font-medium text-ink-soft transition-colors hover:border-brand-line hover:bg-brand/5 hover:text-brand"
                    >
                      <svg width={15} height={15} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
                        <rect x="2" y="2" width="12" height="12" rx="2" />
                        <circle cx="5.5" cy="5.5" r="1.5" />
                        <path d="M14 10l-4-4-6 6" />
                      </svg>
                      Click to upload image or paste from clipboard
                    </button>
                  )}
                </div>

                {/* Actions */}
                <div className="mt-auto flex items-center justify-end gap-2.5 border-t border-rule pt-4">
                  <button
                    type="button"
                    onClick={handleReset}
                    className="rounded-lg px-4 py-2 text-[13px] font-medium text-ink-soft transition-colors hover:bg-paper hover:text-ink"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={isPending || !description.trim()}
                    className="flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-95 disabled:opacity-40"
                  >
                    {isPending ? (
                      <>
                        <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        Submitting...
                      </>
                    ) : (
                      "Submit Feedback"
                    )}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </>
  );
}
