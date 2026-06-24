import { describe, it, expect } from "vitest";
import { buildInstallConsent, buildUpdateConsent, buildRemoveConsent, deriveUpdateCheck } from "../../src/plugins/consentViewModel.js";
import type { InstallPreview, InstallProvenance, UpdatePreview, RemovePreview, InstallStep, McpPlanItem } from "../../src/plugins/engine.js";
import type { McpServer } from "../../src/plugins/mcp.js";

const PROV: InstallProvenance = {
  source: { type: "git", spec: "github:acme/tdd-guard@v1.3.0", remote: "https://github.com/acme/tdd-guard.git", ref: "v1.3.0", resolvedCommit: "c".repeat(40) },
  integrity: { algorithm: "sha256", payload: "deadbeefcafef00d1234" },
};

function step(runtime: "claude" | "codex", settingsRel: string, cmds: string[]): InstallStep {
  return { runtime, settingsRel, before: {} as never, after: {} as never, owned: {} as never, wiredCommands: cmds };
}

function installPreview(over: Partial<InstallPreview> = {}): InstallPreview {
  return {
    manifest: { name: "tdd-guard", version: "1.3.0", description: "", runtimes: ["claude", "codex"], dependencies: [], blocks: { claude: "claude/", codex: "codex/" } },
    steps: [step("claude", ".claude/settings.json", ["bash .tachyon/plugins/tdd-guard/claude/guard.sh"]), step("codex", ".codex/hooks.json", ["bash .tachyon/plugins/tdd-guard/codex/verify.sh"])],
    skillTargets: [],
    mcpTargets: [],
    mcpConfigBefore: [],
    skipped: [],
    warnings: [],
    errors: [],
    fingerprint: "fp-abc",
    payloadHash: "ph-xyz",
    ...over,
  };
}

