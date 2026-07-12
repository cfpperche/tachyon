/**
 * t-8354ae — Tachyon Doctor: pure report builder for config/ledger/tmux/bridge forensics.
 * The VS Code command gathers live inputs and formats this into an OutputChannel.
 */
import type { ConfigFailure } from "../config/configFailure.js";
import type { ConfigLkgSnapshot } from "../config/configLkg.js";
import type { SessionRecord } from "../resume/SessionLedger.js";
import { isResumable } from "../resume/SessionLedger.js";

export type DoctorSeverity = "ok" | "warn" | "error" | "info";

export interface DoctorFinding {
  id: string;
  severity: DoctorSeverity;
  title: string;
  detail?: string;
  /** suggested next action for the human */
  action?: string;
}

export interface DoctorReportInput {
  workspaceRoot: string;
  configPath: string | undefined;
  configFailure: ConfigFailure | null;
  /** true when a config file exists on disk */
  configFileExists: boolean;
  /** true when the product loader accepted the config */
  configValid: boolean;
  lkg: ConfigLkgSnapshot | null;
  ledger: ReadonlyArray<readonly [string, SessionRecord]>;
  /** agent names with a live (non-dead) tmux session */
  liveSessions: ReadonlySet<string>;
  /** agent names with any tmux session (including dead panes) */
  knownSessions: ReadonlySet<string>;
  bridge: {
    port: number | undefined;
    url: string | undefined;
    /** TCP reachability probe result when available */
    reachable?: boolean;
    authConfigured?: boolean;
  };
  /** optional per-agent transcript/rollout presence for resumable rows */
  transcriptPresence?: ReadonlyMap<string, boolean>;
  now?: Date;
  /** Canonical mechanism-only handoff is intentionally best-effort root death. */
  mechanismOnlyDelivery?: boolean;
}

export interface DoctorReport {
  generatedAt: string;
  workspaceRoot: string;
  findings: DoctorFinding[];
  suggestions: string[];
}

