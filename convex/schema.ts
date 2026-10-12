// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  // ■■ USERS ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■
  users: defineTable({
    tokenIdentifier: v.string(),
    clerkUserId: v.optional(v.string()), // Optional for backwards compatibility
    email: v.string(),
    fullName: v.string(), // Kept fullName to not break existing frontend
    role: v.union(
      v.literal("admin"),
      v.literal("ta_manager"),
      v.literal("senior_ta"),
      v.literal("recruiter"),
      v.literal("director"),
      v.literal("client"),
      v.literal("viewer"),
      v.literal("ta"), // Legacy, kept temporarily if needed
      v.literal("ops"), // Legacy
      v.literal("test_ta") // Temporary testing role with limited access
    ),
    phone: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    isActive: v.boolean(),
    isOnboarded: v.optional(v.boolean()),
    createdAt: v.string(),
    updatedAt: v.optional(v.string()),
    lastLoginAt: v.optional(v.string()),
    notificationPrefs: v.optional(v.object({
      email: v.boolean(),
      whatsapp: v.boolean(),
      inApp: v.boolean(),
    })),

    // ── TA platform ───────────────────────────────────────────────────────
    /**
     * The mailbox this TA's job adverts point at — one per TA, not one per
     * job. This is the whole basis of the new inbound routing: the address
     * says which TA, the subject headline says which of that TA's adverts.
     * See src/lib/routing.ts.
     */
    routingEmail: v.optional(v.union(v.string(), v.null())),
    initials: v.optional(v.string()),
    /** The new platform's role vocabulary, mapped from `role` above. */
    taRole: v.optional(v.union(
      v.literal("admin"),
      v.literal("director"),
      v.literal("ta_lead"),
      v.literal("ta"),
      // A TA who also reads every TA's Excel Tables rows on their jobs (9 Oct).
      v.literal("ta_support"),
      v.literal("ops"),
      v.literal("client"),
      v.literal("viewer"),
    )),
  })
    .index("by_token", ["tokenIdentifier"])
    .index("by_routingEmail", ["routingEmail"])
    .index("by_clerkUserId", ["clerkUserId"])
    .index("by_email", ["email"])
    .index("by_role", ["role"])
    .index("by_active", ["isActive"])
    .index("by_phone", ["phone"]),

  // ■■ TEAMS ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■
  teams: defineTable({
    name: v.string(), // e.g. "FMCG Team", "Finance Desk"
    description: v.optional(v.string()),
    managerId: v.id("users"), // SENIOR_TA or TA_MANAGER who leads this team
    isActive: v.boolean(),
    createdBy: v.id("users"),
    createdAt: v.string(),
  })
    .index("by_managerId", ["managerId"])
    .index("by_isActive", ["isActive"]),

  // ■■ TEAM_MEMBERS ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■
  teamMembers: defineTable({
    teamId: v.id("teams"),
    userId: v.id("users"),
    memberRole: v.union(
      v.literal("lead"), // Team lead (SENIOR_TA or TA_MANAGER)
      v.literal("recruiter"), // Standard team member
      v.literal("support") // Occasional contributor
    ),
    addedBy: v.id("users"),
    addedAt: v.string(),
    removedAt: v.optional(v.string()),
    isActive: v.boolean(),
  })
    .index("by_teamId", ["teamId"])
    .index("by_userId", ["userId"])
    .index("by_teamId_userId", ["teamId", "userId"]),

  // ■■ JOB_ASSIGNMENTS ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■
  jobAssignments: defineTable({
    jobId: v.id("jobs"),
    userId: v.id("users"),
    assignmentRole: v.union(
      v.literal("primary_recruiter"), // The TA responsible; receives all alerts
      v.literal("supporting_recruiter"),// Additional TA with pipeline access
      v.literal("director"), // Stage 5 Director Review access
      v.literal("client_contact") // Stage 6 Client Review access
    ),
    assignedBy: v.id("users"),
    assignedAt: v.string(),
    revokedAt: v.optional(v.string()),
    isActive: v.boolean(),
    /** The TA's current working stage for this job (100% / Follow-up / Add-on). */
    workingStage: v.optional(v.union(v.literal("100%"), v.literal("Follow-up"), v.literal("Add-on"))),
  })
    .index("by_jobId", ["jobId"])
    .index("by_userId", ["userId"])
    .index("by_jobId_userId", ["jobId", "userId"])
    .index("by_jobId_assignmentRole", ["jobId", "assignmentRole"])
    .index("by_userId_isActive", ["userId", "isActive"]),

  // ■■ ROLE_AUDIT_LOG ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■
  roleAuditLog: defineTable({
    targetUserId: v.id("users"),
    changedBy: v.id("users"),
    fromRole: v.string(),
    toRole: v.string(),
    reason: v.optional(v.string()),
    occurredAt: v.string(),
  })
    .index("by_targetUserId", ["targetUserId"])
    .index("by_occurredAt", ["occurredAt"]),

  // ■■ CANDIDATE DEDUPLICATION IDENTITY LOCKS ■■■■■■■■■■■■■■■■■■■■■
  candidateLocks: defineTable({
    lockKey: v.string(), // e.g. "email:user@domain.com", "phone:+1234567890", "linkedin:slug"
    cvUploadId: v.id("cvUploads"),
    lockedAt: v.number(),
  })
    .index("by_lockKey", ["lockKey"])
    .index("by_cvUploadId", ["cvUploadId"]),

  // ■■ CANDIDATE INQUIRIES & QUESTIONS ■■■■■■■■■■■■■■■■■■■■■
  candidateInquiries: defineTable({
    candidateId: v.id("candidates"),
    applicationId: v.optional(v.id("applications")),
    jobId: v.optional(v.id("jobs")),
    communicationId: v.optional(v.id("communications")),
    
    channel: v.union(v.literal("whatsapp"), v.literal("email")),
    questionText: v.string(),
    category: v.union(
      v.literal("salary_compensation"),
      v.literal("visa_sponsorship"),
      v.literal("location_remote"),
      v.literal("notice_start_date"),
      v.literal("tech_stack"),
      v.literal("client_details"),
      v.literal("general_inquiry")
    ),
    importanceLevel: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
    
    status: v.union(
      v.literal("unresolved"),
      v.literal("answered_by_ai"),
      v.literal("resolved_by_ta")
    ),
    
    aiAutoReplyText: v.optional(v.string()),
    taResponseText: v.optional(v.string()),
    resolvedByUserId: v.optional(v.id("users")),
    resolvedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_candidateId", ["candidateId"])
    .index("by_applicationId", ["applicationId"])
    .index("by_jobId", ["jobId"])
    .index("by_channel", ["channel"])
    .index("by_status", ["status"])
    .index("by_importance", ["importanceLevel"]),

  // ■■ JOBS ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■
  jobs: defineTable({
    // Core Details
    title: v.string(),
    clientName: v.string(),
    clientIndustry: v.string(),
    recruitmentType: v.union(v.literal("headhunting"),
      v.literal("job_posting"),
      v.literal("both")),
    isConfidential: v.boolean(),
    jobDescription: v.string(),
    requiredSkills: v.array(v.string()),
    niceToHaveSkills: v.optional(v.array(v.string())),
    seniorityLevel: v.union(
      v.literal("entry_level"), v.literal("mid_level"),
      v.literal("executive"), v.literal("senior_executive"),
      v.literal("manager"), v.literal("senior_manager"),
      v.literal("agm"), v.literal("gm"),
      v.literal("director"), v.literal("c_suite"),
      v.literal("other")),
    experienceMinYears: v.number(),
    experienceMaxYears: v.optional(v.number()),
    location: v.string(),
    salaryMin: v.optional(v.number()),
    salaryMax: v.optional(v.number()),
    salaryCurrency: v.optional(v.string()),
    educationLevel: v.optional(v.string()),
    languagesRequired: v.optional(v.array(v.string())),

    // Routing & Identity
    keyword: v.string(), // UNIQUE — routing key for all agents
    status: v.union(v.literal("active"), v.literal("on_hold"),
      v.literal("filled"), v.literal("cancelled"),
      v.literal("draft")),

    // Ingestion Toggles
    pausedChannels: v.optional(v.array(v.string())),
    muteDefaultWhatsappReply: v.optional(v.boolean()),

    // Team Assignment
    primaryRecruiterId: v.id("users"),
    isAssignedTAExplicit: v.optional(v.boolean()), // True if manually assigned, false if defaulted to creator
    supportingRecruiterIds: v.optional(v.array(v.id("users"))),
    directorId: v.optional(v.id("users")),
    clientContactName: v.optional(v.string()),
    clientContactEmail: v.optional(v.string()),
    clientAccessLevel: v.optional(v.union(
      v.literal("view_only"), v.literal("view_comment"),
      v.literal("approve_reject"))),

    // Pipeline Gate Config
    directorReviewEnabled: v.boolean(),
    clientReviewEnabled: v.boolean(),
    esaCheckEnabled: v.boolean(),
    rejectionLoopAction: v.union(
      v.literal("restart_from_new_cvs"),
      v.literal("return_to_client_review"),
      v.literal("ask_ta_each_time")),

    // Agent 2 — AI Match Scoring Weights
    scoreWeightSkills: v.optional(v.number()), // default 35
    scoreWeightExperience: v.optional(v.number()), // default 15
    scoreWeightJobTitle: v.optional(v.number()), // default 30
    scoreWeightIndustry: v.optional(v.number()), // default 15
    scoreWeightLocation: v.optional(v.number()), // default 5
    minMatchScoreToShow: v.optional(v.number()), // default 60
    reverseMatchOnPublish: v.optional(v.boolean()),
    taPreferences: v.optional(v.string()),
    roleFamily: v.optional(v.string()),
    roleFamilyCacheFingerprint: v.optional(v.string()),
    usedFallbackTitle: v.optional(v.boolean()),
    currentRoleRank: v.optional(v.number()),
    currentRoleRankLabel: v.optional(v.string()),
    currentRoleConfidence: v.optional(v.string()),

    reverseMatchStatus: v.optional(v.union(
      v.literal("running"), v.literal("done"), v.literal("error")
    )),
    reverseMatchedAt: v.optional(v.string()),
    reverseMatchResults: v.optional(v.array(v.object({
      cvId: v.string(),
      overallScore: v.number(),
      breakdown: v.object({
        skills: v.number(), experience: v.number(), seniority: v.number(), industry: v.number(), location: v.number()
      }),
      matchedSkills: v.array(v.string()),
      missingSkills: v.array(v.string()),
      reason: v.string(),
      sourceLevel1: v.optional(v.string()),
      sourceLevel2: v.optional(v.string()),
      candidateName: v.optional(v.string()),
      candidateRole: v.optional(v.string()),
      candidateExp: v.optional(v.number()),
      // Agent 2 — Current-Role Level & Role-Family Gate Fields
      currentRoleRank: v.optional(v.number()),
      currentRoleRankLabel: v.optional(v.string()),
      currentRoleConfidence: v.optional(v.union(v.literal("high"), v.literal("medium"), v.literal("low"), v.string())),
      usedFallbackTitle: v.optional(v.boolean()),
      currentRoleGate: v.optional(v.union(
        v.literal("pass"), v.literal("pass_with_penalty"),
        v.literal("excluded_overqualified"), v.literal("skipped_other"), v.string()
      )),
      currentRolePenalty: v.optional(v.number()),
      seniorityConflict: v.optional(v.boolean()),
      exclusionReason: v.optional(v.union(v.string(), v.null())),
      roleFamily: v.optional(v.string()),
      roleFamilyMatch: v.optional(v.union(
        v.literal("exact"), v.literal("synonym"),
        v.literal("adjacent"), v.literal("unrelated"), v.string()
      )),
      currentRoleCacheFingerprint: v.optional(v.string()),

      // Dimension Breakdown Gate Fields
      seniorityGate: v.optional(v.string()),
      seniorityPenalty: v.optional(v.number()),
      experienceGate: v.optional(v.string()),
      experiencePenalty: v.optional(v.number()),
      industryGate: v.optional(v.string()),
      industryPenalty: v.optional(v.number()),
      locationGate: v.optional(v.string()),
      locationPenalty: v.optional(v.number()),
      locationStatus: v.optional(v.string()),
      skillsGate: v.optional(v.string()),
      skillsPenalty: v.optional(v.number()),
    }))),


    // Agent 3 — Follow-up Config (Dynamic AI Flow)
    enableWhatsAppFollowUp: v.optional(v.boolean()),
    enableEmailFollowUp: v.optional(v.boolean()),
    followUpInitialTemplate: v.optional(v.string()),
    followUpSampleTemplate: v.optional(v.string()),
    enableEmailFollowUpTemplate: v.optional(v.boolean()),
    followUpEmailSubjectTemplate: v.optional(v.string()),
    followUpEmailBodyTemplate: v.optional(v.string()),
    customFollowUpQuestions: v.optional(v.array(v.string())),
    maxFollowUpDays: v.optional(v.number()),
    maxFollowUpAttempts: v.optional(v.number()),
    /** Switched on from the TA System: a TA sends the first message, the sweep
     *  runs the reminders after it (convex/lib/followUpScope.ts). */
    followUpStartsOnSend: v.optional(v.boolean()),
    /** Set when a delete is under way (ta/openingDelete.ts): hidden from every list, removed in batches. */
    deletingAt: v.optional(v.number()),
    deletingBy: v.optional(v.id("users")),
    /** Set when someone pressed Delete (ta/bin.ts): hidden like a deleted
     *  opening, kept whole for seven days so it can be restored, then removed. */
    binnedAt: v.optional(v.number()),
    binnedBy: v.optional(v.id("users")),
    /** What Restore puts back — binning sets the status to cancelled so the
     *  follow-up sweep and CV routing leave the opening alone. */
    statusBeforeBin: v.optional(v.union(v.literal("active"), v.literal("on_hold"),
      v.literal("filled"), v.literal("cancelled"),
      v.literal("draft"))),
    conversationTone: v.optional(v.string()),

    agent3TriggerStages: v.optional(v.array(v.string())),
    agent3InitialChannel: v.optional(v.string()),
    agent3InitialMessage: v.optional(v.string()),
    agent3Day2Message: v.optional(v.string()),
    agent3Day4Message: v.optional(v.string()),
    agent3Day7Message: v.optional(v.string()),

    agent3Enabled: v.optional(v.boolean()),
    agent3TimeWindowStart: v.optional(v.string()),
    agent3TimeWindowEnd: v.optional(v.string()),
    agent3AllowedDays: v.optional(v.array(v.string())),
    agent3TimeZone: v.optional(v.string()),
    agent3CustomSteps: v.optional(v.array(v.object({
      id: v.string(),
      day: v.number(),
      channel: v.string(),
      emailSubject: v.string(),
      emailBody: v.string(),
      whatsappBody: v.string(),
    }))),
    agent3Day2Channel: v.optional(v.union(
      v.literal("email"), v.literal("whatsapp"), v.literal("sms"))),
    agent3Day4Channel: v.optional(v.union(
      v.literal("email"), v.literal("whatsapp"), v.literal("sms"))),
    agent3Day7Channel: v.optional(v.union(
      v.literal("email"), v.literal("whatsapp"), v.literal("sms"))),
    agent3AfterDay7: v.union(
      v.literal("mark_unresponsive"), v.literal("continue_weekly")),

    // Agent 5 — AI Phone Call Config
    agent5Enabled: v.optional(v.boolean()),
    agent5Trigger: v.union(
      v.literal("all_new_applicants"),
      v.literal("database_matches_70_plus"),
      v.literal("manual_only")),
    agent5CallScript: v.union(
      v.literal("default"), v.literal("initial_screening"),
      v.literal("technical_prescreen")),
    agent5CustomQuestions: v.optional(v.array(v.string())),
    agent5NoAnswerAction: v.union(
      v.literal("trigger_agent3"),
      v.literal("retry_after_2hrs"),
      v.literal("notify_ta")),
    agent5HideCompany: v.optional(v.boolean()),

    // Agent 3 — Outbound TA Identity
    outreachWhatsAppNumber: v.optional(v.string()),
    /*
     * Hold the first WhatsApp back this many days and let email go alone.
     *
     * Day 0 sent both, so every candidate cost a template even when the email
     * would have done. Unset keeps the old behaviour.
     */
    whatsappAfterEmailDays: v.optional(v.number()),

    // SLA Thresholds (days)
    slaNoNewCvsDays: v.optional(v.number()),
    slaTaReviewDays: v.optional(v.number()),
    slaAiCallDays: v.optional(v.number()),
    slaSecondShortlistDays: v.optional(v.number()),
    slaDirectorReviewDays: v.optional(v.number()),
    slaEsaDays: v.optional(v.number()),
    slaClientReviewDays: v.optional(v.number()),
    slaInterviewDays: v.optional(v.number()),
    slaOfferDays: v.optional(v.number()),

    // Headhunting
    headhuntingEnabled: v.boolean(),
    benchmarkProfileUrl: v.optional(v.string()),

    // Aggregated Stats
    stageCounts: v.optional(v.any()),
    totalApplications: v.optional(v.number()),

    // AI Embedding (set async after creation)
    embedding: v.optional(v.array(v.number())),

    // ── TA platform: a `jobs` row IS an Opening ────────────────────────────
    // Added for the new UI. All optional, so every existing row stays valid
    // and the old modules are untouched. `clientName` remains the legacy free
    // text; `clientId` is the normalised record the new Clients screen reads.
    clientId: v.optional(v.id("clients")),
    positionCode: v.optional(v.string()),
    jobOrderNumber: v.optional(v.string()),
    /** The new platform gates scoring on an approved JD — see lib/assessment. */
    jdStatus: v.optional(v.union(
      v.literal("draft"),
      v.literal("pending_ta_approval"),
      v.literal("approved"),
    )),
    jdApprovedBy: v.optional(v.id("users")),
    jdApprovedAt: v.optional(v.number()),
    briefId: v.optional(v.id("briefs")),
    /** P1–P5, driving the "day N of target" counters. */
    priorityTier: v.optional(v.string()),
    /** The Master Sheet column, kept in step with `status`. */
    positionStatus: v.optional(v.string()),
    /** Whose passport, not where the job is. */
    targetNationalities: v.optional(v.array(v.string())),
    targetGender: v.optional(v.union(v.string(), v.null())),
    headcount: v.optional(v.number()),
    /** The TA's own follow-up questions for this opening. */
    followUpQuestions: v.optional(v.array(v.object({
      id: v.string(),
      label: v.string(),
    }))),
    /**
     * The structured requirements (skills, seniority, years, location, salary,
     * education, languages, industry) as extracted from the approved JD.
     * `requirementsLockedFields` names what a person corrected by hand — an
     * automatic re-extraction fills blanks around them and never overwrites them.
     */
    requirementsStatus: v.optional(v.union(
      v.literal("extracting"),
      v.literal("extracted"),
      v.literal("failed"),
    )),
    requirementsExtractedAt: v.optional(v.number()),
    requirementsModel: v.optional(v.string()),
    requirementsError: v.optional(v.string()),
    requirementsLockedFields: v.optional(v.array(v.string())),
    requirementsEditedBy: v.optional(v.id("users")),
    requirementsEditedAt: v.optional(v.number()),
    taLeadId: v.optional(v.id("users")),
    /** Denormalised mirror of jobAssignments, as the new UI reads it. */
    assignedTaIds: v.optional(v.array(v.id("users"))),
    // Commercial pipeline value — Master Sheet columns.
    valueOnProgressing: v.optional(v.number()),
    valueOfPlacement: v.optional(v.number()),
    valueLost: v.optional(v.number()),
    requirementReceivedAt: v.optional(v.number()),
    assignedAt: v.optional(v.number()),
    closedAt: v.optional(v.number()),

    // Timestamps
    createdAt: v.string(),
    publishedAt: v.optional(v.string()),
    filledAt: v.optional(v.string()),
    updatedAt: v.string(),
    // TA System — package notes the lead writes on the opening, and every
    // place it can be worked from (`location` holds the first, for the engines).
    packageNotes: v.optional(v.string()),
    taLocations: v.optional(v.array(v.string())),
  })
    .index("by_keyword", ["keyword"])
    .index("by_status", ["status"])
    .index("by_recruiter", ["primaryRecruiterId"])
    .index("by_client", ["clientName"])
    .index("by_clientId", ["clientId"])
    .index("by_createdAt", ["createdAt"])
    .index("by_binnedAt", ["binnedAt"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["status", "primaryRecruiterId"]
    }),

  // ■■ JOB_CHANNELS ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■
  jobChannels: defineTable({
    jobId: v.id("jobs"),
    channelType: v.string(), // whatsapp | meta_campaign | email_campaign | linkedin | workable | manual_upload | headhunting
    isEnabled: v.boolean(),
    whatsappNumber: v.optional(v.string()),
    metaCampaignId: v.optional(v.string()),
    emailInbox: v.optional(v.string()),
    workableJobId: v.optional(v.string()),
    lastCvReceivedAt: v.optional(v.number()),
    cvCountToday: v.number(),
    cvCountTotal: v.number(),
    agentStatus: v.string(), // active | paused | error | not_configured
    lastError: v.optional(v.string()),

    configuredSourceLevel2: v.optional(v.string()),

    createdAt: v.string(),
  })
    .index("by_job", ["jobId"])
    .index("by_whatsapp", ["whatsappNumber"])
    .index("by_email", ["emailInbox"])
    .index("by_workable", ["workableJobId"]),

  // ■■ JOB_ASSETS ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■
  job_assets: defineTable({
    jobId: v.id("jobs"),
    whatsappQrUrl: v.optional(v.string()),

    whatsappQrStorageId: v.optional(v.id("_storage")),
    channelConfigHash: v.optional(v.string()),

    whatsappQrPdfUrl: v.optional(v.string()),
    whatsappDeepLink: v.optional(v.string()),
    shortApplyLink: v.optional(v.string()),
    metaAdLink: v.optional(v.string()),
    emailApplyAddress: v.optional(v.string()),
    linkedinJobTitle: v.optional(v.string()),
    linkedinIntakeEmail: v.string(), // always linkedin@career141.com
    fullPosterPdfUrl: v.optional(v.string()),
    fullPosterPngUrl: v.optional(v.string()),
    generatedAt: v.string(),
    generatedFromChannelHash: v.string(),
  })
    .index("by_jobId", ["jobId"]),

  // ■■ CUSTOM_FILTERS ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■
  custom_filters: defineTable({
    jobId: v.id("jobs"),
    filterType: v.union(
      v.literal("qualification"), v.literal("skill"),
      v.literal("license"), v.literal("language"),
      v.literal("company_type")),
    filterValue: v.string(),
    source: v.union(
      v.literal("ai_extracted"), v.literal("manual"),
      v.literal("from_previous_job")),
    isActive: v.boolean(),
    savedToLibrary: v.boolean(),
    createdBy: v.optional(v.id("users")),
    createdAt: v.string(),
  })
    .index("by_jobId", ["jobId"])
    .index("by_createdBy", ["createdBy"]),

  // ■■ SAVED_FILTERS ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■
  saved_filters: defineTable({
    filterType: v.union(
      v.literal("qualification"), v.literal("skill"),
      v.literal("license"), v.literal("language"),
      v.literal("company_type")),
    filterValue: v.string(),
    usageCount: v.number(),
    industries: v.optional(v.array(v.string())),
    createdBy: v.optional(v.id("users")),
    createdAt: v.string(),
    lastUsedAt: v.optional(v.string()),
  })
    .index("by_usageCount", ["usageCount"])
    .index("by_createdBy", ["createdBy"]),

  // ■■ MATCH_SCORES ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■
  match_scores: defineTable({
    candidateId: v.id("candidates"),
    jobId: v.id("jobs"),
    applicationId: v.optional(v.id("applications")),
    score: v.number(),
    scoreBreakdown: v.optional(v.object({
      skills: v.number(),
      experience: v.number(),
      jobTitle: v.number(),
      industry: v.number(),
      location: v.number(),
    })),
    explanation: v.optional(v.string()),
    trigger: v.union(
      v.literal("job_published"), v.literal("job_opened"),
      v.literal("search"), v.literal("manual_rescore")),
    scoredAt: v.string(),
    scoreSource: v.optional(v.string()),
    scoredBy: v.optional(v.string()),
  })
    .index("by_job_score", ["jobId", "score"])
    .index("by_candidate_job", ["candidateId", "jobId"])
    .index("by_candidateId", ["candidateId"]),

  // ■■ PIPELINE_HEALTH_REPORTS ■■■■■■■■■■■■■■■■■■■■■■■■■■■
  pipeline_health_reports: defineTable({
    jobId: v.id("jobs"),
    reportDate: v.string(),
    healthScore: v.number(),
    cvFlowScore: v.number(),
    outreachScore: v.number(),
    reviewSpeedScore: v.number(),
    placementScore: v.number(),
    activeAlerts: v.optional(v.array(v.any())),
    stageCounts: v.any(),
    daysOpen: v.number(),
    newCvsLast7Days: v.number(),
    generatedAt: v.string(),
  })
    .index("by_job_date", ["jobId", "reportDate"]),

  cvUploads: defineTable({
    storageId: v.optional(v.id("_storage")),
    s3Key: v.optional(v.string()), // Added for Cloudflare R2
    storageProvider: v.optional(v.string()), // 'convex' | 'r2'
    fileName: v.string(),
    fileSize: v.float64(),
    fileType: v.string(),
    fileHash: v.optional(v.string()),
    source: v.optional(v.string()),
    campaignLabel: v.optional(v.string()),
    metaSourceUrl: v.optional(v.string()),
    metaSourceId: v.optional(v.string()),
    metaHeadline: v.optional(v.string()),
    assignToJob: v.optional(v.string()),
    // Post routing on the shared mailboxes (pipeline/postFiling.ts, 22 Sep):
    // the advert the email matched, the other openings that advert serves, and
    // how it was decided.
    assignToJobPost: v.optional(v.string()),
    alsoAssignTo: v.optional(v.array(v.object({ jobId: v.string(), jobPostId: v.string() }))),
    routeNote: v.optional(v.string()),
    uploadedBy: v.string(),
    /** Set when a TA uploads a headhunted CV from TA Follow-up (ta/hhUpload.ts):
     *  once the extraction has filed it on `assignToJob`, it is claimed by this
     *  TA into TA Follow-up and flagged HH. */
    headhuntedBy: v.optional(v.id("users")),
    /** Set when a TA replaces a candidate's CV (ta/cv.ts attach, 29 Sep):
     *  extraction then only fills that candidate's empty fields, and does not
     *  match them to other jobs (convex/lib/fillBlanks.ts). */
    replaceKeepDetails: v.optional(v.boolean()),
    /** Set on a CV that arrived at shortlists@ (mailIntake/process.ts, 2 Oct).
     *  It is our own Prepared CV, CAREER141 box on it, sent back to us. When it
     *  matches someone we hold it is only a record of what was sent: it writes
     *  nothing onto them and does not replace their CV file. */
    shortlistCopy: v.optional(v.boolean()),
    /** A newer CV of the same person took this file's place (cvs/cvReplace.ts, 2 Oct). The file is kept (5 Oct). */
    replacedByUploadId: v.optional(v.id("cvUploads")),
    /** An extraction is reading this upload right now (cvs/cvUploads.ts lockExtraction, 2 Oct). */
    extractionLockedAt: v.optional(v.number()),
    /** Set when a TA uploads a scoop CV from the opening's Scoops page
     *  (ta/scoopUpload.ts, 29 Sep): once the extraction has filed it on
     *  `assignToJob`, the application is flagged as a scoop. `scoopFromUserId`
     *  is the lead who sent it, when the TA said. */
    scoopedBy: v.optional(v.id("users")),
    scoopFromUserId: v.optional(v.id("users")),
    status: v.string(),
    errorMessage: v.optional(v.string()),
    candidateId: v.optional(v.id("candidates")),
    batchId: v.optional(v.id("ingestionBatches")),
    isHealAttempted: v.optional(v.boolean()),
    processingStartedAt: v.optional(v.number()), // Timestamp when extraction action began; used by stuck-upload recovery
    extractionAttempts: v.optional(v.number()), // Number of extraction attempts (max 1 retry)
    lastAttemptAt: v.optional(v.number()), // Timestamp of last extraction attempt
    healAttempts: v.optional(v.number()), // Number of times the background healer dispatched extraction
    lastHealAt: v.optional(v.number()), // Timestamp of the latest healer dispatch; used to detect stuck "healing"
  })
    .index("by_uploadedBy", ["uploadedBy"])
    .index("by_status", ["status"])
    .index("by_fileHash", ["fileHash"])
    .index("by_batchId", ["batchId"])
    .index("by_candidateId", ["candidateId"])
    .index("by_storageId", ["storageId"])
    .index("by_s3Key", ["s3Key"])
    .index("by_source_fileName", ["source", "fileName"])
    .index("by_fileName", ["fileName"])
    .index("by_isHealAttempted", ["isHealAttempted"]),

  folderImportProgress: defineTable({
    sourceChannel: v.string(),
    rootFolderName: v.optional(v.string()),
    lastProcessedIndex: v.number(),
    lastProcessedFolderName: v.string(),
    totalDiscoveredFolders: v.optional(v.number()),
    uploadedCount: v.number(),
    skippedCount: v.number(),
    failedCount: v.number(),
    updatedAt: v.number(),
  })
    .index("by_sourceChannel", ["sourceChannel"])
    .index("by_channel_folder", ["sourceChannel", "rootFolderName"]),

  candidateResumes: defineTable({
    candidateId: v.id("candidates"),
    rawText: v.optional(v.string()),
    rawTextKey: v.optional(v.string()),
    jobHistory: v.optional(v.array(v.object({
      company: v.string(),
      title: v.string(),
      startDate: v.optional(v.string()),
      endDate: v.optional(v.string()),
      description: v.optional(v.string()),
    }))),
    embedding: v.optional(v.array(v.float64())),
    hasEmbedding: v.optional(v.boolean()),
  })
    .index("by_candidateId", ["candidateId"])
    .index("by_hasEmbedding", ["hasEmbedding"])
    .searchIndex("search_text", {
      searchField: "rawText",
    })
    .vectorIndex("vector_index_candidates", {
      vectorField: "embedding",
      dimensions: 1024,
    }),

  referees: defineTable({
    candidateId: v.id("candidates"),
    name: v.string(),
    designation: v.optional(v.string()),
    company: v.optional(v.string()),
    contactNo: v.optional(v.string()),
    email: v.optional(v.string()),
    relationship: v.optional(v.string()),
    notes: v.optional(v.string()),
    createdAt: v.string(),
    // TA System.
    contactable: v.optional(v.boolean()),
    lastContactedAt: v.optional(v.number()),
    extractedAt: v.optional(v.number()),
  })
    .index("by_candidateId", ["candidateId"])
    // Referral Search (8 Oct): "HR managers at Dialog" across ~33,000 referees.
    // Before these, the only way to find a referee by company was to read the
    // first 500 rows (ta/candidates:peopleAtCompany).
    .searchIndex("search_company", { searchField: "company" })
    .searchIndex("search_designation", { searchField: "designation" })
    .searchIndex("search_name", { searchField: "name" }),

  candidates: defineTable({
    // New fields from PDF (kept optional to avoid breaking existing queries)
    fullName: v.optional(v.string()),
    isParsed: v.optional(v.boolean()),
    isHealAttempted: v.optional(v.boolean()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    phoneClean: v.optional(v.string()),
    activeApplicationsSummary: v.optional(
      v.array(
        v.object({
          jobId: v.id("jobs"),
          jobTitle: v.string(),
          stage: v.string(),
          isActive: v.boolean(),
        })
      )
    ),
    location: v.optional(v.string()),
    locationStructured: v.optional(
      v.object({
        raw_text: v.string(),
        city: v.union(v.string(), v.null()),
        region: v.union(v.string(), v.null()),
        country: v.union(v.string(), v.null()),
      })
    ),
    linkedinUrl: v.optional(v.string()),
    currentJobTitle: v.optional(v.string()),
    currentEmployer: v.optional(v.string()),
    totalExperienceYears: v.optional(v.number()),
    skills: v.optional(v.array(v.string())),
    educationDegree: v.optional(v.string()),
    educationInstitution: v.optional(v.string()),
    educationYear: v.optional(v.number()),
    certifications: v.optional(v.array(v.string())),
    languages: v.optional(v.array(v.string())),
    expectedSalary: v.optional(v.number()),
    expectedSalaryCurrency: v.optional(v.string()),
    currentSalary: v.optional(v.number()),
    currentSalaryCurrency: v.optional(v.string()),
    /*
     * What the candidate said when it was not a figure.
     *
     * "Negotiable", "open to discuss", "I'd rather not say" are answers. With
     * nowhere to put them the follow-up treated the question as unanswered and
     * asked again, and again — a real candidate was asked for a number four
     * times in eleven minutes (23 September). Storing the words lets the
     * checklist close and the chase stop; a TA reads the note and takes it from
     * there.
     */
    currentSalaryNote: v.optional(v.string()),
    expectedSalaryNote: v.optional(v.string()),
    noticePeriodDays: v.optional(v.number()),
    availability: v.optional(v.string()),
    firstSourceChannel: v.optional(
      v.union(
        v.literal("whatsapp"),
        v.literal("meta_campaign"),
        v.literal("email"),
        v.literal("email_campaign"),
        v.literal("linkedin"),
        v.literal("workable"),
        v.literal("manual_upload"),
        v.literal("headhunting")
      )
    ),
    firstSourceJobId: v.optional(v.id("jobs")),
    firstSeenAt: v.optional(v.number()),
    lastUpdatedAt: v.optional(v.number()),
    parsingConfidence: v.optional(v.any()),
    usedFallbackTitle: v.optional(v.boolean()),
    currentRoleCacheFingerprint: v.optional(v.string()),
    currentRoleConfidence: v.optional(v.string()),
    currentRoleRankLabel: v.optional(v.string()),
    currentRoleRank: v.optional(v.number()),
    roleFamily: v.optional(v.string()),
    fieldsNeedingReview: v.optional(v.array(v.string())),
    isDuplicateOf: v.optional(v.id("candidates")),
    mergedInto: v.optional(v.id("candidates")),
    // The upload whose file was lost in the Convex Cloud move; while it is
    // still `cvUploadId` the candidate is kept out of search (src/lib/cvMissing.ts).
    cvMissingUploadId: v.optional(v.id("cvUploads")),
    vectorEmbeddingId: v.optional(v.string()),
    pastJobTitles: v.optional(v.array(v.string())),
    // Every employer, current first, joined with " | " (lib/employers). Kept by
    // refreshEmployersText; searched by search_employers_all (9 Oct).
    employersText: v.optional(v.string()),
    sector: v.optional(v.string()),
    overallStatus: v.optional(
      v.union(
        v.literal("active"),
        v.literal("placed"),
        v.literal("not_available"),
        v.literal("merged"),
        v.literal("new_cvs"),
        v.literal("matched_candidates"),
        v.literal("ta_shortlist"),
        v.literal("shortlisted"),
        v.literal("ai_call"),
        v.literal("follow_up"),
        v.literal("second_shortlist"),
        v.literal("director_shortlist"),
        v.literal("client_review"),
        v.literal("interview"),
        v.literal("offer"),
        v.literal("rejected"),
        v.literal("unresponsive")
      )
    ),

    // Existing legacy fields to prevent breaking changes
    status: v.optional(v.string()),
    isArchivedLocally: v.optional(v.boolean()),
    currentTitle: v.optional(v.string()),
    seniorityLevel: v.optional(v.string()),
    yearsOfExperience: v.optional(v.float64()),
    industries: v.optional(v.array(v.string())),
    noticePeriod: v.optional(v.string()),
    employmentStatus: v.optional(v.string()),
    education: v.optional(
      v.array(
        v.object({
          degree: v.optional(v.string()),
          institution: v.optional(v.string()),
          year: v.optional(v.any()),
          field: v.optional(v.string()),
        })
      )
    ),
    jobHistory: v.optional(
      v.array(
        v.object({
          title: v.optional(v.string()),
          company: v.optional(v.string()),
          startDate: v.optional(v.string()),
          endDate: v.optional(v.string()),
          description: v.optional(v.string()),
        })
      )
    ),
    workableCandidateId: v.optional(v.string()),
    extractionModel: v.optional(v.string()),
    sourceChannel: v.optional(v.string()),
    fileHash: v.optional(v.string()),
    summary: v.optional(v.string()),
    cvUploadId: v.optional(v.id("cvUploads")),
    candidateConsent: v.optional(v.boolean()),
    doNotContact: v.optional(v.boolean()),
    doNotContactReason: v.optional(v.string()),
    doNotContactAt: v.optional(v.number()),
    rawText: v.optional(v.string()),
    rawTextKey: v.optional(v.string()),
    hasEmbedding: v.optional(v.boolean()),
    candidateQuestions: v.optional(v.string()),
    customCallData: v.optional(v.any()),
    // TA System — fields the desk records that extraction does not. Salaries
    // arrive as the candidate said them ("250k", "LKR 250,000 plus car"), so the
    // words are kept alongside the numbers the engines read.
    nationality: v.optional(v.string()),
    age: v.optional(v.number()),
    // Read from the CV (convex/lib/candidateAge, 28 Sep): the age is worked
    // out from this on the day it is shown, so it never goes stale.
    dateOfBirth: v.optional(v.string()),
    dateOfBirthSource: v.optional(v.string()),
    // When the CV's stated date and its NIC disagree.
    dateOfBirthNote: v.optional(v.string()),
    // "Male" / "Female". Extraction fills it when the CV states it, the NIC
    // encodes it, or a title or pronoun gives it (convex/cvs/genderFromCv.ts) —
    // blanks only; the desk's value wins. genderSource says which:
    // cv_stated | nic | cv_llm | desk.
    gender: v.optional(v.string()),
    genderSource: v.optional(v.string()),
    englishLevel: v.optional(v.number()),
    cvFileName: v.optional(v.string()),
    taCurrentSalaryText: v.optional(v.string()),
    taExpectedSalaryText: v.optional(v.string()),
  })
    .index("by_email", ["email"])
    .index("by_phone", ["phone"])
    .index("by_phoneClean", ["phoneClean"])
    .index("by_status", ["status"])
    .index("by_workableCandidateId", ["workableCandidateId"])
    .index("by_fullName", ["fullName"])
    .index("by_fileHash", ["fileHash"])
    .index("by_cvUploadId", ["cvUploadId"])
    .index("by_linkedinUrl", ["linkedinUrl"])
    .index("by_overallStatus", ["overallStatus"])
    .index("by_lastUpdatedAt", ["lastUpdatedAt"])
    .index("by_firstSeenAt", ["firstSeenAt"])
    .index("by_extractionModel", ["extractionModel"])
    .index("by_sourceChannel", ["sourceChannel"])
    .index("by_firstSourceChannel", ["firstSourceChannel"])
    .index("by_isHealAttempted", ["isHealAttempted"])
    .index("by_isParsed", ["isParsed"])
    // Deleting an opening clears it as their first source (ta/openingDelete.ts, 2 Oct).
    .index("by_firstSourceJobId", ["firstSourceJobId"])
    .searchIndex("search_skills", {
      searchField: "skills",
    })
    .searchIndex("search_title", {
      searchField: "currentJobTitle",
    })
    .searchIndex("search_summary", {
      searchField: "summary",
    })
    .searchIndex("search_name", {
      searchField: "fullName",
    })
    // Company Reference tab (ta/candidates:peopleAtCompany): everyone in the
    // database at a company, not just the newest few hundred (24 Sep).
    .searchIndex("search_employer", {
      searchField: "currentEmployer",
    })
    // Database search by company, now or before: "HR personnel in Dialog" (9 Oct).
    .searchIndex("search_employers_all", {
      searchField: "employersText",
    }),

  applications: defineTable({
    candidateId: v.id("candidates"),
    jobId: v.id("jobs"),
    cvFileId: v.optional(v.id("cvUploads")), // Keeping cvUploads instead of cvFiles to match existing table
    sourceChannel: v.string(), // linkedin | whatsapp | meta_campaign | email_campaign | workable | manual_upload | headhunting
    candidateName: v.optional(v.string()),
    candidateEmail: v.optional(v.string()),
    candidatePhone: v.optional(v.string()),
    cvFileName: v.optional(v.string()),
    candidateTitle: v.optional(v.string()),
    candidateExperience: v.optional(v.number()),
    candidateCvUploadId: v.optional(v.id("cvUploads")),
    candidateCurrentSalary: v.optional(v.number()),
    candidateExpectedSalary: v.optional(v.number()),
    candidateNoticePeriodDays: v.optional(v.number()),

    currentStage: v.union(
      v.literal("new_cvs"),
      v.literal("matched_candidates"),
      v.literal("ta_shortlist"),
      v.literal("ai_call"),
      v.literal("follow_up"),
      v.literal("second_shortlist"),
      v.literal("director_shortlist"),
      v.literal("client_review"),
      v.literal("interview"),
      v.literal("offer"),
      v.literal("placed"),
      v.literal("rejected"),
      v.literal("unresponsive")
    ),
    aiMatchScore: v.optional(v.number()),
    aiMatchExplanation: v.optional(v.string()),
    manualCallOutcome: v.optional(v.string()),
    taShortlistStatus: v.optional(
      v.union(v.literal("pending"), v.literal("shortlisted"), v.literal("rejected"))
    ),
    taShortlistById: v.optional(v.id("users")),
    taShortlistAt: v.optional(v.number()),
    taRejectionReason: v.optional(v.string()),
    aiCallStatus: v.optional(v.string()),
    aiCallId: v.optional(v.string()),
    secondShortlistStatus: v.optional(
      v.union(v.literal("pending"), v.literal("shortlisted"), v.literal("rejected"))
    ),
    secondShortlistById: v.optional(v.id("users")),
    secondShortlistAt: v.optional(v.number()),
    secondRejectReason: v.optional(v.string()),
    directorReviewId: v.optional(v.string()),
    stageHistory: v.optional(v.array(
      v.object({
        stage: v.string(),
        enteredAt: v.string(),
        changedBy: v.union(v.id("users"), v.literal("system")),
        note: v.optional(v.string()),
      })
    )),
    clientReviewId: v.optional(v.string()),
    interviewId: v.optional(v.string()),
    offerId: v.optional(v.string()),
    loopIteration: v.number(),
    isActive: v.boolean(),
    notes: v.optional(v.string()),
    createdAt: v.union(v.number(), v.string()),
    lastStageChangedAt: v.number(),
    followUpState: v.optional(v.object({
      lastContactDay: v.number(),
      firstChannelUsed: v.optional(v.string()),
      replyChannel: v.optional(v.string()),
    })),
    followUpAttemptCount: v.optional(v.number()),
    /** The TA System's last manual follow-up round: when, and on which channels (lib/followUpScope.ts). */
    followUpLastManualSendAt: v.optional(v.number()),
    followUpLastManualChannels: v.optional(v.array(v.string())),
    nextFollowUpScheduledAt: v.optional(v.number()),
    nextFollowUpMessage: v.optional(v.string()),
    promisedEtaTimestamp: v.optional(v.number()),
    lastCandidateEmailMessageId: v.optional(v.string()),
    flaggedForTaReview: v.optional(v.boolean()),
    taReviewReason: v.optional(v.string()),
    // Per-application follow-up completion flags (scoped per-job to avoid cross-job contamination)
    followUpCvReceived: v.optional(v.boolean()),
    followUpCurrentSalary: v.optional(v.boolean()),
    followUpExpectedSalary: v.optional(v.boolean()),
    followUpNoticePeriod: v.optional(v.boolean()),
    customFollowUpAnswers: v.optional(v.record(v.string(), v.string())), // Maps question to candidate's answer
    followUpEnteredAt: v.optional(v.number()),    // timestamp when candidate entered follow_up stage
    followUpAiCallAttempts: v.optional(v.number()), // count of AI call retries within follow_up
    rejectedFromStage: v.optional(v.string()),
    aiCallIvrResponse: v.optional(v.string()),
    salaryNoticeEditHistory: v.optional(v.array(v.object({
      field: v.string(),
      oldValue: v.string(),
      newValue: v.string(),
      editedBy: v.id("users"),
      editedAt: v.string(),
    }))),
    metaCampaignId: v.optional(v.string()),
    metaAdsetId: v.optional(v.string()),
    metaAdId: v.optional(v.string()),
    metaConversionSentFor: v.optional(v.array(v.string())),
    // ETA & Follow-up tracking fields
    candidateEtaMs: v.optional(v.number()),
    candidateEtaText: v.optional(v.string()),
    waitingForCandidateEta: v.optional(v.boolean()),
    lastCandidateReplyAt: v.optional(v.number()),
    rejectedBy: v.optional(v.union(v.id("users"), v.literal("system"))),
    rejectedAt: v.optional(v.number()),
    rejectReason: v.optional(v.string()),
    /** The person applied to this opening again (applications.createApplication, 2 Oct). Their stage is not changed. */
    reappliedAt: v.optional(v.number()),
    placedAt: v.optional(v.number()),
    placedBy: v.optional(v.id("users")),
    aiFollowUpNoReply: v.optional(v.boolean()),

    // ── TA platform ───────────────────────────────────────────────────────
    // `currentStage` above stays the one stored stage, so the follow-up cron,
    // the state machine and the Meta events keep working untouched. The new
    // UI translates it through src/lib/stageMap.ts.
    /** Which advert under the opening this application came through. */
    jobPostId: v.optional(v.id("jobPosts")),
    /** First TA to shortlist owns it — the collision lock. Set in the same
     *  write as `shortlistedAt`. */
    ownerTaId: v.optional(v.id("users")),
    shortlistedAt: v.optional(v.number()),
    /** Five or more closes a set, per opening per recruiter. */
    setNumber: v.optional(v.union(v.number(), v.null())),
    /** Answers to the opening's own follow-up questions, by question id. */
    answers: v.optional(v.record(v.string(), v.string())),
    /** The Guidelines tab's channel code: DA | IM | FB | E | L | HH | SCOOP.
     *  Kept beside the legacy free-text `sourceChannel`, never replacing it. */
    taSourcingChannel: v.optional(v.string()),
    /** A profile worked beyond the assigned scope of the role. */
    isAddOn: v.optional(v.boolean()),
    addedOnAt: v.optional(v.number()),
    // A scoop: another TA brought this CV in (plan 6.4, 21 Sep). Credited to
    // them on their end-of-day L-sheet; the owner is unchanged.
    scoopByUserId: v.optional(v.string()),
    scoopAt: v.optional(v.number()),
    // A scoop sent TO the owner: the Director, a TA Lead or Ops mailed the CV
    // to the TA's own mailbox (mailIntake, 27 Sep). Counted on the owner's
    // end-of-day SCOOP. Not the `SCOOP` channel, which is a database pick.
    scoopFromUserId: v.optional(v.id("users")),
    scoopReceivedAt: v.optional(v.number()),
    /** Cover for someone who declined, and the decline that started the search. */
    backupForApplicationId: v.optional(v.id("applications")),
    offerDeclinedAt: v.optional(v.number()),
    offerDeclineReason: v.optional(v.string()),
    // Parked, carried so no migration is needed when they are defined.
    rankTier: v.optional(v.union(v.string(), v.null())),
    rankWeight: v.optional(v.union(v.number(), v.null())),
    statusA: v.optional(v.union(v.string(), v.null())),
    statusB: v.optional(v.union(v.string(), v.null())),
    droppedOutReason: v.optional(v.string()),
    // TA System — a recruiter's rating and running notes on this application.
    rating: v.optional(v.union(v.number(), v.null())),
    taNotes: v.optional(v.array(v.string())),
    // Where the TA dragged the CAREER141 box on the Prepared CV, in PDF points
    // from page 1's top-left (29 Sep). Absent: placed automatically.
    taPreparedCvBox: v.optional(v.object({ x: v.number(), y: v.number() })),
    // Why a database match was picked, one line, shown on its Database CVs
    // row (5 Oct). Written by Claude when it is on, else the reverse-match
    // engine's own reason.
    taMatchReason: v.optional(v.string()),
    // The model's 0–100 score for that match, shown as the row's fit and used
    // for its order (5 Oct). Absent when the engine's score was used.
    taMatchScore: v.optional(v.number()),
    // Notes left on this person in Director review by a TA, lead, director or
    // admin (29 Sep). `byRole` is the role at the time, as on link-vault notes.
    reviewNotes: v.optional(v.array(v.object({
      id: v.string(),
      at: v.number(),
      note: v.string(),
      by: v.id("users"),
      byRole: v.string(),
    }))),
  })
    .index("by_jobId", ["jobId"])
    .index("by_job_stage", ["jobId", "currentStage"])
    .index("by_candidateId", ["candidateId"])
    .index("by_job_source", ["jobId", "sourceChannel"])
    .index("by_job_score", ["jobId", "aiMatchScore"])
    .index("by_job_active", ["jobId", "isActive"])
    .index("by_job_stage_changed", ["jobId", "lastStageChangedAt"])
    .index("by_candidate_job", ["candidateId", "jobId"])
    .index("by_stage", ["currentStage"])
    .index("by_active", ["isActive"])
    .index("by_jobPostId", ["jobPostId"])
    .index("by_owner", ["ownerTaId"]),

  pipelineEvents: defineTable({
    applicationId: v.optional(v.id("applications")),
    candidateId: v.optional(v.id("candidates")),
    jobId: v.id("jobs"),
    eventType: v.string(),
    fromStage: v.optional(v.string()),
    toStage: v.optional(v.string()),
    actorType: v.union(v.literal("user"), v.literal("agent"), v.literal("system")),
    actorId: v.optional(v.id("users")),
    actorAgent: v.optional(v.string()),
    notes: v.optional(v.string()),
    metadata: v.optional(v.string()), // JSON stringified

    cvId: v.optional(v.id("cvs")),
    actorName: v.optional(v.string()),
    note: v.optional(v.string()),
    isBackwardMove: v.optional(v.boolean()),

    createdAt: v.number(),
    // TA System — who acted, in the desk's own terms (director, client).
    taActorType: v.optional(v.string()),
  })
    .index("by_application", ["applicationId"])
    .index("by_candidate", ["candidateId"])
    .index("by_application_time", ["applicationId", "createdAt"])
    .index("by_candidate_time", ["candidateId", "createdAt"])
    .index("by_job_time", ["jobId", "createdAt"])
    .index("by_event_type", ["eventType"]),

  aiCalls: defineTable({
    candidateId: v.id("candidates"),
    applicationId: v.optional(v.id("applications")),
    jobId: v.id("jobs"),
    triggeredBy: v.optional(v.id("users")),
    triggerType: v.union(
      v.literal("automatic_new_applicant"),
      v.literal("automatic_database_match"),
      v.literal("manual_ta_trigger"),
      v.literal("followup_retry")
    ),
    callStatus: v.union(
      v.literal("scheduled"),
      v.literal("in_progress"),
      v.literal("completed"),
      v.literal("no_answer"),
      v.literal("failed"),
      v.literal("declined")
    ),
    ivrResponse: v.optional(
      v.union(
        v.literal("pressed_1_interested"),
        v.literal("pressed_2_declined"),
        v.literal("pressed_3_connect_recruiter"),
        v.literal("no_response")
      )
    ),
    callDurationSeconds: v.optional(v.number()),
    recordingUrl: v.optional(v.string()),
    transcript: v.optional(v.string()),
    currentSalary: v.optional(v.number()),
    currentSalaryCurrency: v.optional(v.string()),
    expectedSalary: v.optional(v.number()),
    expectedSalaryCurrency: v.optional(v.string()),
    noticePeriodDays: v.optional(v.number()),
    availability: v.optional(v.string()),
    customQuestionAnswers: v.optional(
      v.array(v.object({ question: v.string(), answer: v.string() }))
    ),
    callScriptUsed: v.union(
      v.literal("default"),
      v.literal("initial_screening"),
      v.literal("technical_prescreen")
    ),
    companyHidden: v.boolean(),
    twilioCallSid: v.optional(v.string()),
    calledAt: v.number(),
    completedAt: v.optional(v.number()),
    followUpTriggered: v.boolean(),
    attempts: v.optional(v.number()),
    firstAttemptAt: v.optional(v.number()),
    attemptNumber: v.optional(v.number()),
    elevenlabsConversationId: v.optional(v.string()),
    elevenlabsAgentId: v.optional(v.string()),
    isTestCall: v.optional(v.boolean()),
    voiceCallSessionId: v.optional(v.id("voiceCallSessions")),
    livekitRoomName: v.optional(v.string()),
    livekitParticipantId: v.optional(v.string()),
    livekitParticipantIdentity: v.optional(v.string()),
    livekitSipCallId: v.optional(v.string()),
    livekitSipStatus: v.optional(
      v.union(
        v.literal("dialing"),
        v.literal("answered"),
        v.literal("completed"),
        v.literal("failed"),
        v.literal("suppressed")
      )
    ),
  })
    .index("by_candidate", ["candidateId"])
    .index("by_application", ["applicationId"])
    .index("by_job", ["jobId"])
    .index("by_candidate_time", ["candidateId", "calledAt"])
    .index("by_job_time", ["jobId", "calledAt"])
    .index("by_callStatus", ["callStatus"])
    .index("by_twilio", ["twilioCallSid"])
    .index("by_elevenlabs", ["elevenlabsConversationId"]),

  // Durable server-authoritative state for the real-time voice engine.
  // Simulation sessions may be represented here for diagnostics, but they
  // must never mutate candidates, applications, or aiCalls.
  voiceCallSessions: defineTable({
    externalSessionId: v.string(),
    aiCallId: v.optional(v.id("aiCalls")),
    candidateId: v.id("candidates"),
    applicationId: v.id("applications"),
    jobId: v.id("jobs"),
    mode: v.union(
      v.literal("simulation"),
      v.literal("test"),
      v.literal("live")
    ),
    status: v.union(
      v.literal("active"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled")
    ),
    consentStatus: v.union(
      v.literal("not_required"),
      v.literal("pending"),
      v.literal("granted"),
      v.literal("declined")
    ),
    consentIdempotencyKey: v.optional(v.string()),
    consentRecordedAt: v.optional(v.number()),
    livekitRoomName: v.optional(v.string()),
    livekitParticipantId: v.optional(v.string()),
    livekitParticipantIdentity: v.optional(v.string()),
    livekitSipCallId: v.optional(v.string()),
    livekitSipStatus: v.optional(
      v.union(
        v.literal("dialing"),
        v.literal("answered"),
        v.literal("completed"),
        v.literal("failed")
      )
    ),
    livekitFailureReason: v.optional(v.string()),
    stateVersion: v.number(),
    startedAt: v.number(),
    finalizedAt: v.optional(v.number()),
    durationSeconds: v.optional(v.number()),
  })
    .index("by_externalSessionId", ["externalSessionId"])
    .index("by_aiCallId", ["aiCallId"])
    .index("by_application_startedAt", ["applicationId", "startedAt"])
    .index("by_mode_status", ["mode", "status"])
    .index("by_status_startedAt", ["status", "startedAt"]),

  // One row per candidate-confirmed field. The idempotency index is queried
  // before state-version validation so an acknowledgement-loss retry returns
  // the original successful result rather than a false stale-version error.
  voiceAnswers: defineTable({
    callSessionId: v.id("voiceCallSessions"),
    candidateId: v.id("candidates"),
    applicationId: v.id("applications"),
    jobId: v.id("jobs"),
    turnId: v.string(),
    field: v.union(
      v.literal("currentSalary"),
      v.literal("expectedSalary"),
      v.literal("noticePeriodDays")
    ),
    value: v.number(),
    currency: v.optional(v.string()),
    idempotencyKey: v.string(),
    expectedStateVersion: v.number(),
    committedStateVersion: v.number(),
    committedAt: v.number(),
  })
    .index("by_idempotencyKey", ["idempotencyKey"])
    .index("by_session", ["callSessionId"])
    .index("by_session_turn_field", ["callSessionId", "turnId", "field"])
    .index("by_application_committedAt", ["applicationId", "committedAt"]),

  voiceAgentNonces: defineTable({
    nonce: v.string(),
    expiresAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_nonce", ["nonce"])
    .index("by_expiresAt", ["expiresAt"]),

  voiceSimulationReservations: defineTable({
    sessionId: v.string(),
    userId: v.id("users"),
    candidateId: v.id("candidates"),
    applicationId: v.id("applications"),
    jobId: v.id("jobs"),
    status: v.union(v.literal("reserved"), v.literal("released")),
    createdAt: v.number(),
    expiresAt: v.number(),
    releasedAt: v.optional(v.number()),
  })
    .index("by_sessionId", ["sessionId"])
    .index("by_user_createdAt", ["userId", "createdAt"])
    .index("by_user_expiresAt", ["userId", "expiresAt"])
    .index("by_status_expiresAt", ["status", "expiresAt"])
    // Deleting an opening removes its reservations (ta/openingDelete.ts, 2 Oct).
    .index("by_jobId", ["jobId"]),

  communications: defineTable({
    candidateId: v.id("candidates"),
    applicationId: v.optional(v.id("applications")),
    jobId: v.optional(v.id("jobs")),
    direction: v.union(v.literal("outbound"), v.literal("inbound")),
    channel: v.union(v.literal("email"), v.literal("whatsapp"), v.literal("sms")),
    /*
     * This row cost money: an approved WhatsApp template, billed by Meta.
     *
     * Free text inside the candidate's 24-hour window is free, so only these
     * count against the daily cap (convex/lib/templateBudget.ts). Set when the
     * send actually succeeds, never on the attempt.
     */
    billableTemplate: v.optional(v.boolean()),
    subject: v.optional(v.string()),
    body: v.string(),
    senderId: v.optional(v.id("users")),
    senderAgent: v.optional(v.union(v.literal("agent3"), v.literal("agent5"), v.literal("system"))),
    sequenceDay: v.optional(v.number()),
    deliveryStatus: v.union(
      v.literal("pending"),
      v.literal("sent"),
      v.literal("delivered"),
      v.literal("read"),
      v.literal("failed"),
      v.literal("bounced")
    ),
    openedAt: v.optional(v.number()),
    repliedAt: v.optional(v.number()),
    sentAt: v.union(v.number(), v.string()),
    stoppedSequence: v.boolean(),

    cvId: v.optional(v.id("cvs")),
    sequenceId: v.optional(v.id("followUpSequences")),
    senderType: v.optional(v.union(v.literal("user"), v.literal("agent"), v.literal("candidate"))),
    senderName: v.optional(v.string()),
    status: v.optional(v.union(
      v.literal("sent"), v.literal("delivered"), v.literal("read"), v.literal("replied"), v.literal("failed"), v.literal("cancelled")
    )),
    sequenceStep: v.optional(v.string()),
    cancelReason: v.optional(v.string()),
    errorMessage: v.optional(v.string()),

    fromCredentials: v.optional(v.string()),
    /**
     * The provider's id for an inbound message (Graph `message.id`), so the
     * same email is recorded and answered once however many polls see it
     * (2 Oct). Absent on older rows and on outbound ones.
     */
    externalMessageId: v.optional(v.string()),
  })
    .index("by_candidate_time", ["candidateId", "sentAt"])
    .index("by_externalMessageId", ["externalMessageId"])
    .index("by_applicationId", ["applicationId"])
    .index("by_channel_time", ["channel", "sentAt"])
    .index("by_app_sequence", ["applicationId", "sequenceDay"])
    .index("by_job", ["jobId"])
    .index("by_direction_channel_time", ["direction", "channel", "sentAt"]),

  directorReviews: defineTable({
    applicationId: v.id("applications"),
    jobId: v.id("jobs"),
    directorId: v.id("users"),
    decision: v.optional(v.union(v.literal("approved"), v.literal("rejected"), v.literal("request_changes"))),
    feedback: v.optional(v.string()),
    reviewedAt: v.optional(v.number()),
    createdAt: v.number(),
    slaBreachAt: v.optional(v.number()),
    slaBreached: v.boolean(),
  })
    .index("by_applicationId", ["applicationId"])
    .index("by_jobId", ["jobId"])
    .index("by_directorId", ["directorId"]),

  clientReviews: defineTable({
    applicationId: v.id("applications"),
    jobId: v.id("jobs"),
    decision: v.optional(v.union(v.literal("selected_for_interview"), v.literal("hold"), v.literal("rejected"))),
    clientFeedback: v.optional(v.string()),
    reviewedByName: v.optional(v.string()),
    reviewedAt: v.optional(v.number()),
    createdAt: v.number(),
    slaBreachAt: v.optional(v.number()),
    slaBreached: v.boolean(),
    esaVerified: v.boolean(),
  })
    .index("by_applicationId", ["applicationId"])
    .index("by_jobId", ["jobId"]),

  interviews: defineTable({
    applicationId: v.id("applications"),
    jobId: v.id("jobs"),
    candidateId: v.id("candidates"),
    interviewType: v.union(v.literal("first_interview"), v.literal("second_interview"), v.literal("final_interview"), v.literal("other")),
    scheduledAt: v.optional(v.number()),
    interviewFormat: v.optional(v.union(v.literal("in_person"), v.literal("video"), v.literal("phone"))),
    panelNames: v.optional(v.string()),
    outcome: v.optional(v.union(v.literal("pending"), v.literal("passed"), v.literal("failed"), v.literal("no_show"), v.literal("rescheduled"))),
    clientRating: v.optional(v.number()),
    clientFeedback: v.optional(v.string()),
    taNotes: v.optional(v.string()),
    coordinatedBy: v.optional(v.id("users")),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),

    // ── TA platform ───────────────────────────────────────────────────────
    // The legacy `outcome` enum conflates two different facts, so a candidate
    // who attended and was turned down cannot be recorded. These split it:
    // `taOutcome` is whether they turned up, `taResult` is how it went.
    taOutcome: v.optional(v.union(
      v.literal("pending"), v.literal("attended"),
      v.literal("no_show"), v.literal("cancelled"),
    )),
    taResult: v.optional(v.union(
      v.literal("pending"), v.literal("passed"),
      v.literal("failed"), v.literal("on_hold"),
    )),
    timezone: v.optional(v.string()),
    location: v.optional(v.string()),
    round: v.optional(v.number()),
    interviewers: v.optional(v.array(v.string())),
    durationMins: v.optional(v.number()),
    /** Set when the candidate confirms, which is what stops the escalation. */
    confirmedAt: v.optional(v.number()),
    // Several interviews per candidate (28 Sep): each has a name, keeps every
    // reschedule and status change, and one feedback entry per person.
    title: v.optional(v.string()),
    taHistory: v.optional(v.array(v.object({
      at: v.number(),
      byUserId: v.string(),
      kind: v.union(v.literal("rescheduled"), v.literal("status"), v.literal("edited")),
      detail: v.string(),
      reason: v.optional(v.string()),
    }))),
    taFeedback: v.optional(v.array(v.object({
      byUserId: v.string(),
      interviewer: v.string(),
      technical: v.optional(v.number()),
      communication: v.optional(v.number()),
      behaviour: v.optional(v.number()),
      performance: v.optional(v.number()),
      overall: v.optional(v.number()),
      recommendation: v.optional(v.union(
        v.literal("hire"), v.literal("next_round"), v.literal("hold"), v.literal("reject"),
      )),
      comments: v.optional(v.string()),
      at: v.number(),
      updatedAt: v.number(),
    }))),
  })
    .index("by_applicationId", ["applicationId"])
    .index("by_jobId", ["jobId"])
    .index("by_candidateId", ["candidateId"])
    .index("by_coordinatedBy", ["coordinatedBy"]),

  offers: defineTable({
    applicationId: v.id("applications"),
    jobId: v.id("jobs"),
    candidateId: v.id("candidates"),
    offeredSalary: v.number(),
    offeredSalaryCurrency: v.string(),
    offeredStartDate: v.optional(v.string()),
    contractTerms: v.optional(v.string()),
    status: v.union(v.literal("pending"), v.literal("accepted"), v.literal("declined"), v.literal("withdrawn")),
    aiCallConfirmation: v.boolean(),
    candidateResponseAt: v.optional(v.number()),
    taConfirmedAt: v.optional(v.number()),
    createdAt: v.number(),
    loopActionTaken: v.optional(v.union(v.literal("restart_from_new_cvs"), v.literal("return_to_client_review"))),

    // ── TA platform ───────────────────────────────────────────────────────
    /** Salaries here are quoted monthly, fees charged on the year. Storing
     *  which one a number is stops the 12x error at the source. */
    salaryBasis: v.optional(v.union(v.literal("monthly"), v.literal("annual"))),
    /** A timestamp, not the legacy `offeredStartDate` string — nothing can
     *  sort, compare or fire a reminder off text. */
    startDateMs: v.optional(v.number()),
    declineReason: v.optional(v.string()),
    madeBy: v.optional(v.id("users")),
  })
    .index("by_applicationId", ["applicationId"])
    .index("by_jobId", ["jobId"])
    .index("by_candidateId", ["candidateId"]),

  placements: defineTable({
    applicationId: v.id("applications"),
    jobId: v.id("jobs"),
    candidateId: v.id("candidates"),
    offerId: v.id("offers"),
    placedBy: v.id("users"),
    sourceChannel: v.union(
      v.literal("whatsapp"),
      v.literal("meta_campaign"),
      v.literal("email"),
      v.literal("email_campaign"),
      v.literal("linkedin"),
      v.literal("workable"),
      v.literal("manual_upload"),
      v.literal("headhunting")
    ),
    joinDate: v.string(),
    placedSalary: v.number(),
    placedSalaryCurrency: v.string(),
    invoiceSent: v.boolean(),
    invoiceSentAt: v.optional(v.number()),
    invoiceAmount: v.optional(v.number()),
    joinConfirmedAt: v.optional(v.number()),
    placementSnippetSent: v.boolean(),
    createdAt: v.number(),

    // ── TA platform ───────────────────────────────────────────────────────
    // `invoiceAmount` above is a bare number: it cannot be checked, cannot be
    // recomputed when the salary is corrected, and cannot be reported on as a
    // realised rate. The basis is kept here instead. Both the rate and the
    // guarantee are SNAPSHOTTED at placement — terms get renegotiated, and a
    // placement made in March must keep March's terms.
    clientId: v.optional(v.id("clients")),
    applicationIdRef: v.optional(v.id("applications")),
    salaryBasis: v.optional(v.union(v.literal("monthly"), v.literal("annual"))),
    /** A timestamp, not the legacy `joinDate` string. */
    joinDateMs: v.optional(v.number()),
    /** Null means a flat fee was agreed instead. */
    feePercent: v.optional(v.union(v.number(), v.null())),
    flatFee: v.optional(v.union(v.number(), v.null())),
    invoiceNumber: v.optional(v.string()),
    invoicePaidAt: v.optional(v.number()),
    /** Days from the join date. Why `placed` is not a terminal stage here. */
    guaranteeDays: v.optional(v.number()),
    fellThroughAt: v.optional(v.number()),
    fellThroughReason: v.optional(v.string()),
    taSourcingChannel: v.optional(v.string()),
    notes: v.optional(v.string()),
  })
    .index("by_jobId", ["jobId"])
    .index("by_placedBy", ["placedBy"])
    .index("by_sourceChannel", ["sourceChannel"])
    .index("by_invoiceSent_joinDate", ["invoiceSent", "joinDate"])
    .index("by_clientId", ["clientId"]),

  rejectionLoopEvents: defineTable({
    jobId: v.id("jobs"),
    triggerEvent: v.union(v.literal("client_rejected_all"), v.literal("candidate_declined_offer")),
    loopIteration: v.number(),
    actionTaken: v.union(v.literal("restart_from_new_cvs"), v.literal("return_to_client_review")),
    decidedBy: v.optional(v.id("users")),
    notes: v.optional(v.string()),
    triggeredAt: v.number(),
  })
    .index("by_jobId", ["jobId"])
    .index("by_decidedBy", ["decidedBy"]),
  ingestionBatches: defineTable({
    sourceChannel: v.string(),
    totalCount: v.number(),
    completedCount: v.number(),
    failedCount: v.number(),
    status: v.union(v.literal("in_progress"), v.literal("completed"), v.literal("failed")),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    jobId: v.optional(v.id("jobs")),
    paused: v.optional(v.boolean()),
  })
    .index("by_status", ["status"])
    .index("by_startedAt", ["startedAt"]),

  ingestionLog: defineTable({
    jobId: v.optional(v.id("jobs")),
    channelType: v.union(
      v.literal("whatsapp"),
      v.literal("meta_campaign"),
      v.literal("email"),
      v.literal("email_campaign"),
      v.literal("linkedin"),
      v.literal("workable"),
      v.literal("manual_upload"),
      v.literal("headhunting")
    ),
    rawSender: v.optional(v.string()),
    keywordFound: v.optional(v.string()),
    routingStatus: v.union(
      v.literal("routed"),
      v.literal("unrouted"),
      v.literal("duplicate_file"),
      v.literal("duplicate_candidate"),
      v.literal("error")
    ),
    cvFileId: v.optional(v.id("cvUploads")),
    candidateId: v.optional(v.id("candidates")),
    errorMessage: v.optional(v.string()),
    metaCampaignId: v.optional(v.string()),
    processingTimeMs: v.optional(v.number()),
    receivedAt: v.number(),
    processedAt: v.optional(v.number()),
    batchId: v.optional(v.union(v.id("ingestionBatches"), v.string())),
    stage: v.optional(v.string()),
    candidateName: v.optional(v.string()),
  })
    .index("by_job", ["jobId"])
    .index("by_channel", ["channelType"])
    .index("by_status", ["routingStatus"])
    .index("by_job_time", ["jobId", "receivedAt"])
    .index("by_channel_time", ["channelType", "receivedAt"])
    .index("by_receivedAt", ["receivedAt"])
    .index("by_cvFileId", ["cvFileId"])
    .index("by_batchId", ["batchId"]),

  systemLogs: defineTable({
    type: v.string(),
    message: v.string(),
    data: v.any(),
    timestamp: v.number(),
  }),

  // ■■ ACTIVITY_LOG ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■
  activityLog: defineTable({
    actorId: v.id("users"),
    actorName: v.string(),
    action: v.string(),
    entityType: v.string(),
    entityId: v.string(),
    metadata: v.optional(v.any()),
    occurredAt: v.string(),
  })
    .index("by_actorId", ["actorId"])
    .index("by_entityType_entityId", ["entityType", "entityId"])
    .index("by_occurredAt", ["occurredAt"]),

  // ■■ CANDIDATE_CONSENT ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■
  candidateConsent: defineTable({
    candidateId: v.id("candidates"),
    consented: v.boolean(),
    consentedAt: v.string(),
    method: v.string(),
  }).index("by_candidateId", ["candidateId"]),

  esaRecords: defineTable({
    clientName: v.string(),
    clientEmail: v.string(),
    jobId: v.optional(v.id("jobs")),
    status: v.union(v.literal("pending"), v.literal("sent"), v.literal("signed"), v.literal("expired"), v.literal("not_required")),
    sentAt: v.optional(v.number()),
    signedAt: v.optional(v.number()),
    signedBy: v.optional(v.string()),
    esaDocumentUrl: v.optional(v.string()),
    slaDeadlineAt: v.optional(v.number()),
    slaBreached: v.boolean(),
    notes: v.optional(v.string()),
    createdAt: v.number(),

    // ── TA platform ───────────────────────────────────────────────────────
    /** Keyed to the client RECORD, not the spelling of its name. Two spellings
     *  of one company were two separate agreement histories, neither complete. */
    clientId: v.optional(v.id("clients")),
    /** What was agreed, and what every placement under it inherits. */
    feePercent: v.optional(v.union(v.number(), v.null())),
    guaranteeDays: v.optional(v.number()),
    /** When it has to be back by. Breach is derived from this, never stored. */
    dueAt: v.optional(v.number()),
    documentName: v.optional(v.string()),
  })
    .index("by_client", ["clientName"])
    .index("by_job", ["jobId"])
    .index("by_client_status", ["clientName", "status"])
    .index("by_slaBreached", ["slaBreached"])
    .index("by_clientId", ["clientId"]),

  documents: defineTable({
    fileHash: v.optional(v.string()),
    fileName: v.optional(v.string()),
    fileSize: v.optional(v.float64()),
    fileType: v.optional(v.string()),
    rawText: v.optional(v.string()),
    status: v.optional(v.string()),
    storageId: v.optional(v.string()),
    uploadedBy: v.optional(v.string()),
    errorMessage: v.optional(v.string()),
    candidateName: v.optional(v.string()),
    currentTitle: v.optional(v.string()),
    email: v.optional(v.string()),
    industry: v.optional(v.string()),
    isStructured: v.optional(v.boolean()),
    languages: v.optional(v.array(v.string())),
    location: v.optional(v.string()),
    phone: v.optional(v.string()),
    sector: v.optional(v.string()),
    seniority: v.optional(v.string()),
    skills: v.optional(v.array(v.string())),
    summary: v.optional(v.string()),
    yearsOfExperience: v.optional(v.float64()),
    workableCandidateId: v.optional(v.string()),
  })
    .index("by_fileHash", ["fileHash"])
    .index("by_email", ["email"])
    .index("by_status", ["status"])
    .index("by_uploadedBy", ["uploadedBy"]),

  workableImports: defineTable({
    status: v.union(v.literal("running"), v.literal("done"), v.literal("error"), v.literal("stopped"), v.literal("paused")),
    totalCandidates: v.number(),
    maxCandidates: v.optional(v.number()),
    imported: v.number(),
    skipped: v.number(),
    deduplicated: v.optional(v.number()),
    failed: v.number(),
    userId: v.string(),
    startedAt: v.string(),
    errorMessage: v.optional(v.string()),
    lastCursor: v.optional(v.string()),
    subdomain: v.optional(v.string()),
    apiKey: v.optional(v.string()),
    candidateIndex: v.optional(v.number()),
  }).index("by_user", ["userId"]),

  herculesImports: defineTable({
    status: v.union(v.literal("running"), v.literal("done"), v.literal("error"), v.literal("stopped")),
    totalFound: v.number(),
    imported: v.number(),
    skipped: v.number(),
    failed: v.number(),
    maxCandidates: v.optional(v.number()),
    userId: v.string(),
    startedAt: v.string(),
    errorMessage: v.optional(v.string()),
    lastCursor: v.optional(v.string()),
  }).index("by_user", ["userId"]),

  zipImportJobs: defineTable({
    userId: v.string(),
    urls: v.array(v.string()),
    currentUrlIndex: v.number(),
    currentFileIndex: v.number(),
    status: v.union(
      v.literal("running"),
      v.literal("paused"),
      v.literal("stopped"),
      v.literal("done"),
      v.literal("error")
    ),
    totalFound: v.number(),
    imported: v.number(),
    duplicates: v.number(),
    notCv: v.number(),
    errors: v.number(),
    startedAt: v.string(),
    updatedAt: v.string(),
    errorMessage: v.optional(v.string()),
  }).index("by_user", ["userId"]),

  mailboxScanJobs: defineTable({
    mailboxEmail: v.string(),
    folder: v.string(), // "inbox" | "sentitems" | "all"
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("paused"),
      v.literal("done"),
      v.literal("error"),
      v.literal("stopped"),
      v.literal("retrying")
    ),
    totalMessages: v.number(),
    scannedMessages: v.number(),
    totalAttachments: v.number(),
    classifiedHighConfidence: v.number(),
    flaggedNeedsReview: v.number(),
    skippedLowConfidence: v.number(),
    llmCallsCount: v.number(),
    currentStage: v.optional(v.string()),
    phase: v.optional(
      v.union(
        v.literal("discovery"),
        v.literal("extracting"),
        v.literal("done"),
        v.literal("error"),
        v.literal("stopped"),
        v.literal("paused"),
        v.literal("retrying")
      )
    ),
    discoveredTotalEmails: v.optional(v.number()),
    discoveredAttachmentEmails: v.optional(v.number()),
    targetAttachmentEmails: v.optional(v.number()),
    processedAttachmentEmails: v.optional(v.number()),
    errorMessage: v.optional(v.string()),
    nextCursorUrl: v.optional(v.string()),
    currentFolderIndex: v.optional(v.number()),
    currentFolderId: v.optional(v.string()),
    lastProcessedMessageId: v.optional(v.string()),
    lastProcessedReceivedAt: v.optional(v.number()),
    retryCount: v.optional(v.number()),
    userStopped: v.optional(v.boolean()),
    lastHeartbeatAt: v.optional(v.number()),
    dryRun: v.boolean(),
    mode: v.optional(v.union(v.literal("manual"), v.literal("background"))),
    deduplicatedCount: v.optional(v.number()),
    userId: v.optional(v.string()),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    recentLogs: v.optional(
      v.array(
        v.object({
          timestamp: v.number(),
          message: v.string(),
          type: v.string(), // "info" | "success" | "warning" | "error"
        })
      )
    ),
  })
    .index("by_mailbox", ["mailboxEmail"])
    .index("by_status", ["status"])
    .index("by_startedAt", ["startedAt"]),

  // ─── Hercules Tables Merged Below ───

  cvs: defineTable({
    storageId: v.id("_storage"),
    fileName: v.string(),
    fileType: v.string(),
    fileSize: v.number(),
    candidateId: v.optional(v.id("candidates")),
    rawText: v.optional(v.string()),
    candidateName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    linkedinUrl: v.optional(v.string()),
    currentEmployer: v.optional(v.string()),
    location: v.optional(v.string()),
    currentTitle: v.optional(v.string()),
    industry: v.optional(v.string()),
    sector: v.optional(v.string()),
    seniority: v.optional(v.string()),
    yearsOfExperience: v.optional(v.number()),
    skills: v.optional(v.array(v.string())),
    languages: v.optional(v.array(v.string())),
    summary: v.optional(v.string()),
    sourceLevel1: v.optional(v.string()),
    sourceLevel2: v.optional(v.string()),
    status: v.union(
      v.literal("uploading"), v.literal("processing"), v.literal("ready"), v.literal("error"), v.literal("paused")
    ),
    errorMessage: v.optional(v.string()),
    isStructured: v.optional(v.boolean()),
    uploadedBy: v.id("users"),
    workableCandidateId: v.optional(v.string()),
    fileHash: v.optional(v.string()),
  })
    .index("by_status", ["status"])
    .index("by_uploaded_by", ["uploadedBy"])
    .index("by_industry", ["industry"])
    .index("by_seniority", ["seniority"])
    .index("by_file_hash", ["fileHash"])
    .index("by_candidate", ["candidateId"])
    .searchIndex("search_text", { searchField: "rawText", filterFields: ["status", "industry", "seniority"] })
    .searchIndex("search_summary", { searchField: "summary", filterFields: ["status"] }),

  pipeline: defineTable({
    jobId: v.id("jobs"),
    cvId: v.id("cvs"),
    candidateId: v.optional(v.id("candidates")),
    stage: v.union(
      v.literal("new"),
      v.literal("shortlisted"),
      v.literal("interview"),
      v.literal("offered"),
      v.literal("hired"),
      v.literal("rejected")
    ),
    notes: v.optional(v.string()),
    movedAt: v.string(),
    slaDeadlineAt: v.optional(v.string()),
    slaBreached: v.optional(v.boolean()),
    movedBy: v.optional(v.id("users")),
  })
    .index("by_job", ["jobId"])
    .index("by_job_and_cv", ["jobId", "cvId"])
    .index("by_job_and_stage", ["jobId", "stage"])
    .index("by_cv", ["cvId"])
    .index("by_candidate", ["candidateId"]),

  followUpSequences: defineTable({
    candidateId: v.id("candidates"),
    cvId: v.id("cvs"),
    jobId: v.id("jobs"),
    triggerStage: v.string(),
    recruiterId: v.optional(v.id("users")),
    recruiterName: v.optional(v.string()),
    status: v.union(
      v.literal("active"),
      v.literal("paused"),
      v.literal("completed"),
      v.literal("stopped_replied"),
      v.literal("stopped_placed"),
      v.literal("stopped_advanced"),
      v.literal("stopped_job_closed"),
      v.literal("unresponsive")
    ),
    startedAt: v.string(),
    endedAt: v.optional(v.string()),
    scheduledFunctionIds: v.optional(v.array(v.string())),
    afterDay7: v.union(v.literal("mark_unresponsive"), v.literal("continue_weekly")),
  })
    .index("by_candidate", ["candidateId"])
    .index("by_job_and_cv", ["jobId", "cvId"])
    .index("by_status", ["status"]),

  notifications: defineTable({
    userId: v.id("users"),
    type: v.union(
      v.literal("candidate_placed_elsewhere"),
      v.literal("candidate_placed"),
      v.literal("sla_breached"),
      v.literal("reverse_match_ready"),
      v.literal("candidate_replied"),
      v.literal("candidate_unresponsive"),
      v.literal("opening_assigned"),
      v.literal("scoop_received"),
      v.literal("strategy_assigned")
    ),
    title: v.string(),
    body: v.string(),
    cvId: v.optional(v.id("cvs")),
    candidateId: v.optional(v.id("candidates")),
    jobId: v.optional(v.id("jobs")),
    read: v.boolean(),
    createdAt: v.string(),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_read", ["userId", "read"])
    // Deleting an opening removes its notifications (ta/openingDelete.ts, 2 Oct).
    .index("by_jobId", ["jobId"]),

  dashboardStatsCache: defineTable({
    singletonKey: v.string(), // "global_dashboard_stats"
    data: v.any(), // cached stats payload
    updatedAt: v.number(),
  }).index("by_singletonKey", ["singletonKey"]),

  /**
   * Every email the shared application mailboxes (linkedin@, cv@) brought in,
   * once each, and what became of it (5 October). Read instead of the read
   * flag — an email someone opened in Outlook first was never picked up — and
   * the one count of what arrived against what was filed.
   */
  mailboxLog: defineTable({
    mailbox: v.string(),
    messageId: v.string(),
    receivedAt: v.string(),
    subject: v.string(),
    fromAddress: v.optional(v.string()),
    /** cv — handed to CV processing; held — a LinkedIn applicant with no CV, held
     *  from the notification; no_cv — nothing to file; reply — a candidate's reply. */
    outcome: v.union(v.literal("cv"), v.literal("held"), v.literal("no_cv"), v.literal("reply")),
    note: v.optional(v.string()),
    loggedAt: v.number(),
  })
    .index("by_mailbox_message", ["mailbox", "messageId"])
    .index("by_mailbox_received", ["mailbox", "receivedAt"]),

  appSettings: defineTable({
    key: v.string(),
    commonWhatsappNumber: v.optional(v.string()),
    commonWhatsappNumberId: v.optional(v.string()),
    autopilotEnabled: v.optional(v.boolean()),
    testModeEnabled: v.optional(v.boolean()),
    testPhoneNumber: v.optional(v.string()),
    testEmailAddress: v.optional(v.string()),
    updatedBy: v.optional(v.id("users")),
    updatedAt: v.optional(v.string()),
    lastEmailFetchTimestamp: v.optional(v.string()), // Added for email polling memory
    /** When this mailbox began to be read by the mailboxLog instead of the read flag (5 Oct). */
    mailLogSince: v.optional(v.string()),
    channel_toggles: v.optional(v.object({
      whatsappIngestion: v.boolean(),
      emailIngestion: v.boolean(),
      whatsappFollowUp: v.boolean(),
      emailFollowUp: v.boolean(),
    })),
  }).index("by_key", ["key"]),

  searchHistory: defineTable({
    userId: v.id("users"),
    query: v.string(),
    type: v.union(v.literal("natural_language"), v.literal("job_description")),
    resultCount: v.number(),
    results: v.optional(v.array(v.object({
      cvId: v.string(),
      score: v.number(),
      reason: v.string(),
    }))),
    interpretation: v.optional(v.object({
      searchText: v.string(),
      industry: v.optional(v.string()),
      seniority: v.optional(v.string()),
      minYears: v.optional(v.number()),
      interpretation: v.string(),
      keywords: v.array(v.string()),
    })),
    jobRequirements: v.optional(v.object({
      title: v.string(),
      requiredSkills: v.array(v.string()),
      preferredSkills: v.array(v.string()),
      minYearsExperience: v.union(v.number(), v.null()),
      industry: v.union(v.string(), v.null()),
      seniority: v.union(v.string(), v.null()),
      location: v.union(v.string(), v.null()),
      education: v.union(v.string(), v.null()),
      summary: v.string(),
    })),
    matchResults: v.optional(v.array(v.object({
      cvId: v.string(),
      overallScore: v.number(),
      breakdown: v.object({
        skills: v.number(), experience: v.number(), seniority: v.number(), industry: v.number(), location: v.number()
      }),
      matchedSkills: v.array(v.string()),
      missingSkills: v.array(v.string()),
      reason: v.string(),
    }))),
  }).index("by_user", ["userId"]),

  oauthStates: defineTable({
    state: v.string(),
    userId: v.id("users"),
    expiresAt: v.string(),
  }).index("by_state", ["state"]),

  graphSubscriptions: defineTable({
    subscriptionId: v.string(),
    taEmail: v.string(),
    resource: v.string(),          // e.g. "users/{email}/mailFolders/inbox/messages"
    expiresAt: v.number(),         // Unix timestamp (ms)
    createdAt: v.number(),
  })
    .index("by_subscriptionId", ["subscriptionId"])
    .index("by_taEmail", ["taEmail"])
    .index("by_expiresAt", ["expiresAt"]),

  m365Accounts: defineTable({
    userId: v.id("users"),
    email: v.string(),
    displayName: v.optional(v.string()),
    accessToken: v.string(),
    refreshToken: v.string(),
    expiresAt: v.string(),
    tenantId: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_email", ["email"]),

  whatsappSessions: defineTable({
    phone: v.string(),
    jobId: v.id("jobs"),
    keyword: v.string(),
    lastInteractionAt: v.number(),
    metaSourceUrl: v.optional(v.string()),
    metaSourceId: v.optional(v.string()),
    metaHeadline: v.optional(v.string()),
    // ── Chatbot conversation state ────────────────────────────────────────────
    // Set to true by whatchimpActions / insertCvRecord once a real PDF/DOCX is
    // confirmed stored in R2 + cvUploads table. AI must never ask for CV again
    // once this is true.
    cvReceived: v.optional(v.boolean()),
    // Portfolio / work-sample URLs the candidate shared (Behance, YouTube, etc.)
    portfolioUrls: v.optional(v.array(v.string())),
    // Detected employment preference ("freelance" | "fulltime" | "parttime")
    employmentPreference: v.optional(v.string()),
    // Timestamp of last outbound bot reply — used to prevent duplicate replies
    // when the same message triggers multiple code paths.
    lastBotReplyAt: v.optional(v.number()),
  }).index("by_phone", ["phone"])
    // Deleting an opening removes its sessions (ta/openingDelete.ts, 2 Oct).
    .index("by_jobId", ["jobId"]),

  systemStats: defineTable({
    singletonKey: v.string(), // e.g. "global_stats"
    totalCandidates: v.number(),
    totalCvUploads: v.number(),
    totalApplications: v.number(),
    activeJobsCount: v.number(),
  }).index("by_singletonKey", ["singletonKey"]),

  dailyStats: defineTable({
    dateStr: v.string(), // "YYYY-MM-DD"
    newCandidates: v.number(),
    newCvUploads: v.number(),
    newApplications: v.number(),
    newJobs: v.number(),
    placements: v.number(),
    cvsBySource: v.record(v.string(), v.number()), // e.g. { "WhatsApp": 5, "Email": 2 }
  }).index("by_dateStr", ["dateStr"]),

  nvidiaTokenLogs: defineTable({
    taskType: v.string(), // e.g. "cv_structuring", "jd_matching", "embedding"
    model: v.string(), // e.g. "meta/llama-3.1-70b-instruct"
    promptTokens: v.number(),
    completionTokens: v.number(),
    totalTokens: v.number(),
    success: v.boolean(),
    error: v.optional(v.string()),
    timestamp: v.number(), // Unix timestamp (ms)
    cvUploadId: v.optional(v.id("cvUploads")), // Link to specific CV for per-CV cost tracking
    // Denormalized at write-time to eliminate N+1 joins at read-time
    fileName: v.optional(v.string()),
    candidateName: v.optional(v.string()),
    provider: v.optional(v.string()), // 'openrouter' | 'nvidia'
    sourceChannel: v.optional(v.string()), // 'Workable' | 'Email' | 'WhatsApp' | 'Manual'
  })
    .index("by_timestamp", ["timestamp"])
    .index("by_taskType", ["taskType"])
    .index("by_model", ["model"])
    .index("by_cvUploadId", ["cvUploadId"])
    .index("by_provider", ["provider"])
    .index("by_sourceChannel", ["sourceChannel"]),

  // Rolling aggregate cache for getTokenMetrics — updated on every log write.
  // Replaces the O(n) .collect() scan with an O(1) singleton read.
  tokenStatsCache: defineTable({
    singletonKey: v.string(), // always "global_token_stats"
    totalTokens: v.number(),
    totalPromptTokens: v.number(),
    totalCompletionTokens: v.number(),
    totalCredits: v.number(),
    successfulCalls: v.number(),
    totalRequests: v.number(),
    totalCvExtractionsCount: v.number(),
    cvExtractionCredits: v.number(),
    taskBreakdown: v.any(), // Record<string, { tokens: number; credits: number; count: number }>
  }).index("by_singletonKey", ["singletonKey"]),

  // Per-day cost totals for the 7-day chart — updated on every log write.
  dailyTokenStats: defineTable({
    dateStr: v.string(), // "YYYY-MM-DD"
    totalCost: v.number(),
    cvExtractionCost: v.number(),
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    cvPromptTokens: v.optional(v.number()),
    cvCompletionTokens: v.optional(v.number()),
  }).index("by_dateStr", ["dateStr"]),

  // ■■ MESSAGE TEMPLATES ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■
  messageTemplates: defineTable({
    name: v.string(), // e.g. "Friendly Follow-Up"
    type: v.union(v.literal("initial_outreach"), v.literal("sample_follow_up"), v.literal("general")),
    content: v.string(), // The actual template text with [variables]
    createdBy: v.id("users"), // The TA who created it
    isGlobal: v.boolean(), // If true, available to all TAs (set by admin)
    isActive: v.boolean(),
    createdAt: v.string(),
    updatedAt: v.optional(v.string()),
  })
    .index("by_createdBy", ["createdBy"])
    .index("by_type", ["type"])
    .index("by_isGlobal", ["isGlobal"]),

  // ■■ WHATSAPP NUMBERS ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■
  whatsappNumbers: defineTable({
    name: v.string(), // e.g. "Jesmeen Mohammad"
    phone: v.string(), // e.g. "+94 74 011 0130"
    whatchimpPhoneId: v.string(), // e.g. "965783109962872"
    wabaId: v.optional(v.string()), // e.g. "900377459288998"
    createdAt: v.string(),
  }).index("by_phone", ["phone"]),

  // ■■ QUICK CV SCANS (Ad-Hoc Keyword & Criteria Scanning) ■■■■■■■■■■■■■■■■■■■
  cvScans: defineTable({
    userId: v.id("users"),
    title: v.string(),
    criteria: v.array(
      v.union(
        v.string(),
        v.object({
          text: v.string(),
          isLocation: v.boolean(),
        })
      )
    ),
    expandedCriteria: v.optional(
      v.array(
        v.object({
          original: v.string(),
          definition: v.string(),
          equivalentTitles: v.array(v.string()),
          relatedSignals: v.array(v.string()),
          isLocation: v.optional(v.boolean()),
        })
      )
    ),
    expansionStatus: v.optional(
      v.union(v.literal("pending"), v.literal("completed"), v.literal("failed"))
    ),
    status: v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed")),
    totalFiles: v.number(),
    processedFiles: v.number(),
    matchedFiles: v.number(),
    createdAt: v.number(),
    expiresAt: v.number(), // Unix timestamp (ms), default 7 days retention
  })
    .index("by_userId", ["userId"])
    .index("by_expiresAt", ["expiresAt"])
    .index("by_status", ["status"]),

  locationResolutionCache: defineTable({
    rawTextNormalized: v.string(),
    city: v.union(v.string(), v.null()),
    region: v.union(v.string(), v.null()),
    country: v.union(v.string(), v.null()),
    resolvedVia: v.union(v.literal("gazetteer"), v.literal("llm_fallback")),
    createdAt: v.number(),
  })
    .index("by_rawTextNormalized", ["rawTextNormalized"]),

  criteriaExpansionCache: defineTable({
    normalizedCriterion: v.string(),
    expansion: v.object({
      definition: v.string(),
      equivalentTitles: v.array(v.string()),
      relatedSignals: v.array(v.string()),
    }),
    promptVersion: v.string(),
    createdAt: v.number(),
  })
    .index("by_normalizedCriterion", ["normalizedCriterion"]),

  cvScanResults: defineTable({
    scanId: v.id("cvScans"),
    fileStorageId: v.optional(v.id("_storage")),
    s3Key: v.optional(v.string()),
    fileName: v.string(),
    fileSize: v.number(),
    fileType: v.string(),
    candidateName: v.optional(v.string()),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    currentTitle: v.optional(v.string()),
    matchScore: v.number(), // 0 to 100
    isMatch: v.boolean(),   // matchScore >= 60
    matchedCriteria: v.array(v.string()),
    criterionScores: v.array(v.object({ criterion: v.string(), score: v.number() })),
    evidenceQuotes: v.array(v.object({ quote: v.string(), isVerifiedQuote: v.boolean() })),
    reasoning: v.string(),
    status: v.union(v.literal("pending"), v.literal("processing"), v.literal("completed"), v.literal("failed")),
    extractionAttempts: v.number(), // Single-retry soft-terminal tracking
    error: v.optional(v.string()),
    processedAt: v.optional(v.number()),
    promotedCandidateId: v.optional(v.id("candidates")),
  })
    .index("by_scanId", ["scanId"])
    .index("by_scanId_matchScore", ["scanId", "matchScore"])
    .index("by_status", ["status"]),

  mailboxScanJobResults: defineTable({
    scanJobId: v.id("mailboxScanJobs"),
    messageId: v.string(),
    subject: v.string(),
    senderEmail: v.string(),
    receivedAt: v.number(),
    hasAttachments: v.boolean(),
    attachmentsCount: v.number(),
    status: v.string(), // "processed" | "skipped" | "flagged"
    cvUploaded: v.boolean(),
  }).index("by_scanJobId", ["scanJobId"]),

  // ■■ MAILBOX_CHECKPOINTS ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■■
  // Persists total discovered attachment counts and extraction pointers (cursors)
  // across sessions so multi-day scans seamlessly continue from where they left off.
  mailboxCheckpoints: defineTable({
    mailboxEmail: v.string(),
    folder: v.string(), // "inbox" | "sentitems" | "all"
    totalDiscoveredAttachmentEmails: v.number(),
    totalDiscoveredEmails: v.number(),
    totalExtractedCount: v.number(), // Cumulative count of extracted attachment emails
    nextCursorUrl: v.optional(v.string()), // Microsoft Graph API pagination continuation URL
    currentFolderIndex: v.optional(v.number()), // Folder index for "all" scope
    currentFolderId: v.optional(v.string()), // Explicit folder ID for stable folder resumption
    lastProcessedMessageId: v.optional(v.string()), // ID of last extracted message
    lastProcessedReceivedAt: v.optional(v.number()), // Timestamp of last extracted message
    lastDiscoveredAt: v.number(),
    lastExtractedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_mailbox_folder", ["mailboxEmail", "folder"]),

  sept5ReextractionState: defineTable({
    key: v.string(), // "singleton"
    startTimestamp: v.number(), // 1788546600000 (September 5, 2026 00:00:00 GMT+5:30)
    lastProcessedCreationTime: v.number(),
    lastProcessedUploadId: v.optional(v.id("cvUploads")),
    totalScanned: v.number(),
    totalAlreadyExtracted: v.number(),
    totalQueued: v.number(),
    totalHealed: v.number(),
    totalFailed: v.number(),
    status: v.string(), // "idle" | "running" | "paused" | "completed"
    modelUsed: v.string(), // "deepseek/deepseek-v4-flash"
    lastTickAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  // ══ TA PLATFORM TABLES ══════════════════════════════════════════════════
  //
  // Concepts the new UI has and the old backend never did. Everything above
  // this line is the old system's, unchanged apart from optional fields.
  // Shapes mirror src/data/types.ts, which stays the contract.

  /**
   * A client record, rather than `jobs.clientName` free text. Two spellings of
   * one company ("DirectFN", "DIRECTFN") are one client here.
   */
  clients: defineTable({
    name: v.string(),
    /** Lowercased, punctuation-stripped. The dedup key. */
    nameKey: v.string(),
    industry: v.string(),
    contacts: v.array(v.object({
      name: v.string(),
      title: v.string(),
      email: v.string(),
      isPrimary: v.boolean(),
    })),
    esaSignedAt: v.optional(v.union(v.number(), v.null())),
    status: v.union(v.literal("active"), v.literal("dormant"), v.literal("archived")),
    createdAt: v.number(),
    /** Set when someone pressed Delete (ta/bin.ts); removed seven days later. */
    binnedAt: v.optional(v.number()),
    binnedBy: v.optional(v.id("users")),
    /** The desk's notes on who the client is, for Research and Suggestions (28 Sep). */
    researchNotes: v.optional(v.string()),
  })
    .index("by_nameKey", ["nameKey"])
    .index("by_status", ["status"])
    .index("by_binnedAt", ["binnedAt"]),

  /**
   * One advert. Many posts sit under one opening and share its candidate pool
   * — the distinction the old `jobs` table could not make.
   */
  jobPosts: defineTable({
    openingId: v.id("jobs"),
    title: v.string(),
    /** Titles this advert carried before it was edited. Applicants who clicked
     *  before the edit still arrive under the old title. */
    previousTitles: v.array(v.string()),
    aliasKeywords: v.array(v.string()),
    country: v.optional(v.union(v.string(), v.null())),
    city: v.optional(v.union(v.string(), v.null())),
    channel: v.string(),
    /** Ties a campaign reply to this post when no headline is available. */
    campaignCode: v.string(),
    routingEmailAlias: v.string(),
    assignedTaId: v.optional(v.union(v.id("users"), v.null())),
    externalUrl: v.optional(v.union(v.string(), v.null())),
    postedAt: v.optional(v.union(v.number(), v.null())),
    status: v.union(
      v.literal("draft"), v.literal("live"),
      v.literal("paused"), v.literal("closed"),
    ),
    cvCountToday: v.number(),
    createdAt: v.number(),
  })
    .index("by_opening", ["openingId"])
    .index("by_assignedTa", ["assignedTaId"])
    .index("by_campaignCode", ["campaignCode"])
    .index("by_status", ["status"]),

  /** The management→lead download, or the lead→TA handoff, and what was read
   *  out of it. Nothing is committed to an opening without a human saving it. */
  briefs: defineTable({
    clientId: v.optional(v.union(v.id("clients"), v.null())),
    openingId: v.optional(v.union(v.id("jobs"), v.null())),
    kind: v.union(v.literal("management_to_lead"), v.literal("lead_to_ta")),
    capturedBy: v.id("users"),
    capturedAt: v.number(),
    method: v.union(v.literal("recording"), v.literal("notes"), v.literal("both")),
    notesMarkdown: v.string(),
    transcript: v.optional(v.union(v.string(), v.null())),
    transcriptStatus: v.union(
      v.literal("none"), v.literal("pending"),
      v.literal("ready"), v.literal("unavailable"),
    ),
    recordingKey: v.optional(v.union(v.string(), v.null())),
    recordingDurationMs: v.optional(v.union(v.number(), v.null())),
    /** Consent is given when record is pressed, and the wording as it stood
     *  that day is stored with it. A later edit must not rewrite it. */
    consentAcknowledgedBy: v.optional(v.union(v.id("users"), v.null())),
    consentAcknowledgedAt: v.optional(v.union(v.number(), v.null())),
    consentText: v.optional(v.union(v.string(), v.null())),
    extracted: v.any(),
  })
    .index("by_opening", ["openingId"])
    .index("by_client", ["clientId"]),

  /**
   * One CV waiting at the door. Not a candidate yet.
   *
   * The old pipeline writes straight through extraction into `candidates` and
   * nobody sees what dedup got wrong. Holding the arrival as its own record is
   * what makes "we received 40 and kept 6" answerable.
   */
  intakeItems: defineTable({
    source: v.string(),
    receivedFrom: v.optional(v.union(v.string(), v.null())),
    receivedAt: v.number(),
    fileName: v.optional(v.union(v.string(), v.null())),
    /** SHA-256 of the file. The first and cheapest dedup factor. */
    fileHash: v.optional(v.union(v.string(), v.null())),
    sizeBytes: v.optional(v.union(v.number(), v.null())),
    rawText: v.optional(v.union(v.string(), v.null())),
    /** Where the file itself is, so admitting it can reuse the upload. */
    s3Key: v.optional(v.union(v.string(), v.null())),
    cvUploadId: v.optional(v.union(v.id("cvUploads"), v.null())),
    parsed: v.optional(v.any()),
    match: v.optional(v.any()),
    status: v.union(
      v.literal("received"), v.literal("parsed"), v.literal("ready"),
      v.literal("needs_review"), v.literal("admitted"),
      v.literal("merged"), v.literal("rejected"),
    ),
    /** The address it arrived at, which says whose mailbox and so which TA's
     *  adverts it can possibly belong to. */
    toAddress: v.optional(v.union(v.string(), v.null())),
    subject: v.optional(v.union(v.string(), v.null())),
    openingId: v.optional(v.union(v.id("jobs"), v.null())),
    jobPostId: v.optional(v.union(v.id("jobPosts"), v.null())),
    /** Other openings the same advert serves — the CV is filed to each. */
    alsoFiledTo: v.optional(v.array(v.object({
      postId: v.id("jobPosts"),
      openingId: v.id("jobs"),
    }))),
    routedToTaId: v.optional(v.union(v.id("users"), v.null())),
    routeNote: v.optional(v.union(v.string(), v.null())),
    routeConfidence: v.optional(v.union(v.string(), v.null())),
    candidateId: v.optional(v.union(v.id("candidates"), v.null())),
    handledBy: v.optional(v.union(v.id("users"), v.null())),
    handledAt: v.optional(v.union(v.number(), v.null())),
    note: v.optional(v.union(v.string(), v.null())),
    problems: v.array(v.string()),
  })
    .index("by_status", ["status"])
    .index("by_fileHash", ["fileHash"])
    .index("by_opening", ["openingId"])
    .index("by_routedTa", ["routedToTaId"])
    .index("by_receivedAt", ["receivedAt"]),

  /** LinkedIn profiles worth approaching — people we do not hold a CV for. */
  linkVault: defineTable({
    openingId: v.id("jobs"),
    addedBy: v.id("users"),
    linkedinUrl: v.string(),
    name: v.optional(v.union(v.string(), v.null())),
    title: v.optional(v.union(v.string(), v.null())),
    company: v.optional(v.union(v.string(), v.null())),
    isEyeMarked: v.boolean(),
    phoneNumber: v.optional(v.union(v.string(), v.null())),
    phoneSource: v.optional(v.union(v.string(), v.null())),
    sourcingChannel: v.string(),
    outcome: v.string(),
    candidateId: v.optional(v.union(v.id("candidates"), v.null())),
    // Who in the database this profile is, if anyone (lib/samePerson, 28 Sep).
    // "same" rows are linked through candidateId as well; "possible" waits for
    // a TA, who answers same or different.
    cvMatch: v.optional(v.union(v.null(), v.object({
      candidateId: v.id("candidates"),
      fullName: v.string(),
      strength: v.string(),
      reasons: v.array(v.string()),
      hasCv: v.boolean(),
      decided: v.optional(v.string()),
      checkedAt: v.number(),
    }))),
    conversationLog: v.array(v.object({
      at: v.number(),
      channel: v.string(),
      note: v.string(),
      by: v.id("users"),
    })),
    createdAt: v.number(),
    /** When the outcome last changed (28 Sep), so the end-of-day L EFFORT can
     *  count a row worked today. Absent on rows not touched since. */
    outcomeAt: v.optional(v.number()),
    /** An add-on row: added on an Add-on day, or tagged by the TA (28 Sep). */
    isAddOn: v.optional(v.boolean()),
    /** The TA's L it was added under (1 = L1), started with + (29 Sep). */
    level: v.optional(v.union(v.number(), v.null())),
    /** What the browser extension read off a profile the TA had open. One at a
     *  time, by a person — there is no crawl here and must never be one. */
    capture: v.optional(v.union(v.any(), v.null())),
    /** Feedback left for the TA by a lead, director, admin or ops (25 Sep).
     *  Kept apart from the approach log: a note is not an approach, and logging
     *  one there would move the outcome on. `byRole` is the role at the time,
     *  so "TA Lead sent this note" stays true if the author's role changes. */
    leadNotes: v.optional(v.array(v.object({
      id: v.string(),
      at: v.number(),
      note: v.string(),
      by: v.id("users"),
      byRole: v.string(),
    }))),
  })
    .index("by_opening", ["openingId"])
    .index("by_addedBy", ["addedBy"])
    .index("by_url", ["linkedinUrl"]),

  /** Company research for an opening. Cached rather than regenerated per view:
   *  searches cost money and four tab opens should not pay four times. */
  researchReports: defineTable({
    openingId: v.id("jobs"),
    clientId: v.optional(v.union(v.id("clients"), v.null())),
    fields: v.any(),
    /** Hand-edited fields, so a regeneration does not overwrite them. */
    editedFields: v.array(v.string()),
    markdown: v.string(),
    sources: v.array(v.object({
      url: v.string(),
      title: v.string(),
      quote: v.string(),
    })),
    searches: v.number(),
    model: v.string(),
    generatedBy: v.id("users"),
    generatedAt: v.number(),
  }).index("by_opening", ["openingId"]),

  /** Who holds this role now, who held it before, who holds it at competitors. */
  benchmarks: defineTable({
    openingId: v.id("jobs"),
    name: v.optional(v.union(v.string(), v.null())),
    title: v.string(),
    company: v.string(),
    linkedinUrl: v.optional(v.union(v.string(), v.null())),
    kind: v.union(
      v.literal("incumbent"), v.literal("predecessor"), v.literal("competitor"),
    ),
    confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
    note: v.string(),
    sourceUrl: v.optional(v.union(v.string(), v.null())),
    sourceTitle: v.optional(v.union(v.string(), v.null())),
    /** The TA's pick. What Suggestions searches against. */
    isSelected: v.boolean(),
    generatedAt: v.number(),
  }).index("by_opening", ["openingId"]),

  profileSuggestions: defineTable({
    openingId: v.id("jobs"),
    name: v.string(),
    headline: v.string(),
    company: v.optional(v.union(v.string(), v.null())),
    location: v.optional(v.union(v.string(), v.null())),
    linkedinUrl: v.optional(v.union(v.string(), v.null())),
    tier: v.union(v.literal("priority"), v.literal("screen")),
    why: v.string(),
    /** What does not fit, where something does not. Never left flattering. */
    concern: v.optional(v.union(v.string(), v.null())),
    sourceUrl: v.optional(v.union(v.string(), v.null())),
    status: v.union(v.literal("new"), v.literal("kept"), v.literal("dismissed")),
    feedback: v.optional(v.union(v.string(), v.null())),
    round: v.number(),
    generatedAt: v.number(),
    generatedFor: v.optional(v.union(v.id("users"), v.null())),
    /** Keeping a profile is the claim — see src/lib/visibility.ts. */
    keptBy: v.optional(v.union(v.id("users"), v.null())),
  })
    .index("by_opening", ["openingId"])
    .index("by_opening_status", ["openingId", "status"]),

  /** The sourcing assistant conversation on an opening. `refine` re-reads what
   *  was already found and is free; `search` spends a round and credits. */
  sourcingChat: defineTable({
    openingId: v.id("jobs"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    body: v.string(),
    action: v.optional(v.union(v.string(), v.null())),
    affected: v.number(),
    sources: v.array(v.object({
      url: v.string(),
      title: v.string(),
      quote: v.string(),
    })),
    byUserId: v.optional(v.union(v.id("users"), v.null())),
    at: v.number(),
  }).index("by_opening", ["openingId"]),

  /** The TA's conversation with the AI about an opening's JD (25 Sep). Each
   *  answer keeps the JD it produced, so an earlier version can be put back. */
  jdChat: defineTable({
    openingId: v.id("jobs"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    body: v.string(),
    jdMarkdown: v.optional(v.union(v.string(), v.null())),
    byUserId: v.optional(v.union(v.id("users"), v.null())),
    at: v.number(),
    failed: v.optional(v.boolean()),
  }).index("by_opening", ["openingId"]),

  savedSearches: defineTable({
    name: v.string(),
    query: v.string(),
    mode: v.union(v.literal("natural"), v.literal("boolean"), v.literal("meaning")),
    ownerId: v.id("users"),
    openingId: v.optional(v.union(v.id("jobs"), v.null())),
    createdAt: v.number(),
    lastRunAt: v.optional(v.union(v.number(), v.null())),
    /** The count when it was last run, so "12 new since Tuesday" is possible. */
    lastResultCount: v.optional(v.union(v.number(), v.null())),
    /** Recruiter intent memory only — no candidate contact data or raw CV text. */
    intent: v.optional(v.union(v.any(), v.null())),
    turns: v.optional(v.array(v.string())),
  }).index("by_owner", ["ownerId"])
    // Deleting an opening clears it from saved searches (ta/openingDelete.ts, 2 Oct).
    .index("by_opening", ["openingId"]),

  /** The spec is stored, never the numbers, so a reopened report is current. */
  savedReports: defineTable({
    name: v.string(),
    ownerId: v.id("users"),
    shared: v.boolean(),
    spec: v.any(),
    createdAt: v.number(),
  })
    .index("by_owner", ["ownerId"])
    .index("by_shared", ["shared"]),

  /** One database-match run, and what it did. The audit behind the list. */
  matchRuns: defineTable({
    openingId: v.id("jobs"),
    at: v.number(),
    trigger: v.union(
      v.literal("jd_approved"), v.literal("nightly"), v.literal("manual"),
    ),
    /** Nearest by meaning, before any rule. */
    considered: v.number(),
    afterRules: v.number(),
    added: v.number(),
    embedModel: v.string(),
    assessmentVersion: v.optional(v.string()),
    note: v.optional(v.union(v.string(), v.null())),
  }).index("by_opening", ["openingId"]),

  /** Someone taken off an opening's matches is not matched to it again. */
  matchExclusions: defineTable({
    openingId: v.id("jobs"),
    candidateId: v.id("candidates"),
    at: v.number(),
  })
    .index("by_opening", ["openingId"])
    .index("by_opening_candidate", ["openingId", "candidateId"]),

  /**
   * The strategies a TA Lead can choose from (Strategy Planner, 8 Oct). The
   * list is the desk's own and edited in the app; retired ones stay here so
   * what was given under them still reads.
   */
  strategies: defineTable({
    name: v.string(),
    description: v.optional(v.union(v.string(), v.null())),
    group: v.optional(v.union(v.string(), v.null())),
    sortOrder: v.number(),
    active: v.boolean(),
    createdAt: v.number(),
    createdBy: v.id("users"),
  }).index("by_active", ["active", "sortOrder"]),

  /**
   * One row of a job's strategy table: a strategy on a job. The lead puts TAs on
   * it (doneBy), dates it, or strikes it through (notApplicable); the TA fills
   * doneAt, note and proofs and submits. A strategy nobody has acted on has no row.
   */
  strategyAssignments: defineTable({
    openingId: v.id("jobs"),
    strategyId: v.id("strategies"),
    /** The name when the row was made, kept if the strategy is renamed or retired. */
    strategyName: v.string(),
    doneBy: v.array(v.id("users")),
    assignedAt: v.optional(v.union(v.number(), v.null())),
    assignedBy: v.optional(v.union(v.id("users"), v.null())),
    byRole: v.optional(v.union(v.string(), v.null())),
    /** Ticked for the job by the lead (9 Oct); absent on older rows. */
    selected: v.optional(v.union(v.boolean(), v.null())),
    notApplicable: v.boolean(),
    doneAt: v.optional(v.union(v.number(), v.null())),
    note: v.optional(v.union(v.string(), v.null())),
    /** Proof images: the storage id, and when the TA submitted it (null until then). */
    proofs: v.array(v.object({
      id: v.string(),
      contentType: v.string(),
      size: v.number(),
      addedAt: v.number(),
      addedBy: v.id("users"),
      submittedAt: v.union(v.number(), v.null()),
    })),
    submittedAt: v.optional(v.union(v.number(), v.null())),
    submittedBy: v.optional(v.union(v.id("users"), v.null())),
  })
    .index("by_opening", ["openingId"])
    .index("by_opening_strategy", ["openingId", "strategyId"]),

  /**
   * A set of CVs sent out for a decision, and the decision that came back.
   *
   * The token is what makes the match reliable: it goes out in the subject and
   * comes back on the reply, so an inbound email can be tied to exactly the
   * round it answers even when a forward loses the thread headers.
   */
  reviewRounds: defineTable({
    openingId: v.id("jobs"),
    kind: v.union(v.literal("director"), v.literal("client")),
    token: v.string(),
    /** The provider's id for the mail that went out. A reply's In-Reply-To
     *  names it exactly — the only signal that survives a rewritten subject. */
    messageId: v.optional(v.union(v.string(), v.null())),
    setNumber: v.optional(v.union(v.number(), v.null())),
    applicationIds: v.array(v.id("applications")),
    sentBy: v.id("users"),
    sentAt: v.number(),
    sentTo: v.string(),
    trackedAt: v.optional(v.union(v.string(), v.null())),
    subject: v.string(),
    dispatch: v.union(v.literal("held"), v.literal("sent")),
    status: v.union(
      v.literal("awaiting"), v.literal("partial"), v.literal("returned"),
    ),
    returnedAt: v.optional(v.union(v.number(), v.null())),
    /** The reply as received, kept so a parse can be re-read or disputed. */
    replyBody: v.optional(v.union(v.string(), v.null())),
    /** The ChatGPT research link in the TA's end-of-day email (8 Oct). Rounds
     *  sent before it existed have none. */
    researchLink: v.optional(v.union(v.string(), v.null())),
    /** Each time the TA sent this email again, corrected (8 Oct). The copies
     *  are cleared after a month (eodEmailCopies); this keeps the fact. */
    revisedAt: v.optional(v.array(v.number())),
    decisions: v.array(v.object({
      applicationId: v.id("applications"),
      outcome: v.union(
        v.literal("shortlisted"), v.literal("rejected"), v.literal("hold"),
      ),
      note: v.union(v.string(), v.null()),
      /** True when a person confirmed it, not the parse alone. */
      confirmed: v.boolean(),
    })),
  })
    .index("by_opening", ["openingId"])
    .index("by_token", ["token"])
    .index("by_opening_kind", ["openingId", "kind"]),

  /**
   * The end-of-day email as it went, kept for a month so the TA can correct it
   * and send it again (8 Oct). One row per version; every version shares the
   * first send's expiresAt and all are deleted then (ta/eodCopies purgeExpired).
   */
  eodEmailCopies: defineTable({
    openingId: v.id("jobs"),
    roundId: v.id("reviewRounds"),
    version: v.number(),
    sentBy: v.id("users"),
    sentAt: v.number(),
    expiresAt: v.number(),
    subject: v.string(),
    introText: v.string(),
    outroText: v.string(),
    researchLink: v.optional(v.union(v.string(), v.null())),
    applicationIds: v.array(v.id("applications")),
    rows: v.array(v.object({
      no: v.number(),
      name: v.string(),
      age: v.string(),
      notice: v.string(),
      notes: v.array(v.string()),
      currentCompany: v.string(),
      currentDesignation: v.string(),
      currentRemuneration: v.string(),
      expectedRemuneration: v.string(),
      applicationId: v.id("applications"),
    })),
    /** The L-sheet line as the TA left it, targets included (lib/eod-format EffortRow). */
    effort: v.any(),
    extraTo: v.array(v.string()),
    extraCc: v.array(v.string()),
    removed: v.array(v.string()),
    to: v.array(v.string()),
    cc: v.array(v.string()),
  })
    .index("by_opening", ["openingId"])
    .index("by_round", ["roundId"])
    .index("by_expires", ["expiresAt"]),

  /** What was said on a call, structured where it could be read. */
  callFeedback: defineTable({
    applicationId: v.id("applications"),
    kind: v.union(
      v.literal("pre_interview"), v.literal("post_interview"),
      v.literal("post_offer"), v.literal("ad_hoc"),
    ),
    outcome: v.union(
      v.literal("reached"), v.literal("no_answer"),
      v.literal("rescheduled"), v.literal("declined"),
    ),
    body: v.string(),
    structured: v.optional(v.union(v.any(), v.null())),
    source: v.union(
      v.literal("manual"), v.literal("ai_call"),
      v.literal("whatsapp"), v.literal("email"),
    ),
    recordedBy: v.id("users"),
    recordedAt: v.number(),
  }).index("by_application", ["applicationId"]),


  // ─── TA System tables with no counterpart in the pipeline backend ─────────

  /** Stored alerts (escalations a call has not yet cleared). Computed alerts
   *  are not stored — see src/lib/sla.ts. */
  taAlerts: defineTable({
    kind: v.string(),
    subjectType: v.string(),
    subjectId: v.string(),
    assignedTo: v.id("users"),
    raisedAt: v.number(),
    dueAt: v.number(),
    resolvedAt: v.optional(v.union(v.number(), v.null())),
    detail: v.string(),
  }).index("by_subject", ["subjectId"]),

  /** Follow-up messages and calls a recruiter recorded against an application.
   *  Separate from `communications`, which is the engines' own message log. */
  taOutreach: defineTable({
    applicationId: v.id("applications"),
    candidateId: v.id("candidates"),
    direction: v.union(v.literal("out"), v.literal("in")),
    channel: v.string(),
    attempt: v.number(),
    to: v.optional(v.union(v.string(), v.null())),
    subject: v.optional(v.union(v.string(), v.null())),
    body: v.string(),
    sentAt: v.optional(v.union(v.number(), v.null())),
    byUserId: v.optional(v.union(v.id("users"), v.null())),
    createdAt: v.number(),
    callOutcome: v.optional(v.union(v.string(), v.null())),
    promisedAt: v.optional(v.union(v.number(), v.null())),
  }).index("by_application", ["applicationId"]),

  /** Screening calls run from the desk (simulation, assisted, live). The
   *  voice agent's own call records stay in `aiCalls`. */
  taScreeningCalls: defineTable({
    applicationId: v.id("applications"),
    candidateId: v.id("candidates"),
    openingId: v.id("jobs"),
    mode: v.string(),
    status: v.string(),
    stateVersion: v.number(),
    consent: v.optional(v.union(v.string(), v.null())),
    consentAt: v.optional(v.union(v.number(), v.null())),
    consentText: v.optional(v.union(v.string(), v.null())),
    answers: v.array(v.any()),
    transcript: v.optional(v.union(v.string(), v.null())),
    durationSeconds: v.optional(v.union(v.number(), v.null())),
    applied: v.array(v.string()),
    conflicts: v.array(v.object({ field: v.string(), existing: v.string(), heard: v.string() })),
    startedBy: v.id("users"),
    startedAt: v.number(),
    endedAt: v.optional(v.union(v.number(), v.null())),
    failureReason: v.optional(v.union(v.string(), v.null())),
  }).index("by_application", ["applicationId"]),

  /** Desk settings as key and value — the pre-shortlist score, the standard
   *  follow-up questions, the shortlist inbox. */
  taSettings: defineTable({
    key: v.string(),
    value: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  healerState: defineTable({
    key: v.string(), // "singleton"
    lastRunAt: v.number(),
    lastDispatchAt: v.optional(v.number()),
    lastRun: v.object({
      at: v.number(),
      dispatched: v.number(),
      recoveredStuck: v.number(),
      flaggedForReview: v.number(),
      candidatesChecked: v.number(),
      dispatchErrors: v.number(),
      lastError: v.optional(v.string()),
    }),
    totalRuns: v.number(),
    totalDispatched: v.number(),
    totalRecoveredStuck: v.number(),
    totalFlaggedForReview: v.number(),
  }).index("by_key", ["key"]),

  /**
   * TA System mail intake — the desk's shared mailboxes read through Microsoft
   * Graph (convex/mailIntake). One row per mailbox: whether it is read, where
   * the delta sync stands, and running totals for Settings → Mailboxes.
   *
   * Read-only by design: nothing here marks mail read, moves it or replies, so
   * the CV platform's own poller sees every message exactly as before.
   */
  mailIntakeMailboxes: defineTable({
    mailbox: v.string(),
    enabled: v.boolean(),
    /** shared (absent): linkedin@, cv@, job@. ta: a TA's own mailbox, read only
     *  for scoops the Director, a TA Lead or Ops send them (27 Sep). */
    kind: v.optional(v.union(v.literal("shared"), v.literal("ta"), v.literal("shortlist"))),
    taUserId: v.optional(v.id("users")),
    /** Graph's delta token URL; absent until the first full sync completes. */
    deltaLink: v.optional(v.string()),
    /** A page to resume from when a sync stopped part-way through. */
    nextLink: v.optional(v.string()),
    /** Messages received before this are never read (the backfill window). */
    backfillFrom: v.number(),
    lastSyncAt: v.optional(v.number()),
    lastSyncError: v.optional(v.string()),
    totals: v.object({
      seen: v.number(),
      filed: v.number(),
      database: v.number(),
      duplicate: v.number(),
      noCv: v.number(),
      skipped: v.number(),
      failed: v.number(),
    }),
    updatedAt: v.number(),
  }).index("by_mailbox", ["mailbox"]),

  /** One row per message the mail intake has seen, so none is handled twice or lost. */
  mailIntakeMessages: defineTable({
    mailbox: v.string(),
    messageId: v.string(),
    receivedAt: v.number(),
    subject: v.string(),
    fromAddress: v.string(),
    hasAttachments: v.boolean(),
    /** waiting → processing → extracting (a CV is being read) → done. */
    status: v.union(v.literal("waiting"), v.literal("processing"), v.literal("extracting"), v.literal("done")),
    /** filed: on an opening · database: no advert matched · duplicate: already held and placed ·
     *  no_cv: nothing to read · skipped: not an application · failed: gave up ·
     *  held: a shortlist mail no opening could be chosen for — a lead places it. */
    outcome: v.optional(v.union(
      v.literal("filed"), v.literal("database"), v.literal("duplicate"),
      v.literal("no_cv"), v.literal("skipped"), v.literal("failed"), v.literal("held"),
    )),
    attempts: v.number(),
    nextAttemptAt: v.number(),
    openingIds: v.array(v.id("jobs")),
    jobPostId: v.optional(v.id("jobPosts")),
    /** Where each opening's post came from, carried until the CV is read. */
    route: v.optional(v.any()),
    /** shortlists@: what the subject said, carried until the CVs are read —
     *  { kind, opening (from a Director's subject), setNumber }. */
    shortlist: v.optional(v.any()),
    candidateIds: v.array(v.id("candidates")),
    cvUploadIds: v.array(v.id("cvUploads")),
    note: v.optional(v.string()),
    error: v.optional(v.string()),
    /** A scoop in a TA's mailbox: whose pipeline it goes on, and who sent it. */
    scoopTaId: v.optional(v.id("users")),
    scoopFromUserId: v.optional(v.id("users")),
    processedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_messageId", ["messageId"])
    .index("by_status_next", ["status", "nextAttemptAt"])
    .index("by_receivedAt", ["receivedAt"]),

  feedbacks: defineTable({
    submittedBy: v.string(), // user id
    submittedByName: v.string(),
    submittedByRole: v.string(),
    createdAt: v.number(),

    category: v.union(
      v.literal("bug"),
      v.literal("feature"),
      v.literal("feature_request"),
      v.literal("ui_ux"),
      v.literal("ui_issue"),
      v.literal("performance"),
      v.literal("workflow"),
      v.literal("data_quality"),
      v.literal("other")
    ),
    priority: v.union(
      v.literal("low"),
      v.literal("medium"),
      v.literal("high"),
      v.literal("urgent")
    ),
    title: v.string(),
    description: v.string(),
    pageUrl: v.optional(v.string()),
    openingId: v.optional(v.string()),

    status: v.union(
      v.literal("pending_lead"),
      v.literal("approved_for_admin"),
      v.literal("resolved_by_lead"),
      v.literal("declined_by_lead"),
      v.literal("in_progress"),
      v.literal("resolved"),
      v.literal("declined_by_admin")
    ),

    leadReviewedBy: v.optional(v.string()),
    leadReviewedByName: v.optional(v.string()),
    leadReviewedAt: v.optional(v.number()),
    leadNotes: v.optional(v.string()),

    adminReviewedBy: v.optional(v.string()),
    adminReviewedByName: v.optional(v.string()),
    adminReviewedAt: v.optional(v.number()),
    adminResolution: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    screenshot: v.optional(v.string()),
  })
    .index("by_status", ["status"])
    .index("by_submittedBy", ["submittedBy"])
    .index("by_createdAt", ["createdAt"]),

}, { schemaValidation: false });


