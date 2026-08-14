import { describe, it, expect } from "vitest";
import { buildInstallConsent, buildReinstallConsent, buildUpdateConsent, buildRemoveConsent, deriveUpdateCheck } from "../../src/plugins/consentViewModel";
import type { InstallPreview, InstallProvenance, UpdatePreview, RemovePreview, InstallStep, McpPlanItem } from "../../src/plugins/engine.js";
import type { McpServer } from "@tachyon/engine/plugins/mcp.js";

const PROV: InstallProvenance = {
  source: { type: "git", spec: "github:acme/tdd-guard@v1.3.0", remote: "https://github.com/acme/tdd-guard.git", ref: "v1.3.0", resolvedCommit: "c".repeat(40) },
  integrity: { algorithm: "sha256", payload: "deadbeefcafef00d1234" },
};

function step(runtime: "claude" | "codex", settingsRel: string, cmds: string[]): InstallStep {
  return {
    runtime,
    settingsRel,
    before: {} as never,
    after: {} as never,
    owned: { PreToolUse: [{ matcher: runtime === "claude" ? "Bash" : "^Bash$", hooks: cmds.map((command) => ({ type: "command", command })) }] },
    wiredCommands: cmds,
  };
}

function installPreview(over: Partial<InstallPreview> = {}): InstallPreview {
  return {
    manifest: { name: "tdd-guard", version: "1.3.0", description: "", runtimes: ["claude", "codex"], dependencies: [], blocks: { claude: "claude/", codex: "codex/" }, gitHooks: {}, tools: {}, data: {}, externalTools: {} },
    steps: [step("claude", ".claude/settings.json", ["bash .tachyon/plugins/tdd-guard/claude/guard.sh"]), step("codex", ".codex/hooks.json", ["bash .tachyon/plugins/tdd-guard/codex/verify.sh"])],
    skillTargets: [],
    mcpTargets: [],
    mcpConfigBefore: [],
    gitHookTargets: [],
    toolTargets: [],
    dataTargets: [],
    externalTargets: [],
    viewTargets: [],
    targetRuntimes: ["claude", "codex"],
    skipped: [],
    warnings: [],
    errors: [],
    requires: [],
    fingerprint: "fp-abc",
    payloadHash: "ph-xyz",
    ...over,
  };
}

