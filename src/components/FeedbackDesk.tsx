"use client";

import { useState, useEffect, useTransition, useMemo, useRef } from "react";
import Link from "next/link";
import {
  leadReviewFeedbackAction,
  adminUpdateFeedbackAction,
  submitFeedbackAction,
  uploadFeedbackScreenshotAction,
  markFeedbackSeenAction,
  markFeedbacksReadAction,
  deleteFeedbacksAction,
} from "@/app/actions";
import type { FeedbackCategory, FeedbackPriority, FeedbackStatus, FeedbackItem, User } from "@/data/types";
import {
  FEEDBACK_STATUS_LABEL,
} from "@/data/types";
import { dateAt } from "@/lib/format";
import { isTa } from "@/lib/auth";

interface FeedbackDeskProps {
  initialFeedbacks: FeedbackItem[];
  currentUser: User;
}

export function FeedbackDesk({ initialFeedbacks, currentUser }: FeedbackDeskProps) {
  const [feedbacks, setFeedbacks] = useState<FeedbackItem[]>(initialFeedbacks);

  useEffect(() => {
    markFeedbackSeenAction().catch(() => {});
  }, []);

  const [activeTab, setActiveTab] = useState<"lead_queue" | "admin_queue" | "resolved_closed" | "my_submissions" | "all">(
    currentUser.role === "ta_lead" || currentUser.role === "director"
      ? "lead_queue"
      : currentUser.role === "admin"
      ? "admin_queue"
      : "my_submissions"
  );

  // Filters
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Lead Review Modal state
  const [leadModalItem, setLeadModalItem] = useState<FeedbackItem | null>(null);
  const [leadDecision, setLeadDecision] = useState<"approved_for_admin" | "resolved_by_lead" | "declined_by_lead">("approved_for_admin");
  const [leadNotes, setLeadNotes] = useState("");

  // Admin Update Modal state
  const [adminModalItem, setAdminModalItem] = useState<FeedbackItem | null>(null);
  const [adminStatus, setAdminStatus] = useState<"in_progress" | "resolved" | "declined_by_admin">("in_progress");
  const [adminResolution, setAdminResolution] = useState("");

  // Submit New Feedback Modal
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [newDescription, setNewDescription] = useState("");
  const [newScreenshotFile, setNewScreenshotFile] = useState<File | null>(null);
  const [newScreenshotPreview, setNewScreenshotPreview] = useState<string | null>(null);
  const [newScreenshotName, setNewScreenshotName] = useState<string | null>(null);

  // Screenshot Zoom Modal
  const [viewScreenshotUrl, setViewScreenshotUrl] = useState<string | null>(null);

  const [isPending, startTransition] = useTransition();
  const [actionError, setActionError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const isLead = currentUser.role === "ta_lead" || currentUser.role === "director";
  const isAdmin = currentUser.role === "admin" || currentUser.role === "director";
  const isTaUser = isTa(currentUser);

  // Summary counts
  const pendingLeadCount = useMemo(() => feedbacks.filter((f) => f.status === "pending_lead").length, [feedbacks]);
  const adminQueueCount = useMemo(
    () => feedbacks.filter((f) => f.status === "approved_for_admin" || f.status === "in_progress").length,
    [feedbacks]
  );
  const isMySubmission = (item: FeedbackItem) =>
    item.submittedBy === currentUser.id ||
    (!!currentUser.name && item.submittedByName?.toLowerCase() === currentUser.name.toLowerCase());

  const mySubmissionsCount = useMemo(
    () => feedbacks.filter(isMySubmission).length,
    [feedbacks, currentUser.id, currentUser.name]
  );
  const resolvedCount = useMemo(
    () => feedbacks.filter((f) => f.status === "resolved" || f.status === "resolved_by_lead").length,
    [feedbacks]
  );

  // Filtered feedbacks for current view
  const filteredFeedbacks = useMemo(() => {
    return feedbacks.filter((item) => {
      // Tab filter
      if (activeTab === "lead_queue") {
        if (item.status !== "pending_lead") return false;
      } else if (activeTab === "admin_queue") {
        if (item.status !== "approved_for_admin" && item.status !== "in_progress") return false;
      } else if (activeTab === "resolved_closed") {
        if (item.status !== "resolved" && item.status !== "declined_by_admin") return false;
      } else if (activeTab === "my_submissions") {
        if (!isMySubmission(item)) return false;
      }

      // Query filter
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchTitle = (item.title || "").toLowerCase().includes(q);
        const matchDesc = (item.description || "").toLowerCase().includes(q);
        const matchSubmitter = (item.submittedByName || "").toLowerCase().includes(q);
        if (!matchTitle && !matchDesc && !matchSubmitter) return false;
      }

      // Status filter
      if (statusFilter !== "all" && item.status !== statusFilter) return false;

      return true;
    });
  }, [feedbacks, activeTab, searchQuery, statusFilter, currentUser.id]);

  // Bulk selection state (mark as read, delete)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkPending, setIsBulkPending] = useState(false);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [activeTab]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allVisibleSelected =
    filteredFeedbacks.length > 0 &&
    filteredFeedbacks.every((f) => selectedIds.has(f.id));

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const f of filteredFeedbacks) next.delete(f.id);
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const f of filteredFeedbacks) next.add(f.id);
        return next;
      });
    }
  };

  const handleBulkMarkRead = async () => {
    if (selectedIds.size === 0) return;
    setIsBulkPending(true);
    try {
      const ids = Array.from(selectedIds);
      await markFeedbacksReadAction(ids);
      setSelectedIds(new Set());
    } catch {
      setActionError("Failed to mark feedback as read.");
    } finally {
      setIsBulkPending(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selectedIds.size === 0) return;
    const count = selectedIds.size;
    if (!window.confirm(`Are you sure you want to delete ${count} selected feedback ${count === 1 ? "item" : "items"}?`)) {
      return;
    }
    setIsBulkPending(true);
    try {
      const ids = Array.from(selectedIds);
      const res = await deleteFeedbacksAction(ids);
      if (res.ok) {
        setFeedbacks((prev) => prev.filter((f) => !selectedIds.has(f.id)));
        setSelectedIds(new Set());
      } else {
        setActionError(res.message || "Failed to delete feedback.");
      }
    } catch {
      setActionError("Failed to delete feedback.");
    } finally {
      setIsBulkPending(false);
    }
  };

  // Image upload handling for new feedback
  const processImageFile = (file: File) => {
    const MAX_BYTES = 3 * 1024 * 1024; // 3 MB
    if (file.size > MAX_BYTES) {
      setActionError("Screenshot file size must be under 3 MB. Please choose a smaller image.");
      return;
    }
    if (!file.type.startsWith("image/")) {
      setActionError("Please select a valid image file (PNG, JPG, WebP, GIF).");
      return;
    }
    if (newScreenshotPreview) URL.revokeObjectURL(newScreenshotPreview);
    setNewScreenshotFile(file);
    setNewScreenshotPreview(URL.createObjectURL(file));
    setNewScreenshotName(file.name || "screenshot.png");
    setActionError(null);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processImageFile(file);
  };

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

  // Handle TA Lead Action
  const handleLeadSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!leadModalItem) return;
    setActionError(null);

    startTransition(async () => {
      try {
        const res = await leadReviewFeedbackAction({
          feedbackId: leadModalItem.id,
          decision: leadDecision,
          leadNotes: leadNotes.trim() || undefined,
        });

        if (res.ok) {
          setFeedbacks((prev) =>
            prev.map((f) =>
              f.id === leadModalItem.id
                ? {
                    ...f,
                    status: leadDecision,
                    leadReviewedBy: currentUser.id,
                    leadReviewedByName: currentUser.name || "TA Lead",
                    leadReviewedAt: Date.now(),
                    leadNotes: leadNotes.trim() || undefined,
                    resolvedAt: leadDecision === "resolved_by_lead" ? Date.now() : undefined,
                  }
                : f
            )
          );
          setLeadModalItem(null);
          setLeadNotes("");
        } else {
          setActionError(res.message);
        }
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : "Failed to submit review.");
      }
    });
  };

  // Handle Admin Action
  const handleAdminSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!adminModalItem) return;
    setActionError(null);

    startTransition(async () => {
      try {
        const res = await adminUpdateFeedbackAction({
          feedbackId: adminModalItem.id,
          status: adminStatus,
          adminResolution: adminResolution.trim() || undefined,
        });

        if (res.ok) {
          setFeedbacks((prev) =>
            prev.map((f) =>
              f.id === adminModalItem.id
                ? {
                    ...f,
                    status: adminStatus,
                    adminReviewedBy: currentUser.id,
                    adminReviewedByName: currentUser.name || "Admin",
                    adminReviewedAt: Date.now(),
                    adminResolution: adminResolution.trim() || undefined,
                    resolvedAt: adminStatus === "resolved" ? Date.now() : undefined,
                  }
                : f
            )
          );
          setAdminModalItem(null);
          setAdminResolution("");
        } else {
          setActionError(res.message);
        }
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : "Failed to update status.");
      }
    });
  };

  // Handle New Submission from Desk
  const handleNewSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    const finalDesc = newDescription.trim();
    if (!finalDesc) {
      setActionError("Please provide a description of the issue.");
      return;
    }
    const firstLine = finalDesc.split("\n")[0].trim();
    const finalTitle = (firstLine.length > 70 ? `${firstLine.slice(0, 67)}...` : firstLine) || "TA Feedback";
    const finalCategory: FeedbackCategory = "other";
    const finalPriority: FeedbackPriority = "medium";

    startTransition(async () => {
      try {
        let uploadedStorageId: string | undefined = undefined;
        if (newScreenshotFile) {
          const fd = new FormData();
          fd.append("file", newScreenshotFile);
          const uploadRes = await uploadFeedbackScreenshotAction(fd);
          if (!uploadRes.ok) {
            setActionError(uploadRes.message);
            return;
          }
          uploadedStorageId = uploadRes.storageId;
        }

        const res = await submitFeedbackAction({
          category: finalCategory,
          priority: finalPriority,
          title: finalTitle,
          description: finalDesc,
          screenshot: uploadedStorageId,
        });

        if (res.ok) {
          const newItem: FeedbackItem = {
            id: res.id,
            submittedBy: currentUser.id,
            submittedByName: currentUser.name || "Anonymous",
            submittedByRole: currentUser.role,
            createdAt: Date.now(),
            category: finalCategory,
            priority: finalPriority,
            title: finalTitle,
            description: finalDesc,
            pageUrl: "",
            screenshot: uploadedStorageId,
            status: "pending_lead",
          };
          setFeedbacks((prev) => [newItem, ...prev]);
          setShowSubmitModal(false);
          setNewDescription("");
          if (newScreenshotPreview) URL.revokeObjectURL(newScreenshotPreview);
          setNewScreenshotFile(null);
          setNewScreenshotPreview(null);
          setNewScreenshotName(null);
        } else {
          setActionError(res.message);
        }
      } catch (err: unknown) {
        setActionError(err instanceof Error ? err.message : "Submission failed.");
      }
    });
  };

  return (
    <div className="space-y-6">
      {/* Metrics Row */}
      <div className="grid grid-cols-2 gap-3.5 sm:grid-cols-4">
        <div className="rounded-xl border border-rule bg-surface p-4 shadow-xs">
          <p className="text-[12px] font-medium text-ink-faint">My Submissions</p>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-[22px] font-bold text-ink">{mySubmissionsCount}</span>
            <span className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">Tracked</span>
          </div>
        </div>

        <div className="rounded-xl border border-rule bg-surface p-4 shadow-xs">
          <p className="text-[12px] font-medium text-ink-faint">Awaiting Lead Review</p>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-[22px] font-bold text-amber-600">{pendingLeadCount}</span>
            {pendingLeadCount > 0 ? (
              <span className="animate-pulse rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-700">
                Action Required
              </span>
            ) : (
              <span className="rounded-full bg-paper px-2 py-0.5 text-[11px] text-ink-faint">Clear</span>
            )}
          </div>
        </div>

        <div className="rounded-xl border border-rule bg-surface p-4 shadow-xs">
          <p className="text-[12px] font-medium text-ink-faint">Admin Action Queue</p>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-[22px] font-bold text-blue-600">{adminQueueCount}</span>
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-medium text-blue-600">Approved</span>
          </div>
        </div>

        <div className="rounded-xl border border-rule bg-surface p-4 shadow-xs">
          <p className="text-[12px] font-medium text-ink-faint">Total Resolved</p>
          <div className="mt-1 flex items-baseline justify-between">
            <span className="text-[22px] font-bold text-ok">{resolvedCount}</span>
            <span className="rounded-full bg-ok/10 px-2 py-0.5 text-[11px] font-medium text-ok">Completed</span>
          </div>
        </div>
      </div>

      {/* Tabs & New Feedback Button */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {isLead && (
            <button
              onClick={() => setActiveTab("lead_queue")}
              className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors ${
                activeTab === "lead_queue"
                  ? "bg-brand text-white shadow-xs"
                  : "border border-rule bg-surface text-ink-soft hover:bg-paper hover:text-ink"
              }`}
            >
              <span>Awaiting Lead Review</span>
              {pendingLeadCount > 0 && (
                <span
                  className={`grid h-5 min-w-[20px] place-items-center rounded-full px-1 text-[11px] font-bold ${
                    activeTab === "lead_queue" ? "bg-white text-brand" : "bg-amber-500 text-white"
                  }`}
                >
                  {pendingLeadCount}
                </span>
              )}
            </button>
          )}

          {isAdmin && (
            <button
              onClick={() => setActiveTab("admin_queue")}
              className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors ${
                activeTab === "admin_queue"
                  ? "bg-brand text-white shadow-xs"
                  : "border border-rule bg-surface text-ink-soft hover:bg-paper hover:text-ink"
              }`}
            >
              <span>Admin Queue</span>
              {adminQueueCount > 0 && (
                <span
                  className={`grid h-5 min-w-[20px] place-items-center rounded-full px-1 text-[11px] font-bold ${
                    activeTab === "admin_queue" ? "bg-white text-brand" : "bg-blue-600 text-white"
                  }`}
                >
                  {adminQueueCount}
                </span>
              )}
            </button>
          )}

          {currentUser.role === "admin" && (
            <button
              onClick={() => setActiveTab("resolved_closed")}
              className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors ${
                activeTab === "resolved_closed"
                  ? "bg-brand text-white shadow-xs"
                  : "border border-rule bg-surface text-ink-soft hover:bg-paper hover:text-ink"
              }`}
            >
              <span>Resolved & Closed</span>
            </button>
          )}

          <button
            onClick={() => setActiveTab("my_submissions")}
            className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors ${
              activeTab === "my_submissions"
                ? "bg-brand text-white shadow-xs"
                : "border border-rule bg-surface text-ink-soft hover:bg-paper hover:text-ink"
            }`}
          >
            <span>My Submissions</span>
            <span
              className={`grid h-5 min-w-[20px] place-items-center rounded-full px-1 text-[11px] ${
                activeTab === "my_submissions" ? "bg-white/20 text-white" : "bg-paper text-ink-faint"
              }`}
            >
              {mySubmissionsCount}
            </span>
          </button>

          {(isLead || isAdmin) && (
            <button
              onClick={() => setActiveTab("all")}
              className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-medium transition-colors ${
                activeTab === "all"
                  ? "bg-brand text-white shadow-xs"
                  : "border border-rule bg-surface text-ink-soft hover:bg-paper hover:text-ink"
              }`}
            >
              <span>{currentUser.role === "admin" ? "All Approved" : "All Feedback"}</span>
            </button>
          )}
        </div>

        <button
          onClick={() => {
            setActionError(null);
            setShowSubmitModal(true);
          }}
          className="flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white shadow-xs transition-all hover:opacity-95"
        >
          <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <path d="M8 3v10M3 8h10" />
          </svg>
          Submit Feedback
        </button>
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-rule bg-surface p-3 shadow-xs">
        {filteredFeedbacks.length > 0 && (
          <label className="flex items-center gap-2 pr-1 text-[12.5px] font-medium text-ink-soft cursor-pointer hover:text-ink select-none">
            <input
              type="checkbox"
              checked={allVisibleSelected}
              onChange={toggleSelectAll}
              className="h-4 w-4 rounded border-rule text-brand focus:ring-brand cursor-pointer accent-brand"
              aria-label="Select all feedback items"
            />
            <span className="hidden sm:inline">Select All</span>
          </label>
        )}

        <div className="relative w-full sm:w-80">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint">
            <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5L14 14" strokeLinecap="round" />
            </svg>
          </span>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search feedback by keyword, title, or submitter..."
            className="w-full rounded-lg border border-rule bg-paper py-1.5 pl-8 pr-3 text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:border-brand focus:bg-surface"
          />
        </div>

        {activeTab === "all" || activeTab === "my_submissions" ? (
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-rule bg-paper px-3 py-1.5 text-[12.5px] text-ink outline-none focus:border-brand"
          >
            <option value="all">All Statuses</option>
            {(Object.keys(FEEDBACK_STATUS_LABEL) as FeedbackStatus[]).map((st) => (
              <option key={st} value={st}>
                {FEEDBACK_STATUS_LABEL[st]}
              </option>
            ))}
          </select>
        ) : null}

        {(searchQuery || statusFilter !== "all") && (
          <button
            onClick={() => {
              setSearchQuery("");
              setStatusFilter("all");
            }}
            className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-ink-soft hover:bg-paper hover:text-ink"
          >
            Reset Filters
          </button>
        )}

        {selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
            <span className="text-[12px] font-semibold text-brand">
              {selectedIds.size} selected
            </span>
            <button
              onClick={handleBulkMarkRead}
              disabled={isBulkPending}
              className="flex items-center gap-1.5 rounded-lg border border-rule bg-paper px-2.5 py-1.5 text-[12px] font-medium text-ink hover:bg-surface hover:border-brand disabled:opacity-50 transition-colors cursor-pointer"
              title="Mark selected as read"
            >
              <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8}>
                <path d="M2.5 8.5l3.5 3.5 7.5-8" />
              </svg>
              Mark as Read
            </button>
            {(isLead || isAdmin) && (
              <button
                onClick={handleBulkDelete}
                disabled={isBulkPending}
                className="flex items-center gap-1.5 rounded-lg border border-danger/20 bg-danger/10 px-2.5 py-1.5 text-[12px] font-medium text-danger hover:bg-danger/15 disabled:opacity-50 transition-colors cursor-pointer"
                title="Delete selected feedback"
              >
                <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8}>
                  <path d="M3 4h10M6 4V2.5a.5.5 0 0 1 .5-.5h3a.5.5 0 0 1 .5.5V4M5 4v9a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4" />
                </svg>
                Delete
              </button>
            )}
          </div>
        )}
      </div>

      {/* Main List / Cards */}
      {filteredFeedbacks.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-rule bg-surface/50 p-12 text-center">
          <div className="grid h-12 w-12 place-items-center rounded-full bg-paper text-ink-faint">
            <svg width={22} height={22} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
              <path d="M2 3h12a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H5l-3 3V4a1 1 0 0 1 1-1z" />
            </svg>
          </div>
          <p className="mt-3 text-[14px] font-medium text-ink">No feedback items found</p>
          <p className="mt-1 max-w-sm text-[12.5px] text-ink-soft">
            {activeTab === "lead_queue"
              ? "All submitted feedback has been reviewed by the TA Lead."
              : activeTab === "admin_queue"
              ? "No items currently pending Admin / Engineering action."
              : "No feedback matching the selected filters."}
          </p>
        </div>
      ) : (
        <div className="space-y-3.5">
          {filteredFeedbacks.map((item) => {
            const statusLabel = FEEDBACK_STATUS_LABEL[item.status] || item.status;
            const statusToneColors: Record<FeedbackStatus, string> = {
              pending_lead: "bg-amber-50 text-amber-800 border-amber-200",
              approved_for_admin: "bg-blue-50 text-blue-800 border-blue-200",
              resolved_by_lead: "bg-emerald-50 text-emerald-800 border-emerald-200",
              declined_by_lead: "bg-slate-100 text-slate-700 border-slate-200",
              in_progress: "bg-purple-50 text-purple-800 border-purple-200",
              resolved: "bg-emerald-50 text-emerald-800 border-emerald-200",
              declined_by_admin: "bg-rose-50 text-rose-800 border-rose-200",
            };

            const hasSpecificPage = !!item.pageUrl && item.pageUrl !== "/feedback" && item.pageUrl !== "/";

            return (
              <div
                key={item.id}
                className="overflow-hidden rounded-xl border border-rule bg-surface p-4.5 shadow-xs transition-all hover:border-rule-strong"
              >
                {/* Top Row: Checkbox, Status, Date */}
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rule/60 pb-3">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(item.id)}
                      onChange={() => toggleSelect(item.id)}
                      className="h-4 w-4 rounded border-rule text-brand focus:ring-brand cursor-pointer accent-brand"
                      aria-label={`Select feedback ${item.title}`}
                    />
                    <span
                      className={`rounded-md border px-2 py-0.5 text-[11.5px] font-medium ${
                        statusToneColors[item.status] || "bg-slate-100 text-slate-700 border-slate-200"
                      }`}
                    >
                      {statusLabel}
                    </span>
                  </div>

                  <span className="text-[11.5px] text-ink-faint">
                    Submitted {dateAt(item.createdAt)} by{" "}
                    <strong className="font-semibold text-ink-soft">{item.submittedByName}</strong>
                  </span>
                </div>

                {/* Title & Description */}
                <div className="mt-3">
                  <h3 className="text-[15px] font-semibold text-ink">{item.title}</h3>
                  <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-soft">
                    {item.description}
                  </p>
                </div>

                {/* Attached Screenshot thumbnail if present */}
                {item.screenshot && (
                  <div className="mt-3.5">
                    <button
                      type="button"
                      onClick={() =>
                        setViewScreenshotUrl(
                          item.screenshot?.startsWith("data:")
                            ? item.screenshot
                            : `/api/feedback/screenshot/${item.id}`
                        )
                      }
                      className="group relative flex items-center gap-3 rounded-lg border border-rule bg-paper/60 p-2 text-left transition-all hover:border-brand-line hover:bg-brand/5"
                    >
                      <div className="relative h-14 w-20 shrink-0 overflow-hidden rounded border border-rule bg-surface">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={
                            item.screenshot.startsWith("data:")
                              ? item.screenshot
                              : `/api/feedback/screenshot/${item.id}`
                          }
                          alt="Screenshot"
                          className="h-full w-full object-cover transition-transform group-hover:scale-105"
                        />
                      </div>
                      <div>
                        <span className="flex items-center gap-1.5 text-[12.5px] font-semibold text-ink group-hover:text-brand">
                          <svg width={14} height={14} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6}>
                            <rect x="2" y="2" width="12" height="12" rx="2" />
                            <circle cx="5.5" cy="5.5" r="1.5" />
                            <path d="M14 10l-4-4-6 6" />
                          </svg>
                          View Screenshot
                        </span>
                        <span className="text-[11px] text-ink-faint">Click to open full view</span>
                      </div>
                    </button>
                  </div>
                )}

                {/* Specific context tags (only if meaningful) */}
                {(hasSpecificPage || item.openingId) && (
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-ink-faint">
                    {hasSpecificPage && (
                      <span className="flex items-center gap-1 font-mono text-[11.5px] text-ink-soft">
                        <svg width={12} height={12} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5}>
                          <path d="M6 3H3a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" strokeLinecap="round" />
                          <path d="M9 2h5v5M14 2L8 8" strokeLinecap="round" />
                        </svg>
                        {item.pageUrl}
                      </span>
                    )}
                    {item.openingId && (
                      <Link
                        href={`/openings/${item.openingId}`}
                        className="rounded bg-brand/10 px-1.5 py-0.5 font-medium text-brand hover:underline"
                      >
                        View Opening →
                      </Link>
                    )}
                  </div>
                )}

                {/* Approval & Review Workflow History */}
                <div className="mt-4 grid gap-2.5 rounded-lg border border-rule/70 bg-paper/40 p-3 text-[12.5px]">
                  {/* Step 1: TA Lead Review Status */}
                  <div className="flex items-start gap-2.5">
                    <span
                      className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
                        item.leadReviewedAt
                          ? "bg-ok text-white"
                          : item.status === "pending_lead"
                          ? "bg-amber-500 text-white animate-pulse"
                          : "bg-paper text-ink-faint border border-rule"
                      }`}
                    >
                      1
                    </span>
                    <div className="flex-1">
                      <div className="flex flex-wrap items-center justify-between gap-1">
                        <span className="font-semibold text-ink">TA Lead Review Gate</span>
                        {item.leadReviewedAt && (
                          <span className="text-[11px] text-ink-faint">
                            Reviewed {dateAt(item.leadReviewedAt)} by {item.leadReviewedByName}
                          </span>
                        )}
                      </div>
                      {item.leadNotes ? (
                        <p className="mt-1 rounded bg-surface p-2 text-[12px] italic text-ink-soft border border-rule/50">
                          &ldquo;{item.leadNotes}&rdquo;
                        </p>
                      ) : (
                        <p className="mt-0.5 text-[11.5px] text-ink-faint">
                          {item.status === "pending_lead"
                            ? "Waiting for TA Lead endorsement before escalating to Admin..."
                            : "Approved without extra notes."}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Step 2: Admin Resolution Status */}
                  {(item.status === "approved_for_admin" ||
                    item.status === "in_progress" ||
                    item.status === "resolved" ||
                    item.status === "declined_by_admin") && (
                    <div className="flex items-start gap-2.5 border-t border-rule/50 pt-2.5">
                      <span
                        className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px] font-bold ${
                          item.status === "resolved"
                            ? "bg-ok text-white"
                            : item.status === "in_progress"
                            ? "bg-brand text-white"
                            : "bg-blue-600 text-white"
                        }`}
                      >
                        2
                      </span>
                      <div className="flex-1">
                        <div className="flex flex-wrap items-center justify-between gap-1">
                          <span className="font-semibold text-ink">Admin / Engineering Action</span>
                          {item.adminReviewedAt && (
                            <span className="text-[11px] text-ink-faint">
                              Updated {dateAt(item.adminReviewedAt)} by {item.adminReviewedByName}
                            </span>
                          )}
                        </div>
                        {item.adminResolution ? (
                          <p className="mt-1 rounded bg-surface p-2 text-[12px] text-ink font-medium border border-rule/50">
                            Resolution: {item.adminResolution}
                          </p>
                        ) : (
                          <p className="mt-0.5 text-[11.5px] text-ink-faint">
                            {item.status === "approved_for_admin"
                              ? "Queued in Admin roadmap. Waiting to be picked up."
                              : "Currently in progress with Admin."}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Action Buttons for Lead and Admin */}
                <div className="mt-3.5 flex flex-wrap items-center justify-end gap-2 border-t border-rule/60 pt-3">
                  {isLead && item.status === "pending_lead" && (
                    <button
                      onClick={() => {
                        setActionError(null);
                        setLeadModalItem(item);
                        setLeadDecision("approved_for_admin");
                        setLeadNotes("");
                      }}
                      className="rounded-lg bg-amber-600 px-3.5 py-1.5 text-[12.5px] font-semibold text-white shadow-xs transition-opacity hover:opacity-95"
                    >
                      Lead Review Action →
                    </button>
                  )}

                  {isAdmin &&
                    (item.status === "approved_for_admin" || item.status === "in_progress") && (
                      <button
                        onClick={() => {
                          setActionError(null);
                          setAdminModalItem(item);
                          setAdminStatus(item.status === "approved_for_admin" ? "in_progress" : "resolved");
                          setAdminResolution(item.adminResolution || "");
                        }}
                        className="rounded-lg bg-blue-600 px-3.5 py-1.5 text-[12.5px] font-semibold text-white shadow-xs transition-opacity hover:opacity-95"
                      >
                        Admin Action →
                      </button>
                    )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* TA Lead Review Modal */}
      {leadModalItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs">
          <div className="flex max-h-[90vh] w-full max-w-[500px] flex-col overflow-hidden rounded-2xl border border-rule bg-surface shadow-2xl">
            <div className="flex items-center justify-between border-b border-rule px-5 py-4">
              <div>
                <h3 className="text-[16px] font-semibold text-ink">TA Lead Feedback Review</h3>
                <p className="text-[12px] text-ink-faint">Decide whether to escalate this item to Admin or resolve it directly.</p>
              </div>
              <button
                onClick={() => setLeadModalItem(null)}
                className="grid h-8 w-8 place-items-center rounded-lg text-ink-faint hover:bg-paper"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleLeadSubmit} className="overflow-y-auto p-5 space-y-4">
              {actionError && (
                <div className="rounded-lg bg-danger/10 p-3 text-[12.5px] text-danger border border-danger/20">
                  {actionError}
                </div>
              )}

              <div className="rounded-lg border border-rule bg-paper p-3 text-[12.5px]">
                <p className="font-semibold text-ink">{leadModalItem.title}</p>
                <p className="mt-1 text-ink-soft text-[12px]">{leadModalItem.description}</p>
                <p className="mt-2 text-[11px] text-ink-faint">Submitted by {leadModalItem.submittedByName}</p>
              </div>

              <div>
                <label className="mb-1.5 block text-[12.5px] font-semibold text-ink">Decision</label>
                <div className="space-y-2">
                  <label className="flex items-start gap-2.5 rounded-lg border border-rule bg-surface p-3 cursor-pointer hover:bg-paper">
                    <input
                      type="radio"
                      name="lead-decision"
                      value="approved_for_admin"
                      checked={leadDecision === "approved_for_admin"}
                      onChange={() => setLeadDecision("approved_for_admin")}
                      className="mt-0.5 text-brand"
                    />
                    <div>
                      <span className="block text-[13px] font-semibold text-ink">Approve & Escalate to Admin</span>
                      <span className="block text-[11.5px] text-ink-faint">
                        Endorsed for technical/development implementation.
                      </span>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 rounded-lg border border-rule bg-surface p-3 cursor-pointer hover:bg-paper">
                    <input
                      type="radio"
                      name="lead-decision"
                      value="resolved_by_lead"
                      checked={leadDecision === "resolved_by_lead"}
                      onChange={() => setLeadDecision("resolved_by_lead")}
                      className="mt-0.5 text-brand"
                    />
                    <div>
                      <span className="block text-[13px] font-semibold text-ink">Resolve Directly (No Dev Needed)</span>
                      <span className="block text-[11.5px] text-ink-faint">
                        Training or operational guidance provided directly to the TA.
                      </span>
                    </div>
                  </label>

                  <label className="flex items-start gap-2.5 rounded-lg border border-rule bg-surface p-3 cursor-pointer hover:bg-paper">
                    <input
                      type="radio"
                      name="lead-decision"
                      value="declined_by_lead"
                      checked={leadDecision === "declined_by_lead"}
                      onChange={() => setLeadDecision("declined_by_lead")}
                      className="mt-0.5 text-brand"
                    />
                    <div>
                      <span className="block text-[13px] font-semibold text-ink">Decline</span>
                      <span className="block text-[11.5px] text-ink-faint">Not applicable or duplicate issue.</span>
                    </div>
                  </label>
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-[12.5px] font-semibold text-ink">
                  TA Lead Review Notes / Recommendations
                </label>
                <textarea
                  rows={3}
                  value={leadNotes}
                  onChange={(e) => setLeadNotes(e.target.value)}
                  placeholder="e.g. Verified with team; happens when copying candidate profiles. Please fix in next sprint."
                  className="w-full resize-none rounded-lg border border-rule bg-paper p-2.5 text-[13px] text-ink outline-none focus:border-brand focus:bg-surface"
                />
              </div>

              <div className="flex items-center justify-end gap-2.5 border-t border-rule pt-4">
                <button
                  type="button"
                  onClick={() => setLeadModalItem(null)}
                  className="rounded-lg px-4 py-2 text-[13px] font-medium text-ink-soft hover:bg-paper"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40"
                >
                  {isPending ? "Submitting..." : "Save Review Decision"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Admin Update Modal */}
      {adminModalItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs">
          <div className="flex max-h-[90vh] w-full max-w-[500px] flex-col overflow-hidden rounded-2xl border border-rule bg-surface shadow-2xl">
            <div className="flex items-center justify-between border-b border-rule px-5 py-4">
              <div>
                <h3 className="text-[16px] font-semibold text-ink">Admin Queue Action</h3>
                <p className="text-[12px] text-ink-faint">Update progress or mark item resolved.</p>
              </div>
              <button
                onClick={() => setAdminModalItem(null)}
                className="grid h-8 w-8 place-items-center rounded-lg text-ink-faint hover:bg-paper"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleAdminSubmit} className="overflow-y-auto p-5 space-y-4">
              {actionError && (
                <div className="rounded-lg bg-danger/10 p-3 text-[12.5px] text-danger border border-danger/20">
                  {actionError}
                </div>
              )}

              <div className="rounded-lg border border-rule bg-paper p-3 text-[12.5px]">
                <p className="font-semibold text-ink">{adminModalItem.title}</p>
                <p className="mt-1 text-ink-soft text-[12px]">{adminModalItem.description}</p>
                {adminModalItem.screenshot && (
                  <div className="mt-2 flex items-center gap-2 border-t border-rule/50 pt-2">
                    <button
                      type="button"
                      onClick={() =>
                        setViewScreenshotUrl(
                          adminModalItem.screenshot?.startsWith("data:")
                            ? adminModalItem.screenshot
                            : `/api/feedback/screenshot/${adminModalItem.id}`
                        )
                      }
                      className="flex items-center gap-1.5 text-[12px] font-medium text-brand hover:underline"
                    >
                      📷 View Attached Screenshot
                    </button>
                  </div>
                )}
                {adminModalItem.leadNotes && (
                  <p className="mt-2 text-[11.5px] text-brand border-t border-rule/50 pt-1.5">
                    <strong>Lead Note:</strong> {adminModalItem.leadNotes}
                  </p>
                )}
              </div>

              <div>
                <label className="mb-1.5 block text-[12.5px] font-semibold text-ink">Status</label>
                <div className="grid grid-cols-3 gap-2">
                  {(["in_progress", "resolved", "declined_by_admin"] as const).map((st) => (
                    <button
                      type="button"
                      key={st}
                      onClick={() => setAdminStatus(st)}
                      className={`rounded-lg border py-2 text-center text-[12px] font-medium capitalize transition-colors ${
                        adminStatus === st
                          ? "border-brand bg-brand/5 text-brand ring-1 ring-brand"
                          : "border-rule bg-paper text-ink-soft hover:border-rule-strong"
                      }`}
                    >
                      {st === "in_progress" ? "In Progress" : st === "resolved" ? "Resolved" : "Declined"}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-[12.5px] font-semibold text-ink">
                  Admin Resolution / Changelog Notes
                </label>
                <textarea
                  rows={3}
                  value={adminResolution}
                  onChange={(e) => setAdminResolution(e.target.value)}
                  placeholder="e.g. Bug fixed in patch v2.4. Deployed to production."
                  className="w-full resize-none rounded-lg border border-rule bg-paper p-2.5 text-[13px] text-ink outline-none focus:border-brand focus:bg-surface"
                />
              </div>

              <div className="flex items-center justify-end gap-2.5 border-t border-rule pt-4">
                <button
                  type="button"
                  onClick={() => setAdminModalItem(null)}
                  className="rounded-lg px-4 py-2 text-[13px] font-medium text-ink-soft hover:bg-paper"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40"
                >
                  {isPending ? "Saving..." : "Update Item"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* New Submission Modal */}
      {showSubmitModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs">
          <div className="flex max-h-[90vh] w-full max-w-[520px] flex-col overflow-hidden rounded-2xl border border-rule bg-surface shadow-2xl">
            <div className="flex items-center justify-between border-b border-rule px-5 py-4">
              <div>
                <h3 className="text-[16px] font-semibold text-ink">Submit TA Feedback</h3>
                <p className="text-[12px] text-ink-faint">Will be routed to TA Lead review before Admin escalation.</p>
              </div>
              <button
                onClick={() => {
                  setShowSubmitModal(false);
                  if (newScreenshotPreview) URL.revokeObjectURL(newScreenshotPreview);
                  setNewScreenshotFile(null);
                  setNewScreenshotPreview(null);
                  setNewScreenshotName(null);
                }}
                className="grid h-8 w-8 place-items-center rounded-lg text-ink-faint hover:bg-paper"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleNewSubmit} onPaste={handlePaste} className="overflow-y-auto p-5 space-y-4">
              {actionError && (
                <div className="rounded-lg bg-danger/10 p-3 text-[12.5px] text-danger border border-danger/20">
                  {actionError}
                </div>
              )}

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-[12.5px] font-semibold text-ink">Description & Steps</label>
                  <span className="text-[11px] text-ink-faint">Tip: Ctrl+V to paste screenshot</span>
                </div>
                <textarea
                  rows={5}
                  required
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  placeholder="Provide context, candidate/opening names, and expected vs actual behavior..."
                  className="w-full resize-none rounded-lg border border-rule bg-paper p-3 text-[13px] text-ink outline-none focus:border-brand focus:bg-surface"
                />
              </div>

              {/* Screenshot Attachment Option */}
              <div>
                <label className="mb-1.5 block text-[12.5px] font-semibold text-ink">
                  Attach Screenshot (optional)
                </label>

                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  className="hidden"
                />

                {newScreenshotPreview ? (
                  <div className="relative flex items-center gap-3 rounded-lg border border-rule bg-paper p-2.5">
                    <div className="relative h-14 w-20 shrink-0 overflow-hidden rounded border border-rule bg-surface">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={newScreenshotPreview}
                        alt="Screenshot Preview"
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-medium text-ink">
                        {newScreenshotName || "Screenshot attached"}
                      </p>
                      <p className="text-[11px] text-ok font-medium">Ready to submit with report</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        if (newScreenshotPreview) URL.revokeObjectURL(newScreenshotPreview);
                        setNewScreenshotFile(null);
                        setNewScreenshotPreview(null);
                        setNewScreenshotName(null);
                        if (fileInputRef.current) fileInputRef.current.value = "";
                      }}
                      className="grid h-7 w-7 place-items-center rounded-md text-ink-faint hover:bg-surface hover:text-danger"
                      title="Remove screenshot"
                    >
                      ✕
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

              <div className="flex items-center justify-end gap-2.5 border-t border-rule pt-4">
                <button
                  type="button"
                  onClick={() => {
                    setShowSubmitModal(false);
                    if (newScreenshotPreview) URL.revokeObjectURL(newScreenshotPreview);
                    setNewScreenshotFile(null);
                    setNewScreenshotPreview(null);
                    setNewScreenshotName(null);
                  }}
                  className="rounded-lg px-4 py-2 text-[13px] font-medium text-ink-soft hover:bg-paper"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPending || !newDescription.trim()}
                  className="rounded-lg bg-brand px-4 py-2 text-[13px] font-medium text-white hover:opacity-90 disabled:opacity-40"
                >
                  {isPending ? "Submitting..." : "Submit Feedback"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Screenshot Enlarge / Zoom Modal */}
      {viewScreenshotUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs animate-in fade-in duration-150"
          onClick={() => setViewScreenshotUrl(null)}
        >
          <div
            className="relative flex max-h-[90vh] max-w-[90vw] flex-col overflow-hidden rounded-2xl border border-white/20 bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-rule px-4 py-3">
              <span className="text-[13.5px] font-semibold text-ink">Attached Screenshot</span>
              <button
                onClick={() => setViewScreenshotUrl(null)}
                className="grid h-7 w-7 place-items-center rounded-lg text-ink-faint hover:bg-paper hover:text-ink"
              >
                ✕
              </button>
            </div>
            <div className="max-h-[80vh] overflow-auto p-4 flex items-center justify-center bg-black/5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={viewScreenshotUrl}
                alt="Enlarged issue screenshot"
                className="max-h-[75vh] w-auto max-w-full rounded-lg object-contain shadow-md"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
