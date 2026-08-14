import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  degradedRosterExtras,
  isLkgOnlySpawn,
  lkgSpawnRefusalMessage,
  toConfigErrorVM,
  type ConfigFailure,
} from "@tachyon/engine/config/configFailure.js";
import {
  parseConfigLkg,
  readConfigLkg,
  snapshotFromConfig,
  writeConfigLkg,
  type ConfigLkgSnapshot,
} from "@tachyon/engine/config/configLkg.js";
import { parseConfig } from "@tachyon/engine/config/loadConfig.js";
import type { SessionRecord } from "@tachyon/engine/resume/SessionLedger.js";
import { buildDoctorReport, formatDoctorReport } from "@tachyon/engine/workspace/doctorReport.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-fail-visible-"));
}

function ledgerRec(partial: Partial<SessionRecord> & { cwd?: string } = {}): SessionRecord {
  return {
    cwd: partial.cwd ?? "/ws",
    instance: partial.instance ?? { lifetime: "saved", resumePolicy: "restartable", lifecycleHooks: true },
    updatedAt: partial.updatedAt ?? new Date().toISOString(),
    ...(partial.def ? { def: partial.def } : {}),
    ...(partial.resume ? { resume: partial.resume } : {}),
    ...(partial.worktree ? { worktree: partial.worktree } : {}),
  };
}

