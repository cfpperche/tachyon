#!/usr/bin/env node

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dogfoodDir = join(repoRoot, "scripts", "dogfood");
const bin = (name) => join(repoRoot, "node_modules", ".bin", name);

const exceptions = {
  "dev-host": ["bash", ["scripts/dev-host/cli.sh"]],
  "ui-shortlist": ["bash", ["scripts/dev-host/run-shortlist.sh"]],
  "runtime-observability": [bin("vite-node"), ["--script", "scripts/runtime-observability-dogfood.ts"]],
  "restart-modes": [bin("vitest"), ["run", "test/integration/restartModesDogfood.test.ts"]],
  "runtime-launch-preflight": [
    process.execPath,
    [
      "scripts/dev-host/lane.mjs",
      "run",
      "--owner",
      "sdd-370-headless",
      "--target",
      "worktree",
      "--",
      "npm",
      "exec",
      "vitest",
      "run",
      "test/unit/codexCatalogStream.test.ts",
      "test/unit/runtimeLaunchPreflight.test.ts",
      "test/unit/devHostLane.test.ts",
      "test/unit/devHostLauncher.test.ts",
      "test/unit/engineSupervisor.test.ts",
      "test/unit/launchReadinessRecovery.test.ts",
      "test/unit/bridge.test.ts",
    ],
  ],
};

const scenarios = [
  "adhoc-agent-boundary",
  "auth-required-parity",
  "claude-bypass-optin",
  "claude-canonical-create",
  "claude-composer-suggestion",
  "codex-danger-optin",
  "dev-host",
  "execution-graph",
  "grok-attention-midturn",
  "grok-model-preflight",
  "grok-runtime-config",
  "native-config-sources",
  "persistent-engine",
  "probe-codex-model-proof",
  "probe-model-proof",
  "probe-provenance-parity",
  "probes-model-column",
  "restart-modes",
  "runtime-launch-preflight",
  "runtime-observability",
  "runtime-remeasure",
  "stop-exit-codes",
  "ui-shortlist",
  "worktree-plugin-projection",
];
const [name, ...extraArgs] = process.argv.slice(2);

if (!name || name === "--help" || name === "-h") {
  console.log("Usage: npm run dogfood -- <scenario> [args...]");
  console.log("       npm run dogfood -- --list");
  process.exit(name ? 0 : 1);
}
if (name === "--list") {
  console.log(scenarios.join("\n"));
  process.exit(0);
}
if (!scenarios.includes(name)) {
  console.error(`Unknown dogfood scenario '${name}'. Run 'npm run dogfood -- --list'.`);
  process.exit(1);
}

let command;
let args;
if (exceptions[name]) {
  [command, args] = exceptions[name];
} else {
  const candidates = [`${name}.ts`, `${name}.mts`, `${name}.mjs`];
  const file = candidates.find((candidate) => existsSync(join(dogfoodDir, candidate)));
  if (!file) {
    console.error(`Dogfood scenario '${name}' has no executable.`);
    process.exit(1);
  }
  if (file.endsWith(".mjs")) {
    command = process.execPath;
    args = [join("scripts", "dogfood", file)];
  } else {
    command = bin("vite-node");
    args = ["--script", join("scripts", "dogfood", file)];
  }
}

const result = spawnSync(command, [...args, ...extraArgs], {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