describe("buildInstallConsent", () => {
  it("shapes provenance, runtimes, the permission summary, writes, and the fingerprint token", () => {
    const vm = buildInstallConsent(installPreview(), PROV);
    expect(vm.op).toBe("install");
    expect(vm.title).toBe("Install tdd-guard@1.3.0");
    expect(vm.confirmLabel).toBe("Install");
    expect(vm.token).toBe("fp-abc"); // the TOCTOU consent fingerprint
    expect(vm.provenance).toEqual([
      { k: "source", v: "github:acme/tdd-guard@v1.3.0" },
      { k: "ref", v: "v1.3.0" },
      { k: "resolved commit", v: "cccccccccccc" },
      { k: "integrity", v: "sha256:deadbeefcafe" },
    ]);
    expect(vm.runtimes).toEqual([
      { runtime: "claude", status: "install" },
      { runtime: "codex", status: "install" },
    ]);
    // every shell command that will run on agent events is surfaced (the security review)
    expect(vm.wiredCommands).toEqual([
      { runtime: "claude", command: "bash .tachyon/plugins/tdd-guard/claude/guard.sh" },
      { runtime: "codex", command: "bash .tachyon/plugins/tdd-guard/codex/verify.sh" },
    ]);
    expect(vm.writes?.map((w) => w.file)).toEqual([
      ".claude/settings.json",
      ".codex/hooks.json",
      ".tachyon/plugins/tdd-guard/**",
      ".tachyon/plugins.lock.json",
    ]);
    expect(vm.errors).toBeUndefined();
  });

  it("marks declared-but-absent runtimes as skip", () => {
    const vm = buildInstallConsent(installPreview({ steps: [step("claude", ".claude/settings.json", ["x"])], skipped: ["codex"] }), PROV);
    expect(vm.runtimes).toEqual([
      { runtime: "claude", status: "install" },
      { runtime: "codex", status: "skip" },
    ]);
  });

  it("a dir install (no provenance) omits the provenance section", () => {
    const vm = buildInstallConsent(installPreview());
    expect(vm.provenance).toBeUndefined();
  });

  it("surfaces preview errors (confirm-disabling) and warnings", () => {
    const vm = buildInstallConsent(installPreview({ errors: ["boom"], warnings: ["heads up"] }), PROV);
    expect(vm.errors).toEqual(["boom"]);
    expect(vm.warnings).toEqual(["heads up"]);
  });

  it("groups skills per name + surfaces colliding destinations for Keep/Replace (spec 251 Step 4)", () => {
    const vm = buildInstallConsent(installPreview({
      skillTargets: [
        { runtime: "claude", skill: "deploy", srcRel: ".tachyon/plugins/x/skills/deploy", destRel: ".claude/skills/deploy", collision: false },
        { runtime: "codex", skill: "deploy", srcRel: ".tachyon/plugins/x/skills/deploy", destRel: ".agents/skills/deploy", collision: true },
      ],
    }), PROV);
    expect(vm.skills).toEqual([{ name: "deploy", runtimes: ["claude", "codex"] }]);
    expect(vm.skillCollisions).toEqual([{ skill: "deploy", runtime: "codex", destRel: ".agents/skills/deploy" }]);
  });

  it("omits the skills section when the plugin ships none", () => {
    const vm = buildInstallConsent(installPreview({ skillTargets: [] }), PROV);
    expect(vm.skills).toBeUndefined();
    expect(vm.skillCollisions).toBeUndefined();
  });

  const STDIO: McpServer = { name: "db", transport: "stdio", command: "npx", args: ["-y", "@scope/db"], env: { DB_URL: "${DB_URL}" } };
  const HTTP: McpServer = { name: "api", transport: "http", url: "https://api.test/v1", headers: { Authorization: "Bearer ${API_TOKEN}" } };
  const mcpItem = (server: McpServer, runtime: "claude" | "codex", collision = false): McpPlanItem => ({
    runtime, server, ref: server.name, destRel: runtime === "claude" ? ".mcp.json" : ".codex/config.toml", current: collision ? { command: "USER" } : undefined, collision,
  });

  it("surfaces MCP servers (command/url + env refs) and requires the double-confirm (OQ5)", () => {
    const vm = buildInstallConsent(installPreview({ mcpTargets: [mcpItem(STDIO, "claude"), mcpItem(STDIO, "codex"), mcpItem(HTTP, "claude")] }), PROV);
    expect(vm.requiresMcpConfirm).toBe(true);
    expect(vm.mcp).toEqual([
      { name: "db", transport: "stdio", detail: "npx -y @scope/db", env: ["DB_URL"], runtimes: ["claude", "codex"] },
      { name: "api", transport: "http", detail: "https://api.test/v1", env: ["API_TOKEN"], runtimes: ["claude"] },
    ]);
  });

  it("surfaces colliding MCP server names with the mcpDecisions key", () => {
    const vm = buildInstallConsent(installPreview({ mcpTargets: [mcpItem(STDIO, "claude", true)] }), PROV);
    expect(vm.mcpCollisions).toEqual([{ server: "db", runtime: "claude", key: "claude db" }]);
  });

  it("omits the MCP section + double-confirm when the plugin ships none", () => {
    const vm = buildInstallConsent(installPreview({ mcpTargets: [] }), PROV);
    expect(vm.mcp).toBeUndefined();
    expect(vm.requiresMcpConfirm).toBeUndefined();
    expect(vm.mcpCollisions).toBeUndefined();
  });
});

function updatePreview(over: Partial<UpdatePreview> = {}): UpdatePreview {
  return { found: true, upToDate: false, isDowngrade: false, fromVersion: "1.2.0", toVersion: "1.3.0", conflicts: [], install: installPreview(), errors: [], ...over };
}

