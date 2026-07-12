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
} from "../../src/config/configFailure.js";
import {
  parseConfigLkg,
  readConfigLkg,
  snapshotFromConfig,
  writeConfigLkg,
  type ConfigLkgSnapshot,
} from "../../src/config/configLkg.js";
import { parseConfig } from "../../src/config/loadConfig.js";
import type { SessionRecord } from "../../src/resume/SessionLedger.js";
import { buildDoctorReport, formatDoctorReport } from "../../src/workspace/doctorReport.js";

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-fail-visible-"));
}

function ledgerRec(partial: Partial<SessionRecord> & { cwd?: string } = {}): SessionRecord {
  return {
    cwd: partial.cwd ?? "/ws",
    declared: partial.declared ?? true,
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
        ["codex", ledgerRec({ declared: true, resume: { runtime: "codex", sessionId: "s1" } })],
        ["ad-hoc-fix", ledgerRec({ declared: false, def: { cmd: "claude", kind: "agent" } })],
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
    expect(names).toEqual(["ad-hoc-fix", "codex", "never-ran"]);
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
      ledger: [["codex", ledgerRec({ declared: true, resume: { runtime: "codex", sessionId: "abc" } })]],
      lkg,
    });
    expect(extras.map((e) => e.name).sort()).toEqual(["codex", "reviewer"]);
    expect(extras.find((e) => e.name === "codex")?.resumable).toBe(true);
  });

  it("(c) with config invalid, spawn of LKG-only names is refused; live/adhoc names are not", () => {
    expect(
      isLkgOnlySpawn({ configValid: false, nameInLiveConfigOrAdhoc: false, nameInLkg: true }),
    ).toBe(true);
    expect(
      isLkgOnlySpawn({ configValid: false, nameInLiveConfigOrAdhoc: true, nameInLkg: true }),
    ).toBe(false);
    expect(
      isLkgOnlySpawn({ configValid: true, nameInLiveConfigOrAdhoc: false, nameInLkg: true }),
    ).toBe(false);
    expect(lkgSpawnRefusalMessage("reviewer", "tachyon.yml")).toMatch(/render-only/);
  });

  it("does not duplicate names already in the live list", () => {
    const extras = degradedRosterExtras({
      existingNames: new Set(["codex"]),
      ledger: [["codex", ledgerRec({ declared: true })]],
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
  it("(d) invalid config + stale ledger entry produce corresponding findings", () => {
    const report = buildDoctorReport({
      workspaceRoot: "/ws",
      configPath: "/ws/tachyon.yml",
      configFileExists: true,
      configValid: false,
      configFailure: {
        path: "/ws/tachyon.yml",
        file: "tachyon.yml",
        errors: ["'reviewer' is not declared in agents/terminals"],
        at: "2026-07-10T16:09:00.000Z",
      },
      lkg: {
        schemaVersion: 1,
        savedAt: "2026-07-10T15:00:00.000Z",
        sourceFile: "tachyon.yml",
        agents: [{ name: "codex", kind: "agent" }],
      },
      ledger: [
        ["codex", ledgerRec({ declared: true, resume: { runtime: "codex", sessionId: "s1" } })],
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
    expect(text).toContain("reviewer");
  });
});
