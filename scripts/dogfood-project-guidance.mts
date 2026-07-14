import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentManager } from "../src/agents/AgentManager.js";
import { parseConfig, type TachyonConfig } from "../src/config/loadConfig.js";
import { loadAndRenderProjectGuidance } from "../src/config/projectGuidance.js";
import { renderPrimer, wrapWithPrimer } from "../src/bridge/primer.js";
import { TmuxService, workspaceHash, type ExecResult } from "../src/tmux/TmuxService.js";

const roots: string[] = [];

function workspace(marker: string, configured = true): { root: string; config: TachyonConfig } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-guidance-dogfood-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "agent.md"), `${marker}\n  preserved indentation\n`, "utf8");
  const yaml = [
    "agents:",
    "  worker:",
    "    cmd: codex",
    "  hermes:",
    "    cmd: hermes",
    ...(configured
      ? ["settings:", "  projectGuidance:", "    files:", "      - docs/agent.md"]
      : []),
    "",
  ].join("\n");
  const parsed = parseConfig(yaml);
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.config);
  return { root, config: parsed.config };
}

function envFromArgs(args: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (let index = 0; index < args.length - 1; index++) {
    if (args[index] !== "-e") continue;
    const pair = args[++index] ?? "";
    const separator = pair.indexOf("=");
    if (separator > 0) env[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return env;
}

async function captureStartup(
  root: string,
  config: TachyonConfig,
  agent: "worker" | "hermes",
): Promise<{ cmd: string; env: Record<string, string> }> {
  const sessions = new Set<string>();
  let launch: string[] | undefined;
  const exec = async (args: string[]): Promise<ExecResult> => {
    const targetIndex = args.indexOf("-t");
    const target = targetIndex >= 0 ? args[targetIndex + 1]?.replace(/^=/, "").replace(/:$/, "") : undefined;
    if (args.includes("new-session")) {
      launch = args;
      sessions.add(args[args.indexOf("-s") + 1] ?? "");
      return { stdout: "", stderr: "" };
    }
    if (args.includes("has-session")) {
      if (!target || !sessions.has(target)) throw new Error("no session");
      return { stdout: "", stderr: "" };
    }
    if (args.includes("list-panes")) {
      if (sessions.size === 0) throw new Error("no server");
      return { stdout: [...sessions].map((session) => `${session}\t0\t`).join("\n") + "\n", stderr: "" };
    }
    return { stdout: "", stderr: "" };
  };
  const manager = new AgentManager({
    tmux: new TmuxService(exec),
    wsHash: workspaceHash(root),
    workspaceRoot: root,
    getConfig: () => config,
    getMaxAgents: () => 8,
  });
  await manager.spawn(agent);
  assert.ok(launch, `AgentManager did not create a session for ${agent}`);
  const args = launch as string[];
  return { cmd: args.at(-1) ?? "", env: envFromArgs(args) };
}

try {
  const a = workspace("GUIDANCE_A");
  const b = workspace("GUIDANCE_B");
  const unconfigured = workspace("MUST_NOT_APPEAR", false);

  const aBlock = loadAndRenderProjectGuidance(a.root, a.config.settings.projectGuidance);
  const bBlock = loadAndRenderProjectGuidance(b.root, b.config.settings.projectGuidance);
  assert.ok(aBlock?.includes("── PROJECT GUIDANCE (PROJECT-OWNED) ──"));
  assert.ok(aBlock?.includes("Source: docs/agent.md\nGUIDANCE_A\n  preserved indentation\n"));
  assert.ok(!aBlock?.includes("GUIDANCE_B"));
  assert.ok(bBlock?.includes("GUIDANCE_B"));
  assert.ok(!bBlock?.includes("GUIDANCE_A"));
  assert.equal(
    loadAndRenderProjectGuidance(unconfigured.root, unconfigured.config.settings.projectGuidance),
    undefined,
  );

  // Exercise the real startup integration, not only the leaf renderer: AgentManager -> adapter ->
  // TmuxService argv/env. This catches a disconnected loader, wrong framing order, and Hermes env
  // regressions that direct renderer assertions cannot see.
  const aStartup = await captureStartup(a.root, a.config, "worker");
  const bStartup = await captureStartup(b.root, b.config, "worker");
  const noGuidanceStartup = await captureStartup(unconfigured.root, unconfigured.config, "worker");
  assert.ok(aStartup.cmd.includes("GUIDANCE_A"));
  assert.ok(!aStartup.cmd.includes("GUIDANCE_B"));
  assert.ok(bStartup.cmd.includes("GUIDANCE_B"));
  assert.ok(!noGuidanceStartup.cmd.includes("MUST_NOT_APPEAR"));
  const hermesStartup = await captureStartup(a.root, a.config, "hermes");
  assert.equal(hermesStartup.cmd, "hermes");
  assert.ok(hermesStartup.env.HERMES_TUI_QUERY?.includes("GUIDANCE_A"));
  assert.ok(hermesStartup.env.HERMES_TUI_QUERY?.includes("── TACHYON PRIMER ──"));

  const wrapped = wrapWithPrimer(aBlock, { agentName: "worker", parent: "coordinator" });
  assert.ok(wrapped.indexOf("── END PRIMER ──") < wrapped.indexOf("GUIDANCE_A"));
  assert.ok(wrapped.indexOf("GUIDANCE_A") < wrapped.indexOf("── BEFORE FINISHING ──"));

  const protocolOnly = renderPrimer({ agentName: "consumer" });
  const globalText = `${protocolOnly.primer}\n${protocolOnly.beforeFinishing}`;
  for (const forbidden of ["npm ci", "npm test", "git add", "git commit", "vscode.l10n", "<your spawner>"]) {
    assert.ok(!globalText.includes(forbidden), `global primer leaked project policy: ${forbidden}`);
  }

  fs.writeFileSync(path.join(a.root, "docs", "agent.md"), "GUIDANCE_A_V2", "utf8");
  assert.ok(loadAndRenderProjectGuidance(a.root, a.config.settings.projectGuidance)?.includes("GUIDANCE_A_V2"));
  assert.ok((await captureStartup(a.root, a.config, "worker")).cmd.includes("GUIDANCE_A_V2"));
  fs.rmSync(path.join(a.root, "docs", "agent.md"));
  assert.throws(
    () => loadAndRenderProjectGuidance(a.root, a.config.settings.projectGuidance),
    /docs\/agent\.md/,
  );

  console.log("project-guidance dogfood: isolated, current, provenance-labelled, and protocol-only by default");
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}
