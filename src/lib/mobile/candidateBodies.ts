import { z } from "zod";

export const candidateProfileBody = z
  .object({
    field: z.enum(["email", "phone", "name"]),
    value: z.string().max(500),
  })
  .strict();

const mode = z.enum(["in_person", "video", "phone"]);
const rating = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.null()]);
const interviewId = z.string().min(1).max(100);
const short = z.string().max(500);

export const candidateInterviewBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("schedule"), title: short, date: z.string().max(20), time: z.string().max(20), timezone: z.string().max(100),
    location: short, mode, interviewers: z.array(short).max(30), durationMins: z.number().int().min(1).max(1440).nullable(), notes: z.string().max(4000),
  }).strict(),
  z.object({ action: z.literal("confirm"), interviewId }).strict(),
  z.object({ action: z.literal("outcome"), interviewId, outcome: z.enum(["scheduled", "completed", "cancelled", "no_show"]), reason: short }).strict(),
  z.object({ action: z.literal("result"), interviewId, result: z.enum(["pending", "passed", "failed", "on_hold"]), clientRating: rating, clientFeedback: z.string().max(4000) }).strict(),
  z.object({ action: z.literal("reschedule"), interviewId, date: z.string().max(20), time: z.string().max(20), location: short, mode, reason: short }).strict(),
  z.object({ action: z.literal("edit"), interviewId, title: short, interviewers: z.array(short).max(30), durationMins: z.number().int().min(1).max(1440).nullable(), notes: z.string().max(4000) }).strict(),
  z.object({
    action: z.literal("feedback"), interviewId, forUserId: z.string().max(100).nullable(), interviewer: short,
    ratings: z.object({ technical: rating, communication: rating, behaviour: rating, performance: rating, overall: rating }).strict(),
    recommendation: z.enum(["hire", "next_round", "hold", "reject"]).nullable(), comments: z.string().max(4000),
  }).strict(),
]);

export const candidateClosingBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("offer"),
    salary: z.number().finite(),
    salaryBasis: z.enum(["monthly", "annual"]),
    currency: z.enum(["LKR", "USD"]),
    startDate: z.string().max(20),
    terms: z.string().max(4000),
  }).strict(),
  z.object({
    action: z.literal("respond"),
    offerId: z.string().min(1).max(100),
    status: z.enum(["accepted", "declined", "withdrawn"]),
    reason: z.string().max(1000),
  }).strict(),
  z.object({
    action: z.literal("place"),
    offerId: z.string().min(1).max(100),
    joinDate: z.string().max(20),
  }).strict(),
]);

const reviewDetail = z.object({ label: z.string().max(120), value: z.string().max(1000) }).strict();

export const candidateReviewBody = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("details"),
    currentSalary: z.string().max(200),
    currentSalaryCurrency: z.string().max(3),
    expectedSalary: z.string().max(200),
    expectedSalaryCurrency: z.string().max(3),
    noticePeriod: z.string().max(200),
    currentDesignation: z.string().max(500),
    currentCompany: z.string().max(500),
    customDetails: z.array(reviewDetail).max(30),
  }).strict(),
  z.object({ action: z.literal("add_note"), note: z.string() }).strict(),
  z.object({ action: z.literal("remove_note"), noteId: z.string().min(1).max(100) }).strict(),
]);