export function buildDoctorReport(input: DoctorReportInput): DoctorReport {
  const now = input.now ?? new Date();
  const findings: DoctorFinding[] = [];
  const suggestions: string[] = [];

  // --- config ---
  if (!input.configFileExists) {
    findings.push({
      id: "config.missing",
      severity: "warn",
      title: "No tachyon.yml in workspace root",
      action: "Run Tachyon: Init to generate a starter config",
    });
    suggestions.push("Create tachyon.yml (Tachyon: Init)");
  } else if (!input.configValid || input.configFailure) {
    const errs = input.configFailure?.errors ?? ["unknown parse/validation error"];
    findings.push({
      id: "config.invalid",
      severity: "error",
      title: `Invalid ${input.configFailure?.file ?? "tachyon.yml"}`,
      detail: errs.map((e, i) => `${i + 1}. ${e}`).join("\n"),
      action: "Open the config file, fix the listed errors, then reload the window or run Tachyon: Start",
    });
    suggestions.push(`Open and fix ${input.configFailure?.file ?? "tachyon.yml"}`);
    suggestions.push("After fixing: Reload Window or Tachyon: Start");
  } else {
    findings.push({
      id: "config.ok",
      severity: "ok",
      title: "Config loads cleanly",
      detail: input.configPath,
    });
  }

  // --- LKG ---
  if (input.lkg) {
    const ageMs = Math.max(0, now.getTime() - Date.parse(input.lkg.savedAt));
    const age = formatAge(ageMs);
    findings.push({
      id: "lkg.present",
      severity: input.configValid ? "ok" : "info",
      title: `Last-known-good roster snapshot (${input.lkg.agents.length} agents)`,
      detail: `saved ${age} ago from ${input.lkg.sourceFile} at ${input.lkg.savedAt}`,
    });
  } else {
    findings.push({
      id: "lkg.missing",
      severity: input.configValid ? "info" : "warn",
      title: "No last-known-good config snapshot yet",
      detail: "A snapshot is written on the next successful config load",
    });
  }

  // --- ledger vs tmux ---
  let resumable = 0;
  let orphaned = 0; // live tmux, no ledger
  let zombie = 0; // ledger but no session
  let staleResumable = 0; // resumable but transcript gone

  const ledgerNames = new Set(input.ledger.map(([n]) => n));
  for (const [name, rec] of input.ledger) {
    const live = input.liveSessions.has(name);
    const known = input.knownSessions.has(name);
    if (isResumable(rec)) {
      resumable++;
      if (!live && !known) zombie++;
      if (input.transcriptPresence?.has(name) && input.transcriptPresence.get(name) === false) {
        staleResumable++;
      }
    } else if (!live && !known && rec.declared) {
      // declared ledger row with no session — informational
    }
  }
  for (const name of input.liveSessions) {
    if (!ledgerNames.has(name)) orphaned++;
  }

  findings.push({
    id: "ledger.summary",
    severity: zombie > 0 || orphaned > 0 ? "warn" : "ok",
    title: `Session ledger: ${input.ledger.length} row(s), ${resumable} resumable`,
    detail: [
      zombie > 0 ? `${zombie} resumable without a live tmux session (Resume available)` : undefined,
      orphaned > 0 ? `${orphaned} live session(s) with no ledger row` : undefined,
      staleResumable > 0 ? `${staleResumable} resumable row(s) missing transcript (fresh start)` : undefined,
    ]
      .filter(Boolean)
      .join("; ") || "ledger and live sessions look consistent",
  });

  if (zombie > 0 && !input.configValid) {
    suggestions.push("Resume agents from the sidebar (↻) — ledger defs are self-contained");
  }
  if (zombie > 0 && input.configValid) {
    suggestions.push("Tachyon: Resume Agents (with context) for stopped resumable rows");
  }

  // --- bridge ---
  if (input.mechanismOnlyDelivery) {
    findings.push({ id: "delivery.mechanism_only", severity: "warn", title: "Canonical Delivery uses mechanism-only handoff safety", detail: "Root death is best-effort; descendant process absence is unproven." });
  }
  if (!input.bridge.port && !input.bridge.url) {
    findings.push({
      id: "bridge.down",
      severity: "warn",
      title: "Bridge not running for this workspace",
      action: "Tachyon: Start or Tachyon: Restart Bridge",
    });
  } else if (input.bridge.reachable === false) {
    findings.push({
      id: "bridge.unreachable",
      severity: "error",
      title: `Bridge port ${input.bridge.port ?? "?"} not reachable`,
      detail: input.bridge.url,
      action: "Tachyon: Restart Bridge",
    });
    suggestions.push("Restart the Bridge");
  } else {
    findings.push({
      id: "bridge.ok",
      severity: "ok",
      title: `Bridge listening${input.bridge.port ? ` on ${input.bridge.port}` : ""}`,
      detail: [
        input.bridge.url,
        input.bridge.authConfigured === false ? "auth not configured" : undefined,
        input.bridge.reachable === true ? "TCP reachable" : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }

  // dedupe suggestions
  const uniq = [...new Set(suggestions)];
  return {
    generatedAt: now.toISOString(),
    workspaceRoot: input.workspaceRoot,
    findings,
    suggestions: uniq,
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    "Tachyon Doctor",
    "==============",
    `workspace: ${report.workspaceRoot}`,
    `generated: ${report.generatedAt}`,
    "",
  ];
  for (const f of report.findings) {
    const mark = f.severity === "ok" ? "OK  " : f.severity === "warn" ? "WARN" : f.severity === "error" ? "ERR " : "INFO";
    lines.push(`[${mark}] ${f.title}`);
    if (f.detail) {
      for (const d of f.detail.split("\n")) lines.push(`       ${d}`);
    }
    if (f.action) lines.push(`       → ${f.action}`);
  }
  if (report.suggestions.length) {
    lines.push("", "Suggested next actions");
    lines.push("----------------------");
    for (const s of report.suggestions) lines.push(`• ${s}`);
  }
  lines.push("");
  return lines.join("\n");
}

function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}
