import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadProfileAwareConfig,
  type LoadProfileAwareConfigInput,
} from "../../src/config/agentProfileConfigLoader.js";
import {
  CODEX_EMPTY_NATIVE_INPUT_INSPECTOR,
} from "../../src/config/agentProfileProjection.js";
import type { AgentProfileAuthorityRecord } from "../../src/config/agentProfileAuthority.js";
import { scanAgentProfilePointers } from "../../src/config/agentProfilePointer.js";

const roots: string[] = [];
const AGENT_ID = "11111111-1111-4111-8111-111111111111";

function temporaryRoot(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), label));
  roots.push(root);
  return root;
}

function sha256(bytes: string | Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function writeProfile(root: string, overrides: Record<string, unknown> = {}): Buffer {
  const directory = path.join(root, ".tachyon", "agents", "codex");
  fs.mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from(stringify({
    schemaVersion: 1,
    agentId: AGENT_ID,
    runtime: { adapter: "codex", executable: "codex" },
    ...overrides,
  }));
  fs.writeFileSync(path.join(directory, "agent.yml"), bytes);
  return bytes;
}

function authority(bytes: Buffer, overrides: Partial<AgentProfileAuthorityRecord> = {}): AgentProfileAuthorityRecord {
  return {
    schemaVersion: 1,
    agentName: "codex",
    agentId: AGENT_ID,
    revision: "profile-r1",
    canonicalSha256: sha256(bytes),
    runtimeInspector: { ...CODEX_EMPTY_NATIVE_INPUT_INSPECTOR },
    ...overrides,
  };
}

function load(root: string, record: AgentProfileAuthorityRecord, extra: Partial<LoadProfileAwareConfigInput> = {}) {
  const homeDir = temporaryRoot("tachyon-agent-profile-home-");
  return loadProfileAwareConfig({
    yamlText: "agents:\n  codex:\n    profile: .tachyon/agents/codex/agent.yml\n",
    workspaceRoot: root,
    authorities: new Map([["codex", record]]),
    homeDir,
    ...extra,
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("agent profile pointer syntax", () => {
  it("accepts only the exact conventional pointer", () => {
    const valid = scanAgentProfilePointers("agents:\n  codex:\n    profile: .tachyon/agents/codex/agent.yml\n");
    expect(valid.errors).toEqual([]);
    expect(valid.pointers.get("codex")?.path).toBe(".tachyon/agents/codex/agent.yml");

    const mixed = scanAgentProfilePointers("agents:\n  codex:\n    profile: .tachyon/agents/codex/agent.yml\n    cmd: codex\n");
    expect(mixed.errors).toContain("agents.codex: profile pointer cannot coexist with inline field(s): cmd");

    const arbitrary = scanAgentProfilePointers("agents:\n  codex:\n    profile: profiles/codex.yml\n");
    expect(arbitrary.errors[0]).toContain("expected \".tachyon/agents/codex/agent.yml\"");
  });
});

describe("loadProfileAwareConfig", () => {
  it("loads a profile and retains its trusted source metadata beside legacy agents", () => {
    const root = temporaryRoot("tachyon-agent-profile-workspace-");
    const bytes = writeProfile(root, {
      prompt: { role: "reviewer" },
      lifecycle: { autostart: true, restart: "on-crash" },
    });
    const result = load(root, authority(bytes), {
      yamlText: [
        "agents:",
        "  codex:",
        "    profile: .tachyon/agents/codex/agent.yml",
        "  helper:",
        "    cmd: claude",
        "",
      ].join("\n"),
    });

    expect(result.errors).toEqual([]);
    expect(result.config?.agents.codex).toMatchObject({
      cmd: "codex",
      role: "reviewer",
      autostart: true,
      restart: "on-crash",
    });
    expect(result.config?.agentSources.codex).toMatchObject({
      mode: "profile",
      agentId: AGENT_ID,
      profileSha256: sha256(bytes),
      authorityRevision: "profile-r1",
    });
    expect(result.config?.agentSources.helper?.mode).toBe("legacy");
  });

  it("fails closed when authority is absent, stale, or native config is non-empty", () => {
    const root = temporaryRoot("tachyon-agent-profile-workspace-");
    const bytes = writeProfile(root);
    const record = authority(bytes);

    const missing = loadProfileAwareConfig({
      yamlText: "agents:\n  codex:\n    profile: .tachyon/agents/codex/agent.yml\n",
      workspaceRoot: root,
      authorities: new Map(),
      homeDir: temporaryRoot("tachyon-agent-profile-home-"),
    });
    expect(missing.errors).toContain("agents.codex.profile: host profile authority is missing");

    const stale = load(root, { ...record, canonicalSha256: "f".repeat(64) });
    expect(stale.errors.join("\n")).toContain("profile/authority-boundary");

    const homeDir = temporaryRoot("tachyon-agent-profile-home-");
    fs.mkdirSync(path.join(homeDir, ".codex"));
    fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), "model = 'configured'\n");
    const native = load(root, record, { homeDir });
    expect(native.errors.join("\n")).toContain("non-empty native config is not supported");
  });

  it("rejects simultaneous inline and canonical owners", () => {
    const root = temporaryRoot("tachyon-agent-profile-workspace-");
    writeProfile(root);
    const result = loadProfileAwareConfig({
      yamlText: "agents:\n  codex:\n    cmd: codex\n",
      workspaceRoot: root,
      authorities: new Map(),
      homeDir: temporaryRoot("tachyon-agent-profile-home-"),
    });
    expect(result.errors.join("\n")).toContain("inline configuration conflicts with canonical profile");
  });
});
