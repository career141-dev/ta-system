"use client";

import Link from "next/link";
import { useState, useRef, useTransition } from "react";
import type { Candidate } from "@/data/types";
import type { ReferenceCvBlueprint } from "@/lib/referenceCv";
import type { LookalikeCandidateMatch, LookalikeSearchResults } from "@/lib/lookalikeMatch";
import { AddToOpening } from "@/components/AddToOpening";

interface CvMatcherProps {
  initialBlueprint?: ReferenceCvBlueprint | null;
  initialMatches?: LookalikeCandidateMatch[];
  initialSource?: string | null;
  openings: { id: string; label: string }[];
  existingCandidates: { id: string; name: string; title: string }[];
}

export function CvMatcher({
  initialBlueprint = null,
  initialMatches = [],
  initialSource = null,
  openings = [],
  existingCandidates = [],
}: CvMatcherProps) {
  const [tab, setTab] = useState<"upload" | "paste" | "candidate">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [pasteText, setPasteText] = useState("");
  const [selectedCandId, setSelectedCandId] = useState("");
  const [candFilter, setCandFilter] = useState("");

  const [blueprint, setBlueprint] = useState<ReferenceCvBlueprint | null>(initialBlueprint);
  const [prompt, setPrompt] = useState("");
  const [matches, setMatches] = useState<LookalikeCandidateMatch[]>(initialMatches);
  const [status, setStatus] = useState<"idle" | "extracting" | "matching" | "done">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [newSkillInput, setNewSkillInput] = useState("");

  const [selectedCandidate, setSelectedCandidate] = useState<Candidate | null>(null);
  const [sortBy, setSortBy] = useState<"score" | "experience" | "skills">("score");

  const [isPending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // File Upload Handlers
  const handleFileDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const dropped = e.dataTransfer.files[0];
      setFile(dropped);
      extractFromFile(dropped);
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const selected = e.target.files[0];
      setFile(selected);
      extractFromFile(selected);
    }
  };

  const extractFromFile = async (f: File) => {
    setStatus("extracting");
    setErrorMessage(null);

    const formData = new FormData();
    formData.append("file", f);

    try {
      const res = await fetch("/api/cv/reference", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.message || "Failed to extract criteria from the CV file.");
      }

      setBlueprint(data.blueprint);
      runSearch(data.blueprint, prompt);
    } catch (err: any) {
      setStatus("idle");
      setErrorMessage(err.message || "Could not read the CV. Try another file or paste text.");
    }
  };

  const extractFromPastedText = async () => {
    if (pasteText.trim().length < 25) {
      setErrorMessage("Please enter at least a few lines of CV text.");
      return;
    }
    setStatus("extracting");
    setErrorMessage(null);

    try {
      const res = await fetch("/api/cv/reference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: pasteText }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.message || "Failed to extract criteria from text.");
      }

      setBlueprint(data.blueprint);
      runSearch(data.blueprint, prompt);
    } catch (err: any) {
      setStatus("idle");
      setErrorMessage(err.message || "Could not parse text.");
    }
  };

  const extractFromCandidate = async (cid: string) => {
    if (!cid) return;
    setStatus("extracting");
    setErrorMessage(null);

    try {
      const res = await fetch("/api/cv/reference", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ candidateId: cid }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.message || "Failed to read candidate blueprint.");
      }

      setBlueprint(data.blueprint);
      runSearch(data.blueprint, prompt);
    } catch (err: any) {
      setStatus("idle");
      setErrorMessage(err.message || "Failed to load candidate.");
    }
  };

  const runSearch = async (bp: ReferenceCvBlueprint, userPrompt: string) => {
    setStatus("matching");
    setErrorMessage(null);

    try {
      const res = await fetch("/api/lookalike/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ blueprint: bp, prompt: userPrompt }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.message || "Failed to search lookalike candidates.");
      }

      setMatches(data.results?.matches ?? []);
      setStatus("done");
    } catch (err: any) {
      setStatus("idle");
      setErrorMessage(err.message || "Lookalike search failed.");
    }
  };

  // Skill Chip Modifications
  const removeSkill = (skill: string) => {
    if (!blueprint) return;
    const updated = {
      ...blueprint,
      skills: blueprint.skills.filter((s) => s !== skill),
    };
    setBlueprint(updated);
  };

  const addSkill = () => {
    if (!blueprint || !newSkillInput.trim()) return;
    const s = newSkillInput.trim();
    if (!blueprint.skills.includes(s)) {
      setBlueprint({ ...blueprint, skills: [...blueprint.skills, s] });
    }
    setNewSkillInput("");
  };

  // Sorting
  const sortedMatches = [...matches].sort((a, b) => {
    if (sortBy === "score") return b.score - a.score;
    if (sortBy === "experience") return (b.candidate.totalExperienceYears ?? 0) - (a.candidate.totalExperienceYears ?? 0);
    if (sortBy === "skills") return b.sharedSkills.length - a.sharedSkills.length;
    return 0;
  });

  return (
    <div className="flex flex-col gap-8">
      {/* 1. Reference CV Source Input Card */}
      <section className="rounded-2xl border border-rule bg-surface p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-rule pb-4">
          <div>
            <h2 className="text-[16px] font-semibold text-ink">1. Provide Reference CV</h2>
            <p className="mt-0.5 text-[12.5px] text-ink-soft">
              Drop a candidate's CV to use as the reference benchmark for finding lookalikes.
            </p>
          </div>
          <div className="flex rounded-lg border border-rule bg-surface-subtle p-0.5">
            <button
              type="button"
              onClick={() => setTab("upload")}
              className={`rounded-md px-3 py-1 text-[12px] font-medium transition-colors ${
                tab === "upload" ? "bg-surface text-ink shadow-sm" : "text-ink-soft hover:text-ink"
              }`}
            >
              Upload Document
            </button>
            <button
              type="button"
              onClick={() => setTab("paste")}
              className={`rounded-md px-3 py-1 text-[12px] font-medium transition-colors ${
                tab === "paste" ? "bg-surface text-ink shadow-sm" : "text-ink-soft hover:text-ink"
              }`}
            >
              Paste Text
            </button>
            <button
              type="button"
              onClick={() => setTab("candidate")}
              className={`rounded-md px-3 py-1 text-[12px] font-medium transition-colors ${
                tab === "candidate" ? "bg-surface text-ink shadow-sm" : "text-ink-soft hover:text-ink"
              }`}
            >
              Existing Candidate
            </button>
          </div>
        </div>

        <div className="mt-5">
          {tab === "upload" && (
            <div
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleFileDrop}
              onClick={() => fileInputRef.current?.click()}
              className="group flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-rule px-6 py-10 text-center transition-colors hover:border-brand hover:bg-brand-soft/20"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.docx,.txt,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                onChange={handleFileSelect}
                className="hidden"
              />
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand-soft text-brand transition-transform group-hover:scale-105">
                <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
              </div>
              <p className="mt-3 text-[13.5px] font-medium text-ink">
                {file ? file.name : "Drag & drop reference CV here, or click to browse"}
              </p>
              <p className="mt-1 text-[12px] text-ink-faint">
                Supports PDF, DOCX or TXT documents up to 10 MB
              </p>
            </div>
          )}

          {tab === "paste" && (
            <div className="flex flex-col gap-3">
              <textarea
                rows={6}
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="Paste reference CV text, summary, career history, and skills here..."
                className="w-full rounded-xl border border-rule bg-surface p-3.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={extractFromPastedText}
                  disabled={status === "extracting" || pasteText.trim().length < 25}
                  className="rounded-lg bg-brand px-4 py-2 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  Analyze & Search
                </button>
              </div>
            </div>
          )}

          {tab === "candidate" && (
            <div className="flex flex-col gap-3">
              <input
                type="text"
                placeholder="Search candidates by name or title..."
                value={candFilter}
                onChange={(e) => setCandFilter(e.target.value)}
                className="rounded-lg border border-rule bg-surface px-3 py-2 text-[13px] focus:border-brand focus:outline-none"
              />
              <div className="max-h-48 overflow-y-auto rounded-lg border border-rule divide-y divide-rule">
                {existingCandidates
                  .filter((c) => !candFilter || c.name.toLowerCase().includes(candFilter.toLowerCase()) || c.title.toLowerCase().includes(candFilter.toLowerCase()))
                  .slice(0, 30)
                  .map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setSelectedCandId(c.id);
                        extractFromCandidate(c.id);
                      }}
                      className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-tag"
                    >
                      <div>
                        <span className="font-medium text-[13px] text-ink">{c.name}</span>
                        <span className="ml-2 text-[12px] text-ink-soft">{c.title}</span>
                      </div>
                      <span className="text-[11.5px] text-brand">Use as Reference →</span>
                    </button>
                  ))}
              </div>
            </div>
          )}
        </div>

        {/* Status indicator */}
        {status === "extracting" && (
          <div className="mt-4 flex items-center gap-3 rounded-xl bg-brand-soft/60 px-4 py-3 text-[13px] text-brand">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
            Analyzing reference CV blueprint with DeepSeek AI…
          </div>
        )}
        {status === "matching" && (
          <div className="mt-4 flex items-center gap-3 rounded-xl bg-brand-soft/60 px-4 py-3 text-[13px] text-brand">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-brand border-t-transparent" />
            Matching candidate database against reference criteria…
          </div>
        )}
        {errorMessage && (
          <div className="mt-4 rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-[12.5px] text-danger">
            {errorMessage}
          </div>
        )}
      </section>

      {/* 2. Extracted Blueprint & Prompt Refinement Card */}
      {blueprint && (
        <section className="rounded-2xl border border-rule bg-surface p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-rule pb-4">
            <div>
              <span className="rounded-full bg-brand-soft px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider text-brand">
                Reference Blueprint
              </span>
              <h2 className="mt-1 text-[18px] font-semibold text-ink">
                {blueprint.targetTitle}
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-md border border-rule bg-tag px-2.5 py-1 text-[12px] font-medium capitalize text-ink">
                Seniority: {blueprint.seniority}
              </span>
              <span className="rounded-md border border-rule bg-tag px-2.5 py-1 text-[12px] font-medium text-ink">
                Experience: {blueprint.totalExperienceYears ? `${blueprint.totalExperienceYears} yrs` : "N/A"}
              </span>
            </div>
          </div>

          <div className="mt-5 flex flex-col gap-4">
            {blueprint.summary && (
              <p className="text-[13px] leading-relaxed text-ink-soft">
                <b className="text-ink">Profile Persona:</b> {blueprint.summary}
              </p>
            )}

            {/* Skills chips with remove ability */}
            <div>
              <label className="text-[12px] font-semibold text-ink-soft">Core Skills & Competencies</label>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                {blueprint.skills.map((s) => (
                  <span
                    key={s}
                    className="group inline-flex items-center gap-1 rounded-full border border-rule bg-surface-subtle px-3 py-1 text-[12px] text-ink"
                  >
                    {s}
                    <button
                      type="button"
                      onClick={() => removeSkill(s)}
                      className="text-ink-faint hover:text-danger"
                      title="Remove skill"
                    >
                      ×
                    </button>
                  </span>
                ))}
                <div className="inline-flex items-center gap-1">
                  <input
                    type="text"
                    placeholder="+ add skill"
                    value={newSkillInput}
                    onChange={(e) => setNewSkillInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addSkill();
                      }
                    }}
                    className="w-24 rounded-full border border-rule px-2.5 py-0.5 text-[11.5px] focus:border-brand focus:outline-none"
                  />
                  {newSkillInput && (
                    <button
                      type="button"
                      onClick={addSkill}
                      className="rounded-full bg-brand px-2 py-0.5 text-[11px] text-white"
                    >
                      Add
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Guidance Prompt */}
            <div className="mt-2 rounded-xl border border-rule bg-surface-subtle/50 p-4">
              <label className="block text-[12.5px] font-semibold text-ink">
                Recruiter Guidance & Focus Prompt (Optional)
              </label>
              <p className="mt-0.5 text-[11.5px] text-ink-faint">
                Add specific instructions or priorities (e.g., "Must have direct banking / FMCG background", "Prioritize strong client-facing communication").
              </p>
              <div className="mt-2.5 flex gap-2">
                <input
                  type="text"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      runSearch(blueprint, prompt);
                    }
                  }}
                  placeholder="e.g. Prioritize candidates from Dialog, IFS, or Unilever with leadership background..."
                  className="flex-1 rounded-xl border border-rule bg-surface px-3.5 py-2 text-[13px] text-ink placeholder:text-ink-faint focus:border-brand focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => runSearch(blueprint, prompt)}
                  disabled={status === "matching"}
                  className="rounded-xl bg-brand px-5 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {status === "matching" ? "Matching..." : "Find Lookalikes"}
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* 3. Lookalike Matches Results Section */}
      {matches.length > 0 && (
        <section className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-[18px] font-semibold text-ink">
                Lookalike Matches ({matches.length})
              </h3>
              <p className="text-[12.5px] text-ink-soft">
                Candidates ranked by multi-dimensional similarity to the reference profile.
              </p>
            </div>
            <div className="flex items-center gap-2 text-[12px] text-ink-soft">
              <span>Sort by:</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="rounded-lg border border-rule bg-surface px-2.5 py-1 text-[12px] font-medium text-ink focus:outline-none"
              >
                <option value="score">Best Lookalike Match</option>
                <option value="experience">Years of Experience</option>
                <option value="skills">Most Shared Skills</option>
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-3.5">
            {sortedMatches.map(({ candidate: c, score, rating, sharedSkills, missingSkills, experienceDeltaYears, matchedEmployers, matchSummary }) => {
              const scoreColor =
                score >= 85
                  ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20"
                  : score >= 72
                  ? "bg-blue-500/10 text-blue-600 border-blue-500/20"
                  : "bg-amber-500/10 text-amber-600 border-amber-500/20";

              return (
                <div
                  key={c.id}
                  className="flex flex-col gap-3.5 rounded-xl border border-rule bg-surface p-5 transition-shadow hover:shadow-sm"
                >
                  {/* Header Row */}
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2.5">
                        <Link
                          href={`/candidates/${c.id}`}
                          className="text-[15px] font-semibold text-ink hover:text-brand hover:underline"
                        >
                          {c.fullName}
                        </Link>
                        <span className={`rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${scoreColor}`}>
                          {score}% · {rating}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[13px] text-ink-soft">
                        <span className="font-medium text-ink">{c.currentTitle ?? "Title not specified"}</span>
                        {c.currentEmployer ? ` at ${c.currentEmployer}` : ""} ·{" "}
                        <span>{c.totalExperienceYears ? `${c.totalExperienceYears} yrs experience` : "Experience not stated"}</span>
                        {c.location ? ` · ${c.location}` : ""}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedCandidate(c)}
                        className="rounded-lg border border-rule bg-surface-subtle px-3 py-1.5 text-[12px] font-medium text-ink hover:bg-tag"
                      >
                        Quick Preview
                      </button>
                      <Link
                        href={`/candidates/${c.id}`}
                        className="rounded-lg bg-surface border border-rule px-3 py-1.5 text-[12px] font-medium text-brand hover:bg-tag"
                      >
                        Open Profile →
                      </Link>
                    </div>
                  </div>

                  {/* Why this matches banner */}
                  <div className="rounded-lg border border-rule/60 bg-surface-subtle/50 px-3.5 py-2 text-[12px] text-ink-soft">
                    <span className="font-medium text-ink">Match Rationale: </span>
                    {matchSummary}
                  </div>

                  {/* Skills breakdown */}
                  <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                    <span className="font-medium text-ink-soft">Shared Skills:</span>
                    {sharedSkills.length > 0 ? (
                      sharedSkills.map((s) => (
                        <span
                          key={s}
                          className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 font-medium text-emerald-700"
                        >
                          ✓ {s}
                        </span>
                      ))
                    ) : (
                      <span className="text-ink-faint">None directly matching reference tags</span>
                    )}

                    {missingSkills.slice(0, 3).length > 0 && (
                      <>
                        <span className="ml-2 font-medium text-ink-faint">Missing from ref:</span>
                        {missingSkills.slice(0, 3).map((s) => (
                          <span
                            key={s}
                            className="rounded-full border border-rule px-2 py-0.5 text-ink-faint"
                          >
                            {s}
                          </span>
                        ))}
                      </>
                    )}
                  </div>

                  {/* Add to opening form */}
                  <div className="border-t border-rule/60 pt-3 flex items-center justify-between">
                    <span className="text-[11.5px] text-ink-faint">
                      {c.workHistory?.length ? `${c.workHistory.length} career positions on file` : "No prior positions"}
                    </span>
                    <AddToOpening
                      candidateId={c.id}
                      openings={openings}
                      variant="compact"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Candidate Quick Preview Modal / Drawer */}
      {selectedCandidate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl bg-surface p-6 shadow-2xl overflow-hidden">
            <div className="flex items-start justify-between border-b border-rule pb-4">
              <div>
                <h3 className="text-[18px] font-semibold text-ink">{selectedCandidate.fullName}</h3>
                <p className="text-[13px] text-ink-soft">
                  {selectedCandidate.currentTitle} {selectedCandidate.currentEmployer ? `at ${selectedCandidate.currentEmployer}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedCandidate(null)}
                className="rounded-lg p-1.5 text-ink-soft hover:bg-tag hover:text-ink"
              >
                ✕
              </button>
            </div>

            <div className="mt-4 flex-1 overflow-y-auto space-y-4 pr-1 text-[13px]">
              <div>
                <h4 className="font-semibold text-ink">Overview</h4>
                <p className="mt-1 text-ink-soft">
                  Total Experience: {selectedCandidate.totalExperienceYears ?? "Unknown"} years · Location: {selectedCandidate.location ?? "Not stated"}
                </p>
                {selectedCandidate.email && <p className="text-ink-soft">Email: {selectedCandidate.email}</p>}
                {selectedCandidate.phone && <p className="text-ink-soft">Phone: {selectedCandidate.phone}</p>}
              </div>

              {selectedCandidate.skills?.length > 0 && (
                <div>
                  <h4 className="font-semibold text-ink">All Skills</h4>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {selectedCandidate.skills.map((s) => (
                      <span key={s} className="rounded-md border border-rule px-2 py-0.5 text-[11.5px]">
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {selectedCandidate.workHistory?.length > 0 && (
                <div>
                  <h4 className="font-semibold text-ink">Career History</h4>
                  <ul className="mt-2 divide-y divide-rule border border-rule rounded-xl">
                    {selectedCandidate.workHistory.map((w, idx) => (
                      <li key={idx} className="p-3">
                        <p className="font-medium text-ink">{w.title}</p>
                        <p className="text-[12px] text-ink-soft">{w.employer} · {w.fromYear} – {w.toYear ?? "Present"}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <div className="mt-6 flex justify-between items-center border-t border-rule pt-4">
              <Link
                href={`/candidates/${selectedCandidate.id}`}
                className="rounded-lg bg-brand px-4 py-2 text-[12.5px] font-medium text-white hover:opacity-90"
              >
                Go to Full Candidate Page →
              </Link>
              <button
                type="button"
                onClick={() => setSelectedCandidate(null)}
                className="rounded-lg border border-rule px-4 py-2 text-[12.5px] font-medium text-ink hover:bg-tag"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
