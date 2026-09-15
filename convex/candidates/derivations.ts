export function deriveNoticePeriodDays(noticePeriod: string | null | undefined): number | undefined {
  if (!noticePeriod) return undefined;

  const lower = noticePeriod.toLowerCase();
  
  if (lower.includes("immediate")) {
    return 0;
  }

  // Check exact strings first
  if (lower === "1 month" || lower === "4 weeks") return 30;
  if (lower === "2 months" || lower === "8 weeks") return 60;
  if (lower === "3 months" || lower === "12 weeks") return 90;

  // Extract number and multiply
  const match = lower.match(/(\d+)/);
  if (match) {
    const num = parseInt(match[1], 10);
    if (!isNaN(num)) {
      if (lower.includes("month")) return num * 30;
      if (lower.includes("week")) return num * 7;
      if (lower.includes("day")) return num;
    }
  }

  return undefined;
}

export function deriveSeniorityLevel(
  yearsOfExperience: number | null | undefined,
  currentTitle: string | null | undefined
): string | undefined {
  let baseLevel: "Junior" | "Mid" | "Senior" | "Lead/Principal" | undefined;

  if (yearsOfExperience !== undefined && yearsOfExperience !== null) {
    if (yearsOfExperience <= 2) baseLevel = "Junior";
    else if (yearsOfExperience <= 5) baseLevel = "Mid";
    else if (yearsOfExperience <= 9) baseLevel = "Senior";
    else baseLevel = "Lead/Principal";
  }

  if (!currentTitle) return baseLevel;

  const titleLower = currentTitle.toLowerCase();
  
  // Title overrides
  if (titleLower.includes("junior") || titleLower.includes("jnr")) {
    return "Junior";
  }
  
  if (
    titleLower.includes("lead") ||
    titleLower.includes("principal") ||
    titleLower.includes("head") ||
    titleLower.includes("director") ||
    titleLower.includes("vp") ||
    titleLower.includes("chief") ||
    titleLower.startsWith("c") && titleLower.endsWith("o") && titleLower.length === 3 // e.g. CEO, CTO
  ) {
    return "Lead/Principal";
  }

  if (
    titleLower.includes("senior") ||
    titleLower.includes("snr") ||
    titleLower.includes("sr")
  ) {
    return baseLevel === "Lead/Principal" ? "Lead/Principal" : "Senior";
  }

  return baseLevel;
}

export function deriveEducationFields(
  education: Array<{ degree?: string | null; institution?: string | null; year?: number | null }> | null | undefined
) {
  if (!education || education.length === 0) {
    return { educationDegree: undefined, educationInstitution: undefined, educationYear: undefined };
  }

  // Sort descending by year, pushing nulls to the end
  const sortedEdu = [...education].sort((a, b) => {
    const yearA = a.year ?? -Infinity;
    const yearB = b.year ?? -Infinity;
    return yearB - yearA;
  });

  const mostRecent = sortedEdu[0];
  
  return {
    educationDegree: mostRecent.degree ?? undefined,
    educationInstitution: mostRecent.institution ?? undefined,
    educationYear: mostRecent.year ?? undefined,
  };
}

export function deriveTotalExperienceYears(
  jobHistory: Array<{ startDate?: string | null; endDate?: string | null }> | null | undefined,
  yearsOfExperience: number | null | undefined
): number | undefined {
  if (!jobHistory || jobHistory.length === 0) {
    return yearsOfExperience ?? undefined;
  }

  const now = new Date().getTime();
  const intervals: Array<{ start: number; end: number }> = [];

  for (const job of jobHistory) {
    if (!job.startDate) continue;
    const start = new Date(job.startDate).getTime();
    if (isNaN(start)) continue;

    let end = now;
    if (job.endDate && job.endDate.toLowerCase() !== "present" && job.endDate.toLowerCase() !== "current") {
      const parsedEnd = new Date(job.endDate).getTime();
      if (!isNaN(parsedEnd)) {
        end = parsedEnd;
      }
    }

    if (end > start) {
      intervals.push({ start, end });
    }
  }

  if (intervals.length === 0) {
    return yearsOfExperience ?? undefined;
  }

  // Sort intervals by start time
  intervals.sort((a, b) => a.start - b.start);

  // Merge overlapping intervals
  const merged: Array<{ start: number; end: number }> = [intervals[0]];
  for (let i = 1; i < intervals.length; i++) {
    const last = merged[merged.length - 1];
    const curr = intervals[i];
    if (curr.start <= last.end) {
      last.end = Math.max(last.end, curr.end); // Overlapping, extend the end
    } else {
      merged.push(curr); // Non-overlapping, add as new interval
    }
  }

  // Calculate total days from merged intervals
  let totalDays = 0;
  for (const interval of merged) {
    totalDays += (interval.end - interval.start) / (1000 * 60 * 60 * 24);
  }

  const computedYears = totalDays / 365.25;
  if (computedYears > 0) {
    return Math.round(computedYears * 10) / 10;
  }

  return yearsOfExperience ?? undefined;
}

export function deriveCurrentRole(
  jobHistory: Array<{ company?: string | null; title?: string | null; endDate?: string | null; startDate?: string | null }> | null | undefined,
  currentEmployer: string | null | undefined,
  currentTitle: string | null | undefined
): { derivedEmployer: string | undefined; derivedTitle: string | undefined } {
  let derivedEmployer = currentEmployer ?? undefined;
  let derivedTitle = currentTitle ?? undefined;

  if ((derivedEmployer && derivedTitle) || !jobHistory || jobHistory.length === 0) {
    return { derivedEmployer, derivedTitle };
  }

  let currentJob = null;
  let mostRecentDate = -Infinity;

  for (const job of jobHistory) {
    const endStr = (job.endDate || "").toLowerCase().trim();
    
    // Explicitly current jobs
    if (
      endStr.includes("present") ||
      endStr.includes("current") ||
      endStr.includes("now") ||
      endStr.includes("to date") ||
      (!job.endDate && job.startDate) // Open-ended
    ) {
      currentJob = job;
      break; // Found the definitive current job
    }

    // Try to find the most recent one based on date
    const parsedEnd = new Date(job.endDate || "").getTime();
    if (!isNaN(parsedEnd) && parsedEnd > mostRecentDate) {
      mostRecentDate = parsedEnd;
      currentJob = job;
    }
  }

  // If we didn't find one by date, default to the first one in the list 
  // (usually CVs list most recent first)
  if (!currentJob) {
    currentJob = jobHistory[0];
  }

  if (!derivedEmployer && currentJob.company) {
    derivedEmployer = currentJob.company;
  }
  
  if (!derivedTitle && currentJob.title) {
    derivedTitle = currentJob.title;
  }

  return { derivedEmployer, derivedTitle };
}