describe("buildInstallConsent", () => {
  it("surfaces declared dependencies (spec 276) — satisfied/missing — without blocking install", () => {
    const vm = buildInstallConsent(installPreview({ requires: [
      { name: "agent-browser", range: "^2.1.0", status: "satisfied", installedVersion: "2.3.0" },
      { name: "some-base", range: "^1", status: "missing" },
    ] }), PROV);
    expect(vm.requires).toEqual([
      { name: "agent-browser", range: "^2.1.0", status: "satisfied", installedVersion: "2.3.0" },
      { name: "some-base", range: "^1", status: "missing" },
    ]);
    // advisory — there is no requiresDepConfirm / blocking flag (a missing dep never gates install)
    expect((vm as unknown as Record<string, unknown>).requiresDepConfirm).toBeUndefined();
  });
  it("omits requires when the plugin declares none", () => {
    expect(buildInstallConsent(installPreview(), PROV).requires).toBeUndefined();
  });
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
      { runtime: "claude", selected: true, present: false },
      { runtime: "codex", selected: true, present: false },
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

  it("discloses runtime settings-hooks and keeps activation a workspace classification", () => {
    const vm = buildInstallConsent(installPreview(), PROV);
    expect(vm.settingsHooks).toEqual([
      { runtime: "claude", event: "PreToolUse", matchers: ["Bash"] },
      { runtime: "codex", event: "PreToolUse", matchers: ["^Bash$"] },
    ]);
    // Informational at install: projection into managed agent sessions remains the workspace-wide
    // settings.agentHookProjection decision, never a per-agent or second-confirm grant.
    expect((vm as unknown as Record<string, unknown>).requiresSettingsHookConfirm).toBeUndefined();
  });

  it("omits the settings-hook section when the plugin ships no runtime blocks", () => {
    const preview = installPreview({
      manifest: { ...installPreview().manifest, blocks: {} },
      steps: [],
    });
    expect(buildInstallConsent(preview, PROV).settingsHooks).toBeUndefined();
  });

  it("renders each declared runtime as a selector row (selected = in target, present = on disk) — spec 263", () => {
    // codex deselected (not in targetRuntimes); claude present on disk, codex will be created.
    const vm = buildInstallConsent(installPreview({ targetRuntimes: ["claude"], skipped: ["codex"] }), PROV, new Set(["claude"] as const));
    expect(vm.runtimes).toEqual([
      { runtime: "claude", selected: true, present: true },
      { runtime: "codex", selected: false, present: false },
    ]);
  });

  it("all-deselected yields every row unselected (drawer disables confirm) — spec 263", () => {
    const vm = buildInstallConsent(installPreview({ targetRuntimes: [], skipped: ["claude", "codex"] }), PROV, new Set(["claude", "codex"] as const));
    expect(vm.runtimes).toEqual([
      { runtime: "claude", selected: false, present: true },
      { runtime: "codex", selected: false, present: true },
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

  it("surfaces git-hooks + the dedicated acknowledgement (spec 264)", () => {
    const vm = buildInstallConsent(installPreview({ gitHookTargets: [{ event: "pre-commit", contentHash: "a".repeat(64), display: "gitleaks protect --staged", priorHook: { path: "/x/.git/hooks/pre-commit", mode: 0o755, type: "file", contentHash: "b".repeat(64) } }] }), PROV);
    expect(vm.requiresGitHookConfirm).toBe(true);
    expect(vm.gitHooks).toEqual([{ event: "pre-commit", command: "gitleaks protect --staged", chainsPrior: true }]);
  });

  it("omits the git-hook section when the plugin registers none", () => {
    const vm = buildInstallConsent(installPreview({ gitHookTargets: [] }), PROV);
    expect(vm.gitHooks).toBeUndefined();
    expect(vm.requiresGitHookConfirm).toBeUndefined();
  });

  it("surfaces views with separate UI, fleet-read, and per-action acknowledgements (spec 349)", () => {
    const vm = buildInstallConsent(installPreview({
      viewTargets: [{ id: "agents", title: "Agents", surface: "editor", entry: "ui/index.html", fileRel: ".tachyon/plugins/mundinho/ui/index.html", fleet: "summary", actions: ["focusAgent"] }],
    }), PROV);
    expect(vm.requiresViewConfirm).toBe(true);
    expect(vm.requiresFleetReadConfirm).toBe(true);
    expect(vm.requiresActionConfirm).toEqual({ "agents:focusAgent": expect.stringMatching(/reveal an agent terminal/) });
    expect(vm.views).toEqual([{
      id: "agents",
      title: "Agents",
      surface: "editor",
      entry: "ui/index.html",
      fleet: "summary",
      disclosure: expect.stringMatching(/Draws UI.*name-free summary/),
      actions: [{ name: "focusAgent", disclosure: expect.stringMatching(/terminal contents/) }],
    }]);
  });

  it("omits the views section when the plugin declares none", () => {
    const vm = buildInstallConsent(installPreview({ viewTargets: [] }), PROV);
    expect(vm.views).toBeUndefined();
    expect(vm.requiresViewConfirm).toBeUndefined();
    expect(vm.requiresFleetReadConfirm).toBeUndefined();
    expect(vm.requiresActionConfirm).toBeUndefined();
  });

  it("surfaces tools + the dedicated acknowledgement (spec 265)", () => {
    const tool = { name: "gitleaks", version: "8.18.4", resolvedPlatform: "linux-x64-glibc", declaredUrl: "https://github.com/org/gitleaks/releases/g.tar.gz", finalUrl: "https://objects.githubusercontent.com/g", sha256: "a".repeat(64), binSha256: "b".repeat(64), exeName: "gitleaks" };
    const vm = buildInstallConsent(installPreview({ toolTargets: [tool] }), PROV);
    expect(vm.requiresToolConfirm).toBe(true);
    expect(vm.tools).toEqual([{ name: "gitleaks", version: "8.18.4", platform: "linux-x64-glibc", declaredUrl: tool.declaredUrl, finalUrl: tool.finalUrl, sha256: "a".repeat(64), publisher: "github.com" }]);
  });

  it("omits the tool section when the plugin provisions none", () => {
    const vm = buildInstallConsent(installPreview({ toolTargets: [] }), PROV);
    expect(vm.tools).toBeUndefined();
    expect(vm.requiresToolConfirm).toBeUndefined();
  });

  it("spec 269 — surfaces a tool's enforced launch policy in consent", () => {
    const lp = { env: { AGENT_BROWSER_CONFIRM_ACTIONS: "click" }, denyArgs: ["--confirm-actions"], mode: "force" as const };
    const tool = { name: "ab", version: "0.31.0", resolvedPlatform: "linux-x64-glibc", declaredUrl: "https://github.com/org/ab/releases/ab", finalUrl: "https://github.com/org/ab/releases/ab", sha256: "a".repeat(64), binSha256: "a".repeat(64), exeName: "ab", launchPolicy: lp };
    const vm = buildInstallConsent(installPreview({ toolTargets: [tool] }), PROV);
    expect(vm.tools?.[0].launchPolicy).toEqual(lp);
  });
});

describe("buildReinstallConsent", () => {
  it("uses the blocking install drawer contract, including commit provenance and all selected runtimes", () => {
    const preview = installPreview({
      manifest: { ...installPreview().manifest, runtimes: ["claude", "codex", "grok"], blocks: { claude: "claude/", codex: "codex/", grok: "grok/" } },
      targetRuntimes: ["claude", "codex", "grok"],
    });
    const vm = buildReinstallConsent(preview, PROV, new Set(["claude", "codex"] as const));
    expect(vm.op).toBe("install");
    expect(vm.title).toBe("Reinstall tdd-guard@1.3.0");
    expect(vm.confirmLabel).toBe("Reinstall");
    expect(vm.token).toBe("fp-abc");
    expect(vm.provenance).toContainEqual({ k: "resolved commit", v: "cccccccccccc" });
    expect(vm.runtimes).toEqual([
      { runtime: "claude", selected: true, present: true },
      { runtime: "codex", selected: true, present: true },
      { runtime: "grok", selected: true, present: false },
    ]);
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

  it("t-4e5f11 — same-version content change frames as Reapply, not Update", () => {
    const vm = buildUpdateConsent(updatePreview({
      fromVersion: "1.3.0",
      toVersion: "1.3.0",
      contentChangedSameVersion: true,
    }), PROV);
    expect(vm.title).toBe("Reapply tdd-guard@1.3.0 — source content changed");
    expect(vm.confirmLabel).toBe("Reapply");
    expect(vm.warnings?.[0]).toMatch(/still 1\.3\.0/);
    expect(vm.errors).toBeUndefined();
    expect(vm.requiresForce).toBeUndefined();
  });
});

describe("buildRemoveConsent", () => {
  it("summarizes removed groups + orphans and uses the remove fingerprint as token (TOCTOU)", () => {
    const preview: RemovePreview = { found: true, orphans: 1, removedCount: 3, expectedCount: 4, skillCount: 0, mcpCount: 0, gitHookCount: 0, fingerprint: "rm-fp-77", errors: [] };
    const vm = buildRemoveConsent("tdd-guard", "1.3.0", preview);
    expect(vm.op).toBe("remove");
    expect(vm.title).toBe("Remove tdd-guard");
    expect(vm.token).toBe("rm-fp-77"); // the consent fingerprint, NOT the bare name
    expect(vm.removeSummary).toEqual({ removedCount: 3, skillCount: 0, mcpCount: 0, gitHookCount: 0, orphans: 1 });
    expect(vm.warnings?.[0]).toMatch(/orphan/);
  });

  it("surfaces skills + MCP + git-hook counts in the removal summary (a skills/hook-only plugin is not '0 hooks')", () => {
    const preview: RemovePreview = { found: true, orphans: 0, removedCount: 0, expectedCount: 0, skillCount: 2, mcpCount: 1, gitHookCount: 1, fingerprint: "rm-fp-88", errors: [] };
    const vm = buildRemoveConsent("sdd", "1.1.0", preview);
    expect(vm.removeSummary).toEqual({ removedCount: 0, skillCount: 2, mcpCount: 1, gitHookCount: 1, orphans: 0 });
  });

  it("a not-found plugin is a confirm-disabling error", () => {
    const vm = buildRemoveConsent("ghost", "0.0.0", { found: false, orphans: 0, removedCount: 0, expectedCount: 0, skillCount: 0, mcpCount: 0, gitHookCount: 0, fingerprint: "", errors: [] });
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
    // t-4e5f11 — not "update-available · v{same}" (that would imply a version bump)
    expect(deriveUpdateCheck(updatePreview({ fromVersion: "1.3.0", toVersion: "1.3.0", contentChangedSameVersion: true }))).toEqual({
      kind: "source-changed",
      version: "1.3.0",
    });
  });
});
