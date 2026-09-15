import "server-only";

/**
 * Finding the pool a search then narrows.
 *
 * Kept apart from `lib/query.ts`, which reads a sentence into criteria, and
 * from `lib/match.ts`, which decides who fits. This module only answers "which
 * few hundred of the seventy-seven thousand are worth looking at" — the step
 * the file store never needed, because it already had everybody in memory.
 *
 * Two routes, on purpose. Words go to the backend's full-text indexes and need
 * no model at all; meaning goes to Qdrant and needs an embedding. Either can
 * be down or unconfigured without the other stopping, and a candidate found by
 * one is never hidden because the other missed them.
 */

import type { Id } from "@/data/types";
import * as backend from "@/data/convex/backend";

const NO_ACTOR = { id: null as string | null };

/**
 * Candidate ids for a set of phrasings, best first.
 *
 * Several terms rather than one: a recruiter's sentence, the titles read out
 * of it, and the named skills are different ways of asking, and the union of
 * them finds people that any single phrasing misses.
 */
export async function keywordRetrieve(terms: string[], limit = 150): Promise<Id[]> {
  const hits = await backend.keywordSearchMany(NO_ACTOR, terms, Math.max(50, Math.ceil(limit / 2)));
  return hits.slice(0, limit).map((h) => h.candidateId);
}

/** The same, with the scores kept — for ranking rather than just membership. */
export async function keywordRetrieveScored(
  terms: string[],
  limit = 150,
): Promise<{ candidateId: Id; score: number }[]> {
  const hits = await backend.keywordSearchMany(NO_ACTOR, terms, Math.max(50, Math.ceil(limit / 2)));
  return hits.slice(0, limit);
}

export interface DatabaseShelf {
  total: number;
  /** True when the total is a floor rather than an exact count. */
  sampled: boolean;
  titles: { title: string; count: number }[];
  skills: string[];
  cities: string[];
  employers: string[];
  industries: string[];
}

/**
 * What the Database home page needs to describe the database without reading
 * it: how many people there are, and the words they are described by.
 *
 * The vocabulary comes from a bounded sample, and `sampled` says so. A
 * suggestion built from a sample is still a search that returns people, which
 * is the point of it — but a COUNT presented as exact when it is a floor is a
 * number somebody will quote, so the page marks it.
 */
export async function databaseShelf(): Promise<DatabaseShelf> {
  const [stats, vocab] = await Promise.all([
    backend.candidateStats(NO_ACTOR),
    backend.vocabulary(NO_ACTOR),
  ]);
  return {
    total: stats.total,
    sampled: stats.sampled,
    titles: vocab.titles,
    skills: vocab.skills,
    cities: vocab.cities,
    employers: vocab.employers,
    industries: vocab.industries,
  };
}
