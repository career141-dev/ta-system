import { NextResponse } from "next/server";

import { primeStore } from "@/data/prime";
import { PRIORITY_TARGET } from "@/data/types";
import { repo, stageCounts } from "@/data/store";
import { colomboGreeting, colomboDaysBetween } from "@/lib/calendar";
import { can } from "@/lib/auth";
import { mobileDestinations } from "@/lib/mobile/navigation";
import { currentUser } from "@/lib/session";
import { alertsFor } from "@/lib/sla";

export const dynamic = "force-dynamic";

/**
 * The first native-app payload: signed-in identity, permitted navigation and
 * the user's working day. Clerk verifies the bearer session in `currentUser`;
 * no mobile caller supplies a desk user id or receives a Convex admin key.
 */
export async function GET() {
  await primeStore({ allApplications: true, followUps: true });
  const user = await currentUser();
  if (!user) {
    return NextResponse.json(
      { error: "unauthenticated", message: "Sign in to continue." },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  const clients = repo.clients();
  const visibleOpenings = repo.openingsForUser(user);
  const openings = visibleOpenings.filter((opening) => opening.status === "open");
  const alerts = alertsFor(user.id);
  const readAlertIds = repo.readAlertIds(user.id);
  const urgent = alerts.filter((alert) => alert.urgent);
  const interviews = repo
    .interviews()
    .filter((interview) => interview.outcome === "pending" && interview.scheduledAt > Date.now())
    .sort((a, b) => a.scheduledAt - b.scheduledAt)
    .slice(0, 5)
    .flatMap((interview) => {
      const application = repo.application(interview.applicationId);
      if (!application) return [];
      const candidate = repo.candidate(application.candidateId);
      const opening = repo.opening(application.openingId);
      if (!candidate || !opening) return [];
      return [{
        id: interview.id,
        applicationId: application.id,
        openingId: opening.id,
        candidateName: candidate.fullName,
        openingTitle: opening.title,
        scheduledAt: interview.scheduledAt,
        mode: interview.mode,
        confirmed: interview.confirmedAt !== null,
      }];
    });

  const openingRows = openings.map((opening) => {
    const counts = stageCounts(opening.id);
    const livePosts = repo.jobPosts(opening.id).filter((post) => post.status === "live");
    const cvsToday = livePosts.reduce((total, post) => total + post.cvCountToday, 0);
    const daysOpen = opening.assignedAt ? colomboDaysBetween(opening.assignedAt) : 0;
    const targetDays = PRIORITY_TARGET[opening.priorityTier].days;
    const followUpCount = (counts.ai_follow_up ?? 0) + (counts.ta_follow_up ?? 0);

    return {
      id: opening.id,
      clientName: clients.find((client) => client.id === opening.clientId)?.name ?? "Client",
      title: opening.title,
      priorityTier: opening.priorityTier,
      jdStatus: opening.jdStatus,
      cvsToday,
      daysOpen,
      targetDays,
      followUpCount,
    };
  });

  return NextResponse.json(
    {
      apiVersion: 1,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        initials: user.initials,
        role: user.role,
      },
      navigation: mobileDestinations(user).filter((destination) => destination.enabled),
      resources: {
        openings: openingRows,
        clients: can(user, "database.read").ok
          ? clients.map((client) => ({
              id: client.id,
              name: client.name,
              industry: client.industry,
              status: client.status,
              openCount: visibleOpenings.filter(
                (opening) => opening.clientId === client.id && opening.status === "open",
              ).length,
              primaryContact: client.contacts.find((contact) => contact.isPrimary)?.name ?? null,
            }))
          : [],
        alerts: alerts.slice(0, 50).map((alert) => ({
          id: alert.id,
          kind: alert.kind,
          detail: alert.detail,
          action: alert.action,
          openingId: alert.openingId,
          dueAt: alert.dueAt,
          urgent: alert.urgent,
          read: readAlertIds.has(alert.id),
        })),
      },
      home: {
        greeting: colomboGreeting(),
        openCount: openings.length,
        urgentCount: urgent.length,
        interviewCount: interviews.length,
        urgent: urgent.slice(0, 10).map((alert) => ({
          id: alert.id,
          kind: alert.kind,
          detail: alert.detail,
          action: alert.action,
          openingId: alert.openingId,
          dueAt: alert.dueAt,
        })),
        openings: openingRows,
        interviews,
      },
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
