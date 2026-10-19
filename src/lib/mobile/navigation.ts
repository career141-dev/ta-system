import { can } from "@/lib/auth";
import type { User } from "@/data/types";

export interface MobileDestination {
  key: string;
  label: string;
  enabled: boolean;
}

/**
 * The server decides which native destinations exist for this account. The
 * app may use this to draw its tabs, but every data route and mutation still
 * performs its own authorization check.
 */
export function mobileDestinations(user: User): MobileDestination[] {
  return [
    { key: "home", label: "Home", enabled: true },
    { key: "openings", label: "Openings", enabled: true },
    { key: "clients", label: "Clients", enabled: can(user, "database.read").ok },
    { key: "alerts", label: "Alerts", enabled: true },
    { key: "strategy", label: "Strategy", enabled: user.role !== "client" && user.role !== "viewer" },
    { key: "database", label: "Database", enabled: can(user, "database.read").ok },
    { key: "reports", label: "Reports", enabled: can(user, "report.read").ok },
    { key: "voice", label: "Voice", enabled: can(user, "voice.practice").ok },
    { key: "feedback", label: "Feedback", enabled: user.role !== "client" && user.role !== "viewer" },
    { key: "bin", label: "Bin", enabled: user.role !== "client" && user.role !== "viewer" },
    { key: "search", label: "Search", enabled: true },
    { key: "people", label: "People", enabled: can(user, "user.manage").ok },
    { key: "decisions", label: "Decisions", enabled: user.role !== "client" && user.role !== "viewer" },
    { key: "settings", label: "Settings", enabled: true },
  ];
}