describe("config LKG snapshot", () => {
  it("round-trips roster from a valid config", () => {
    const { config, errors } = parseConfig(`
agents:
  codex:
    cmd: codex
    subagents: [reviewer]
  reviewer:
    cmd: claude
`);
    expect(errors).toEqual([]);
    expect(config).toBeTruthy();
    const snap = snapshotFromConfig(config!, "tachyon.yml");
    expect(snap.schemaVersion).toBe(1);
    expect(snap.agents.map((a) => a.name).sort()).toEqual(["codex", "reviewer"]);
    expect(snap.agents.find((a) => a.name === "reviewer")?.declaredOwner).toBe("codex");

    const root = tmpRoot();
    try {
      writeConfigLkg(root, snap);
      const read = readConfigLkg(root);
      expect(read?.agents).toEqual(snap.agents);
      expect(read?.sourceFile).toBe("tachyon.yml");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("parseConfigLkg rejects corrupt payloads", () => {
    expect(parseConfigLkg("{")).toBeNull();
    expect(parseConfigLkg(JSON.stringify({ schemaVersion: 99, agents: [] }))).toBeNull();
  });
});

describe("degraded roster + LKG spawn gate", () => {
  it("(a) invalid config + non-empty ledger yields banner VM and ledger-derived rows", () => {
    const failure: ConfigFailure = {
      path: "/ws/tachyon.yml",
      file: "tachyon.yml",
      errors: ["'reviewer' is not declared in agents/terminals"],
      at: "2026-07-10T16:09:00.000Z",
    };
    const banner = toConfigErrorVM(failure);
    expect(banner.file).toBe("tachyon.yml");
    expect(banner.summary).toContain("reviewer");

    const extras = degradedRosterExtras({
      existingNames: new Set(),
      ledger: [
        ["codex", ledgerRec({ instance: { lifetime: "saved", resumePolicy: "restartable", lifecycleHooks: true }, resume: { runtime: "codex", sessionId: "s1" } })],
        ["temporary-fix", ledgerRec({ instance: { lifetime: "temporary", resumePolicy: "collected", lifecycleHooks: false }, def: { cmd: "claude", kind: "agent" } })],
      ],
      lkg: {
        schemaVersion: 1,
        savedAt: "2026-07-10T15:00:00.000Z",
        sourceFile: "tachyon.yml",
        agents: [
          { name: "codex", kind: "agent", cmd: "codex" },
          { name: "never-ran", kind: "agent", cmd: "claude" },
        ],
      },
    });

    const names = extras.map((e) => e.name).sort();
    expect(names).toEqual(["codex", "never-ran", "temporary-fix"]);
    expect(extras.find((e) => e.name === "codex")?.source).toBe("ledger");
    expect(extras.find((e) => e.name === "codex")?.resumable).toBe(true);
    expect(extras.find((e) => e.name === "never-ran")?.source).toBe("lkg");
    expect(extras.find((e) => e.name === "never-ran")?.resumable).toBe(false);
    // empty-roster placeholder is unreachable when extras exist (sidebar uses agents.length)
    expect(extras.length).toBeGreaterThan(0);
  });

  it("(b) incident scenario: break config → LKG never-ran + ledger still listed", () => {
    // valid config first → LKG written
    const { config } = parseConfig(`
agents:
  codex:
    cmd: codex
  reviewer:
    cmd: claude
`);
    const lkg = snapshotFromConfig(config!, "tachyon.yml");
    // break: reviewer removed but still referenced — parse would fail; we only need degraded merge
    const extras = degradedRosterExtras({
      existingNames: new Set(), // cold start with invalid config: manager.list empty of declared
      ledger: [["codex", ledgerRec({ instance: { lifetime: "saved", resumePolicy: "restartable", lifecycleHooks: true }, resume: { runtime: "codex", sessionId: "abc" } })]],
      lkg,
    });
    expect(extras.map((e) => e.name).sort()).toEqual(["codex", "reviewer"]);
    expect(extras.find((e) => e.name === "codex")?.resumable).toBe(true);
  });

  it("(c) with config invalid, spawn of LKG-only names is refused; live/Temporary names are not", () => {
    expect(
      isLkgOnlySpawn({ configValid: false, nameInLiveConfigOrTemporary: false, nameInLkg: true }),
    ).toBe(true);
    expect(
      isLkgOnlySpawn({ configValid: false, nameInLiveConfigOrTemporary: true, nameInLkg: true }),
    ).toBe(false);
    expect(
      isLkgOnlySpawn({ configValid: true, nameInLiveConfigOrTemporary: false, nameInLkg: true }),
    ).toBe(false);
    expect(lkgSpawnRefusalMessage("reviewer", "tachyon.yml")).toMatch(/render-only/);
  });

  it("does not duplicate names already in the live list", () => {
    const extras = degradedRosterExtras({
      existingNames: new Set(["codex"]),
      ledger: [["codex", ledgerRec({ instance: { lifetime: "saved", resumePolicy: "restartable", lifecycleHooks: true } })]],
      lkg: {
        schemaVersion: 1,
        savedAt: "t",
        sourceFile: "tachyon.yml",
        agents: [{ name: "codex", kind: "agent" }],
      } satisfies ConfigLkgSnapshot,
    });
    expect(extras).toEqual([]);
  });
});

describe("doctor report", () => {
  it("reports a loaded config with an isolated refused profile without calling the file invalid", () => {
    const report = buildDoctorReport({
      workspaceRoot: "/ws",
      configPath: "/ws/tachyon.yml",
      configFileExists: true,
      configValid: true,
      configFailure: null,
      refusedProfiles: [{ name: "broken", reason: "profile/schema: schemaVersion: Invalid literal value, expected 1" }],
      lkg: null,
      ledger: [],
      liveSessions: new Set(),
      knownSessions: new Set(),
      bridge: { port: 42897, url: "http://127.0.0.1:42897/mcp", reachable: true, authConfigured: true },
    });

    expect(report.findings).toContainEqual(expect.objectContaining({
      id: "config.profiles_refused",
      severity: "warn",
      title: expect.stringMatching(/loaded.*1.*refused agent profile/i),
      detail: expect.stringMatching(/broken.*profile\/schema.*schemaVersion/is),
    }));
    expect(report.findings.some((finding) => finding.id === "config.invalid")).toBe(false);
    expect(report.findings.some((finding) => finding.id === "config.ok")).toBe(false);
    expect(formatDoctorReport(report)).not.toMatch(/Invalid tachyon\.yml/);
  });

  it("reports ignored obsolete settings without treating the config as invalid", () => {
    const report = buildDoctorReport({
      workspaceRoot: "/ws",
      configPath: "/ws/tachyon.yml",
      configFileExists: true,
      configValid: true,
      configFailure: null,
      configWarnings: [
        "settings.delivery was ignored because canonical Delivery with mechanism-only handoff is always active; remove settings.delivery from tachyon.yml",
      ],
      lkg: null,
      ledger: [],
      liveSessions: new Set(),
      knownSessions: new Set(),
      bridge: { port: 42897, url: "http://127.0.0.1:42897/mcp", reachable: true, authConfigured: true },
    });

    expect(report.findings).toContainEqual(expect.objectContaining({ id: "config.ok", severity: "ok" }));
    expect(report.findings).toContainEqual(expect.objectContaining({
      id: "config.ignored",
      severity: "warn",
      detail: expect.stringContaining("settings.delivery was ignored"),
    }));
    expect(formatDoctorReport(report)).toMatch(/ignored or deprecated config setting.*settings\.delivery was ignored/is);
  });

  it("(d) invalid config + stale ledger entry produce corresponding findings", () => {
    const report = buildDoctorReport({
      workspaceRoot: "/ws",
      configPath: "/ws/tachyon.yml",
      configFileExists: true,
      configValid: false,
      configFailure: {
        path: "/ws/tachyon.yml",
        file: "tachyon.yml",
        errors: ["cannot read /ws/tachyon.yml: permission denied"],
        at: "2026-07-10T16:09:00.000Z",
      },
      lkg: {
        schemaVersion: 1,
        savedAt: "2026-07-10T15:00:00.000Z",
        sourceFile: "tachyon.yml",
        agents: [{ name: "codex", kind: "agent" }],
      },
      ledger: [
        ["codex", ledgerRec({ instance: { lifetime: "saved", resumePolicy: "restartable", lifecycleHooks: true }, resume: { runtime: "codex", sessionId: "s1" } })],
      ],
      liveSessions: new Set(),
      knownSessions: new Set(),
      bridge: { port: 42897, url: "http://127.0.0.1:42897/mcp", reachable: true, authConfigured: true },
      transcriptPresence: new Map([["codex", false]]),
      now: new Date("2026-07-10T16:10:00.000Z"),
    });

    expect(report.findings.some((f) => f.id === "config.invalid" && f.severity === "error")).toBe(true);
    expect(report.findings.some((f) => f.id === "lkg.present")).toBe(true);
    const ledger = report.findings.find((f) => f.id === "ledger.summary");
    expect(ledger?.detail).toMatch(/resumable without a live tmux session|missing transcript|fresh start/i);
    expect(report.suggestions.some((s) => /fix/i.test(s) || /Resume/i.test(s))).toBe(true);

    const text = formatDoctorReport(report);
    expect(text).toContain("Tachyon Doctor");
    expect(text).toContain("Invalid tachyon.yml");
    expect(text).toContain("permission denied");
  });

  it("shows the retained persistent Bridge launch detail when startup failed", () => {
    const report = buildDoctorReport({
      workspaceRoot: "/ws",
      configPath: "/ws/tachyon.yml",
      configFileExists: true,
      configValid: true,
      configFailure: null,
      lkg: null,
      ledger: [],
      liveSessions: new Set(),
      knownSessions: new Set(),
      bridge: {
        port: undefined,
        url: undefined,
        failure: {
          code: "SYSTEMD_USER_UNAVAILABLE",
          message: "Bridge is off because WSL user services are not running.",
          technicalDetail: "systemd-run exited with code 1: Failed to connect to bus: No medium found",
        },
      },
    });

    expect(report.findings).toContainEqual(expect.objectContaining({
      id: "bridge.start_failed",
      severity: "error",
      detail: expect.stringContaining("Failed to connect to bus"),
    }));
    expect(formatDoctorReport(report)).toContain("SYSTEMD_USER_UNAVAILABLE");
  });

  it("warns when companion mobile (Tailscale) is enabled and ready (SDD 422)", () => {
    const report = buildDoctorReport({
      workspaceRoot: "/ws",
      configPath: "/ws/tachyon.yml",
      configFileExists: true,
      configValid: true,
      configFailure: null,
      lkg: null,
      ledger: [],
      liveSessions: new Set(),
      knownSessions: new Set(),
      bridge: { port: 41000, url: "http://127.0.0.1:41000/mcp", reachable: true },
      companionLanAccess: true,
      companionTailscaleReady: true,
    });
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        id: "companion.mobile_tailscale",
        severity: "warn",
        title: expect.stringMatching(/Tailscale/i),
      }),
    );
    expect(report.suggestions.some((s) => /lanAccess/i.test(s))).toBe(true);
  });

  it("errors when companion mobile is on but Tailscale is missing (SDD 422)", () => {
    const report = buildDoctorReport({
      workspaceRoot: "/ws",
      configPath: "/ws/tachyon.yml",
      configFileExists: true,
      configValid: true,
      configFailure: null,
      lkg: null,
      ledger: [],
      liveSessions: new Set(),
      knownSessions: new Set(),
      bridge: { port: 41000, url: "http://127.0.0.1:41000/mcp", reachable: true },
      companionLanAccess: true,
      companionTailscaleReady: false,
    });
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        id: "companion.tailscale_required",
        severity: "error",
      }),
    );
  });
});
