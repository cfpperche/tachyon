import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentManager } from "../src/agents/AgentManager.js";
import { parseConfig, type TachyonConfig } from "../src/config/loadConfig.js";
import { loadAndRenderProjectGuidance } from "../src/config/projectGuidance.js";
import { renderPrimer, wrapWithPrimer } from "../src/agents/primer.js";
import { composeSpawnContractBrief, type SpawnContract } from "../src/agents/spawnContract.js";
import { briefFilePath, deliverableBody } from "../src/agents/briefFile.js";
import type { SpawnOptions } from "../src/agents/AgentManager.js";
import { TmuxService, workspaceHash, type ExecResult } from "../src/tmux/TmuxService.js";

const roots: string[] = [];

function configOf(yaml: string): TachyonConfig {
  const parsed = parseConfig(yaml);
  assert.deepEqual(parsed.errors, []);
  assert.ok(parsed.config);
  return parsed.config;
}

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
  return { root, config: configOf(yaml) };
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

function sanitizedEvidence(value: string): string {
  return roots.reduce((current, root) => current.replaceAll(root, "<workspace>"), value);
}

async function captureStartup(
  root: string,
  config: TachyonConfig,
  agent: string,
  options?: SpawnOptions,
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
  });
  await manager.spawn(agent, options);
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

  // SDD 411 — a guidance-only body that crosses the threshold is context, not a delegation.
  const longGuidance = workspace(`LONG_GUIDANCE_${"g".repeat(5_000)}`);
  const longCodex = await captureStartup(longGuidance.root, longGuidance.config, "worker");
  const longCodexFile = briefFilePath(longGuidance.root, "worker");
  assert.ok(longCodex.cmd.includes("Your full startup brief is long"));
  assert.ok(longCodex.cmd.includes("project guidance (1 source)"));
  assert.ok(longCodex.cmd.includes("task contract (absent)"));
  assert.ok(longCodex.cmd.includes("Task objective: absent"));
  assert.ok(!longCodex.cmd.includes("LONG_GUIDANCE_"));
  assert.ok(fs.readFileSync(longCodexFile, "utf8").includes("Task: absent"));
  assert.ok(fs.readFileSync(longCodexFile, "utf8").includes("LONG_GUIDANCE_"));

  const longHermes = await captureStartup(longGuidance.root, longGuidance.config, "hermes");
  assert.equal(longHermes.cmd, "hermes");
  assert.ok(longHermes.env.HERMES_TUI_QUERY?.includes("Your full startup brief is long"));
  assert.ok(longHermes.env.HERMES_TUI_QUERY?.includes("task contract (absent)"));

  const startupBeforeReanchor = fs.readFileSync(longCodexFile, "utf8");
  const reanchorBody = `REANCHOR_GUIDANCE_${"r".repeat(5_000)}`;
  const reanchorPointer = deliverableBody(longGuidance.root, "worker", reanchorBody, "reanchor");
  const reanchorFile = briefFilePath(longGuidance.root, "worker", "reanchor");
  assert.ok(reanchorPointer.includes("Your full re-anchor context is long"));
  assert.ok(reanchorPointer.includes(reanchorFile));
  assert.equal(fs.readFileSync(reanchorFile, "utf8"), reanchorBody);
  assert.equal(fs.readFileSync(longCodexFile, "utf8"), startupBeforeReanchor);

  const captureContract = async (
    name: string,
    contract: SpawnContract,
    completion: "DELIVERABLE" | "DONE_WHEN",
  ): Promise<string> => {
    const brief = composeSpawnContractBrief(name, contract, undefined, "coordinator");
    const paddedBrief = `${brief}\n\nEVIDENCE_PADDING:${"p".repeat(5_000)}`;
    const startup = await captureStartup(unconfigured.root, unconfigured.config, name, {
      cmd: "codex",
      taskBrief: paddedBrief,
      contract,
      parent: "coordinator",
    });
    const stored = fs.readFileSync(briefFilePath(unconfigured.root, name), "utf8");
    assert.ok(startup.cmd.includes(`task contract (${completion})`));
    assert.ok(stored.includes(`Task: contract (${completion})`));
    assert.ok(stored.includes(brief));
    return startup.cmd;
  };
  const deliverablePointer = await captureContract("deliverable-child", {
    task: "Produce a startup-brief artifact",
    context: "The dogfood exercises typed completion metadata",
    constraints: "Preserve the rendered task bytes",
    deliverable: "A captured long startup file",
  }, "DELIVERABLE");
  const donePointer = await captureContract("done-child", {
    task: "Verify the startup-brief artifact",
    context: "The dogfood exercises typed completion metadata",
    constraints: "Preserve the rendered task bytes",
    doneWhen: "The long startup pointer reports DONE_WHEN",
  }, "DONE_WHEN");

  const resumeConfig = configOf("agents:\n  resumed:\n    cmd: codex resume existing-session\n");
  const resumed = await captureStartup(unconfigured.root, resumeConfig, "resumed");
  assert.equal(resumed.cmd, "codex resume existing-session");
  assert.deepEqual(resumed.env, { TACHYON_AGENT_NAME: "resumed" });

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

  const storedLongCodex = fs.readFileSync(longCodexFile, "utf8");
  const inventoryEnd = storedLongCodex.indexOf("── END STARTUP BRIEF CONTENTS ──");
  assert.ok(inventoryEnd > 0);
  const inventory = storedLongCodex.slice(
    0,
    inventoryEnd + "── END STARTUP BRIEF CONTENTS ──".length,
  );
  console.log("[codex positional startup]\n" + sanitizedEvidence(longCodex.cmd));
  console.log("[hermes TUI startup]\n" + sanitizedEvidence(longHermes.env.HERMES_TUI_QUERY ?? ""));
  console.log("[DELIVERABLE pointer]\n" + sanitizedEvidence(deliverablePointer));
  console.log("[DONE_WHEN pointer]\n" + sanitizedEvidence(donePointer));
  console.log("[re-anchor pointer]\n" + sanitizedEvidence(reanchorPointer));
  console.log("[startup file inventory]\n" + inventory);
  console.log("startup-brief dogfood: guidance-only and structured contracts are typed, bounded, lossless, and runtime-native");
} finally {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}