describe("buildUpdateConsent", () => {
  it("a clean update is a plain Update (no force)", () => {
    const vm = buildUpdateConsent(updatePreview(), PROV);
    expect(vm.title).toBe("Update tdd-guard → 1.3.0");
    expect(vm.confirmLabel).toBe("Update");
    expect(vm.requiresForce).toBeUndefined();
    expect(vm.token).toBe("fp-abc");
    expect(vm.wiredCommands).toHaveLength(2);
  });

  it("conflicts force the update and surface the edited/collided counts", () => {
    const vm = buildUpdateConsent(updatePreview({ conflicts: [{ runtime: "claude", settingsRel: ".claude/settings.json", edited: 2, collided: 1 }] }), PROV);
    expect(vm.requiresForce).toBe(true);
    expect(vm.confirmLabel).toBe("Force update");
    expect(vm.conflicts).toEqual([{ settingsRel: ".claude/settings.json", edited: 2, collided: 1 }]);
  });

  it("forceReinstall frames the drawer as a Reinstall", () => {
    const vm = buildUpdateConsent(updatePreview(), PROV, true);
    expect(vm.title).toBe("Reinstall tdd-guard@1.3.0");
    expect(vm.requiresForce).toBe(true);
  });

  it("a downgrade requires force", () => {
    const vm = buildUpdateConsent(updatePreview({ isDowngrade: true, toVersion: "1.1.0" }), PROV);
    expect(vm.isDowngrade).toBe(true);
    expect(vm.requiresForce).toBe(true);
  });

  it("up-to-date / not-found become confirm-disabling errors", () => {
    expect(buildUpdateConsent(updatePreview({ upToDate: true }), PROV).errors).toContain("already up to date (v1.3.0)");
    expect(buildUpdateConsent(updatePreview({ found: false }), PROV).errors?.some((e) => /not installed/.test(e))).toBe(true);
  });
});

describe("buildRemoveConsent", () => {
  it("summarizes removed groups + orphans and uses the remove fingerprint as token (TOCTOU)", () => {
    const preview: RemovePreview = { found: true, orphans: 1, removedCount: 3, expectedCount: 4, skillCount: 0, mcpCount: 0, fingerprint: "rm-fp-77", errors: [] };
    const vm = buildRemoveConsent("tdd-guard", "1.3.0", preview);
    expect(vm.op).toBe("remove");
    expect(vm.title).toBe("Remove tdd-guard");
    expect(vm.token).toBe("rm-fp-77"); // the consent fingerprint, NOT the bare name
    expect(vm.removeSummary).toEqual({ removedCount: 3, orphans: 1 });
    expect(vm.warnings?.[0]).toMatch(/orphan/);
  });

  it("a not-found plugin is a confirm-disabling error", () => {
    const vm = buildRemoveConsent("ghost", "0.0.0", { found: false, orphans: 0, removedCount: 0, expectedCount: 0, skillCount: 0, mcpCount: 0, fingerprint: "", errors: [] });
    expect(vm.errors?.some((e) => /not installed/.test(e))).toBe(true);
  });
});

describe("deriveUpdateCheck", () => {
  it("maps the previewUpdate outcome to the card status", () => {
    expect(deriveUpdateCheck(updatePreview({ upToDate: true })).kind).toBe("up-to-date");
    expect(deriveUpdateCheck(updatePreview())).toEqual({ kind: "update-available", latestVersion: "1.3.0" });
    expect(deriveUpdateCheck(updatePreview({ conflicts: [{ runtime: "claude", settingsRel: ".claude/settings.json", edited: 1, collided: 0 }] }))).toEqual({ kind: "drift", detail: ".claude/settings.json: 1 edited" });
    expect(deriveUpdateCheck(updatePreview({ errors: ["x"] }))).toEqual({ kind: "error", detail: "x" });
    expect(deriveUpdateCheck(updatePreview({ found: false })).kind).toBe("error");
    expect(deriveUpdateCheck(updatePreview({ isDowngrade: true, toVersion: "1.1.0" })).kind).toBe("up-to-date");
  });
});
