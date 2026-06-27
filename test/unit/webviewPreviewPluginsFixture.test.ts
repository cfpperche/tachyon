import { describe, it, expect } from "vitest";
import { buildPluginsViewModel, type UpdateCheck } from "../../src/plugins/viewModel.js";
import { serializeLockfile } from "../../src/plugins/lockfile.js";
import type { Runtime } from "../../src/plugins/manifest.js";
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
});
