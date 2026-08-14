import { describe, it, expect } from "vitest";
import { buildPluginsViewModel, type UpdateCheck } from "../../src/plugins/viewModel.js";
import { serializeLockfile } from "@tachyon/engine/plugins/lockfile.js";
import type { Runtime } from "@tachyon/engine/plugins/manifest.js";
import vms from "../../scripts/webview-preview/fixtures/plugins.vms.json";

// spec 278 — the host-shape / fixture-fidelity guard for the Plugins preview view.
// The browser harness imports the CAPTURED VM snapshot (plugins.vms.json) because the real builder's
// dependency chain touches node:path (can't go in the browser bundle). This NODE test rebuilds those VMs
// from the same input via the REAL builder and asserts equality — so a builder-shape drift makes the
// captured fixture stale and fails CI, instead of letting visual-qa judge a fiction. If this fails after an
// intentional builder change, regenerate the snapshot.

const INSTALLED = [
  { name: "agent-browser", version: "2.1.1", spec: "github:cfpperche/tachyon-plugins@v0.12.2#path=agent-browser" },
  { name: "dep-audit", version: "0.1.0", spec: "github:cfpperche/tachyon-plugins@v0.11.0#path=dep-audit" },
  { name: "sdd", version: "1.1.0", spec: "github:cfpperche/tachyon-plugins@v0.5.0#path=sdd" },
  { name: "secrets-guard", version: "2.0.1", spec: "github:cfpperche/tachyon-plugins@v0.9.0#path=secrets-guard" },
  { name: "visual-qa", version: "0.1.0", spec: "github:cfpperche/tachyon-plugins@v0.12.1#path=visual-qa" },
];
const rt: Runtime[] = ["claude", "codex"];

function lockText(): string {
  const map: Record<string, unknown> = {};
  for (const p of INSTALLED) {
    map[p.name] = {
      name: p.name,
      version: p.version,
      runtimes: rt,
      targets: rt.map((r) => ({ runtime: r, kind: "settings-hook", file: r === "claude" ? ".claude/settings.json" : ".codex/hooks.json", ref: "PreToolUse" })),
      source: { type: "git", spec: p.spec, remote: "https://github.com/cfpperche/tachyon-plugins.git", ref: p.spec.split("@")[1].split("#")[0], resolvedCommit: "a1b2c3d".padEnd(40, "0") },
      integrity: { algorithm: "sha256", payload: "deadbeefcafef00d" },
    };
  }
  return serializeLockfile({ schemaVersion: 1, plugins: map } as never);
}

const present = new Set<Runtime>(rt);
const intact = Object.fromEntries(INSTALLED.map((p) => [p.name, rt]));
const up = Object.fromEntries(INSTALLED.map((p) => [p.name, { kind: "up-to-date" } as UpdateCheck]));

describe("plugins preview fixture fidelity", () => {
  it("default matches the real builder output (up-to-date steady state)", () => {
    const real = buildPluginsViewModel({ lockfileText: lockText(), present, intact, updateChecks: up });
    expect(vms.default).toEqual(real);
  });

  it("update-available matches the real builder (visual-qa → 0.2.0)", () => {
    const real = buildPluginsViewModel({ lockfileText: lockText(), present, intact, updateChecks: { ...up, "visual-qa": { kind: "update-available", latestVersion: "0.2.0" } } });
    expect(vms.updateAvailable).toEqual(real);
    const vq = real.installed.find((p) => p.name === "visual-qa");
    expect(vq?.status).toEqual({ kind: "update-available", latestVersion: "0.2.0" });
  });

  it("empty matches the real builder cold state", () => {
    expect(vms.empty).toEqual(buildPluginsViewModel({ lockfileText: undefined, present }));
  });

  it("t-4e5f11 source-changed matches the real builder (secrets-guard · reapply)", () => {
    const real = buildPluginsViewModel({
      lockfileText: lockText(),
      present,
      intact,
      updateChecks: { ...up, "secrets-guard": { kind: "source-changed", version: "2.0.1" } },
    });
    expect((vms as unknown as { sourceChanged: unknown }).sourceChanged).toEqual(real);
    const sg = real.installed.find((p) => p.name === "secrets-guard");
    expect(sg?.status).toEqual({ kind: "source-changed", detail: "still v2.0.1" });
    expect(sg?.actions).toEqual(["reapply", "remove"]);
  });

  it("Phase C mcp-apply matches the real builder (installed-not-applied vs applied)", () => {
    const real = buildPluginsViewModel({
      lockfileText: lockText(),
      present,
      intact,
      updateChecks: up,
      mcpStatuses: { "agent-browser": [{ name: "db-tools", applied: false }, { name: "remote-api", applied: true }] },
      skillStatuses: { "agent-browser": [{ name: "browser-automation", applied: false }] },
      hookStatuses: { "agent-browser": [{ name: "PreToolUse", applied: true }] },
      gitHookStatuses: { "agent-browser": [{ name: "pre-commit", applied: false }] },
    });
    expect((vms as unknown as { mcpApply: unknown }).mcpApply).toEqual(real);
    const ab = real.installed.find((p) => p.name === "agent-browser");
    expect(ab?.mcpServers).toEqual([
      { name: "db-tools", applied: false },
      { name: "remote-api", applied: true },
    ]);
  });
});

/**
 * t-fb216a — the RUNTIME-COVERAGE GAP fixture: this is the field state measured on 0.56.158 (2026-08-02).
 * Every card resolves "up to date" (truthfully — the lock sits at the repo's highest semver tag with matching
 * versions) while the workspace runs grok and the install never covered it. agent-browser is the control: it
 * IS covered for grok, so its card must stay quiet. Exported so the generator and this guard share one input.
 */
export const GAP_INSTALLED: Array<{ name: string; version: string; spec: string; locked: Runtime[]; declared: Runtime[] }> = [
  { name: "agent-browser", version: "3.1.0", spec: "github:cfpperche/tachyon-plugins@v2.3.1#path=agent-browser", locked: ["claude", "codex", "grok"], declared: ["claude", "codex", "grok"] },
  { name: "dep-audit", version: "0.2.0", spec: "github:cfpperche/tachyon-plugins@v2.3.1#path=dep-audit", locked: ["claude", "codex"], declared: ["claude", "codex", "grok"] },
  { name: "sdd", version: "1.8.0", spec: "github:cfpperche/tachyon-plugins@v2.3.1#path=sdd", locked: ["claude", "codex"], declared: ["claude", "codex", "grok"] },
  { name: "secrets-guard", version: "2.1.0", spec: "github:cfpperche/tachyon-plugins@v2.2.1#path=secrets-guard", locked: ["claude", "codex"], declared: ["claude", "codex", "grok"] },
];

export const GAP_PRESENT = new Set<Runtime>(["claude", "codex", "grok"]);

export function gapLockText(): string {
  const map: Record<string, unknown> = {};
  for (const p of GAP_INSTALLED) {
    map[p.name] = {
      name: p.name,
      version: p.version,
      runtimes: p.locked,
      targets: p.locked.map((r) => ({ runtime: r, kind: "settings-hook", file: r === "claude" ? ".claude/settings.json" : r === "codex" ? ".codex/hooks.json" : ".grok/hooks/tachyon-plugins.json", ref: "PreToolUse" })),
      source: { type: "git", spec: p.spec, remote: "https://github.com/cfpperche/tachyon-plugins.git", ref: p.spec.split("@")[1].split("#")[0], resolvedCommit: "a1b2c3d".padEnd(40, "0") },
      integrity: { algorithm: "sha256", payload: "deadbeefcafef00d" },
    };
  }
  return serializeLockfile({ schemaVersion: 1, plugins: map } as never);
}

describe("plugins preview fixture fidelity — runtime-coverage gap (t-fb216a)", () => {
  it("runtimeGap matches the real builder: three cards name grok, the covered one stays quiet", () => {
    const intact = Object.fromEntries(GAP_INSTALLED.map((p) => [p.name, p.locked]));
    const declared = Object.fromEntries(GAP_INSTALLED.map((p) => [p.name, p.declared]));
    const updateChecks = Object.fromEntries(GAP_INSTALLED.map((p) => [p.name, { kind: "up-to-date" } as UpdateCheck]));
    const real = buildPluginsViewModel({ lockfileText: gapLockText(), present: GAP_PRESENT, intact, updateChecks, declared });
    expect((vms as unknown as { runtimeGap: unknown }).runtimeGap).toEqual(real);

    // the scenario's whole point: "up to date" and an uncovered runtime, on the same card, at the same time.
    const sg = real.installed.find((p) => p.name === "secrets-guard");
    expect(sg?.status.kind).toBe("up-to-date");
    expect(sg?.uncoveredRuntimes).toEqual(["grok"]);
    expect(real.installed.find((p) => p.name === "agent-browser")?.uncoveredRuntimes).toBeUndefined();
    expect(real.installed.filter((p) => p.uncoveredRuntimes?.length).map((p) => p.name)).toEqual(["dep-audit", "sdd", "secrets-guard"]);
  });
});
