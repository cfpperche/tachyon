import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { HarnessManager } from "@tachyon/engine/harness/HarnessManager.js";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pi-harness-resources-"));
const workspace = path.join(temp, "workspace");
const ambientHome = path.join(temp, "ambient-home");
const realPiHome = path.join(ambientHome, ".pi", "agent");
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(realPiHome, { recursive: true });
fs.writeFileSync(path.join(realPiHome, "settings.json"), JSON.stringify({ prompts: ["/ambient/never-load.md"], quietStartup: true }));
const realSettingsBefore = fs.readFileSync(path.join(realPiHome, "settings.json"), "utf8");

function writeSkill(root, name) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} dogfood\n---\nUse ${name}.\n`);
}

const directExtension = path.join(workspace, "resources", "direct.ts");
fs.mkdirSync(path.dirname(directExtension), { recursive: true });
fs.writeFileSync(directExtension, `export default function (pi) { pi.registerCommand("harness-direct", { description: "direct harness command", handler: async () => {} }); }\n`);
writeSkill(path.join(workspace, "resources", "direct-skill"), "harness-direct-skill");
fs.writeFileSync(path.join(workspace, "resources", "direct-prompt.md"), "---\ndescription: direct harness prompt\n---\nDirect.\n");

const colors = [
  "accent", "border", "borderAccent", "borderMuted", "success", "error", "warning", "muted", "dim", "text", "thinkingText",
  "selectedBg", "userMessageBg", "userMessageText", "customMessageBg", "customMessageText", "customMessageLabel", "toolPendingBg", "toolSuccessBg", "toolErrorBg", "toolTitle", "toolOutput",
  "mdHeading", "mdLink", "mdLinkUrl", "mdCode", "mdCodeBlock", "mdCodeBlockBorder", "mdQuote", "mdQuoteBorder", "mdHr", "mdListBullet",
  "toolDiffAdded", "toolDiffRemoved", "toolDiffContext", "syntaxComment", "syntaxKeyword", "syntaxFunction", "syntaxVariable", "syntaxString", "syntaxNumber", "syntaxType", "syntaxOperator", "syntaxPunctuation",
  "thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "bashMode",
];
const directTheme = path.join(workspace, "resources", "direct-theme.json");
fs.writeFileSync(directTheme, JSON.stringify({ name: "harness-direct-theme", colors: Object.fromEntries(colors.map((key) => [key, ""])) }));

const packageRoot = path.join(workspace, "resources", "local-package");
fs.mkdirSync(path.join(packageRoot, "extensions"), { recursive: true });
fs.mkdirSync(path.join(packageRoot, "prompts"), { recursive: true });
writeSkill(path.join(packageRoot, "skills", "package-skill"), "harness-package-skill");
fs.writeFileSync(path.join(packageRoot, "extensions", "package.ts"), `export default function (pi) { pi.registerCommand("harness-package", { description: "package harness command", handler: async () => {} }); }\n`);
fs.writeFileSync(path.join(packageRoot, "prompts", "package-prompt.md"), "---\ndescription: package harness prompt\n---\nPackage.\n");
fs.writeFileSync(path.join(packageRoot, "package.json"), JSON.stringify({
  name: "tachyon-pi-harness-dogfood",
  pi: { extensions: ["extensions"], skills: ["skills"], prompts: ["prompts"] },
}));

writeSkill(path.join(ambientHome, ".agents", "skills", "ambient-skill"), "ambient-must-not-load");
fs.mkdirSync(path.join(workspace, ".pi", "prompts"), { recursive: true });
fs.writeFileSync(path.join(workspace, ".pi", "prompts", "project-must-not-load.md"), "Project automatic resource.\n");

function startPi(materialized, sessionId) {
  const argv = materialized.args.map((arg) => arg.startsWith("'") && arg.endsWith("'") ? arg.slice(1, -1).replace(/'\\''/g, "'") : arg);
  const child = spawn("pi", [
    "--mode", "rpc", "--approve", "--session-id", sessionId,
    "Tachyon Pi resource harness dogfood primer.",
    ...argv,
  ], {
    cwd: workspace,
    env: { ...process.env, ...materialized.env, HOME: ambientHome, PI_SKIP_VERSION_CHECK: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let buffer = "";
  let sequence = 0;
  const waiters = new Map();
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      if (event.type === "response" && event.id && waiters.has(event.id)) {
        const waiter = waiters.get(event.id);
        waiters.delete(event.id);
        waiter.resolve(event);
      }
    }
  });
  child.once("exit", (code) => {
    if (code !== 0 && code !== null) {
      const error = new Error(`Pi exited ${code}\n${stderr}`);
      for (const waiter of waiters.values()) waiter.reject(error);
      waiters.clear();
    }
  });
  const request = (command) => new Promise((resolve, reject) => {
    const id = `req-${++sequence}`;
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`Pi RPC timeout for ${command.type}\n${stderr}`));
    }, 10_000);
    waiters.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    child.stdin.write(`${JSON.stringify({ id, ...command })}\n`);
  });
  const close = async () => {
    child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); resolve(); }, 2_000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  };
  return { request, close, stderr: () => stderr };
}

try {
  const manager = new HarnessManager(
    workspace,
    path.join(ambientHome, ".claude"),
    process.env,
    path.join(ambientHome, ".claude.json"),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    realPiHome,
  );
  const exact = manager.materializePiHome("pi-a", {
    inherit: "workspace",
    extensions: ["resources/direct.ts"],
    skills: ["resources/direct-skill"],
    prompts: ["resources/direct-prompt.md"],
    themes: ["resources/direct-theme.json"],
    packages: ["resources/local-package"],
  });
  const piA = startPi(exact, "tachyon-pi-harness-a");
  const response = await piA.request({ type: "get_commands" });
  await piA.close();
  if (!response.success) throw new Error(`Pi get_commands failed: ${JSON.stringify(response)}`);
  const names = new Set((response.data?.commands ?? []).map((command) => command.name));
  for (const expected of ["harness-direct", "harness-direct-skill", "direct-prompt", "harness-package", "harness-package-skill", "package-prompt"]) {
    const command = expected.includes("skill") ? `skill:${expected}` : expected;
    if (!names.has(command)) throw new Error(`declared resource command missing: ${command}; got ${[...names].join(", ")}\n${piA.stderr()}`);
  }
  for (const forbidden of ["skill:ambient-must-not-load", "project-must-not-load"]) {
    if (names.has(forbidden)) throw new Error(`automatic resource escaped exact harness posture: ${forbidden}`);
  }
  if (fs.existsSync(path.join(exact.home, "npm")) || fs.existsSync(path.join(exact.home, "git"))) {
    throw new Error("local package dogfood unexpectedly created an npm/git install store");
  }

  const sibling = manager.materializePiHome("pi-b", { inherit: "workspace", skills: ["resources/direct-skill"] });
  if (sibling.home === exact.home || sibling.args.join(" ").includes(exact.home)) throw new Error("sibling resource home leaked pi-a paths");
  const piB = startPi(sibling, "tachyon-pi-harness-b");
  const siblingResponse = await piB.request({ type: "get_commands" });
  await piB.close();
  const siblingNames = new Set((siblingResponse.data?.commands ?? []).map((command) => command.name));
  if (!siblingNames.has("skill:harness-direct-skill") || siblingNames.has("harness-direct") || siblingNames.has("harness-package")) {
    throw new Error(`sibling catalog was not isolated: ${[...siblingNames].join(", ")}`);
  }
  if (fs.readFileSync(path.join(realPiHome, "settings.json"), "utf8") !== realSettingsBefore) {
    throw new Error("ambient Pi settings were mutated");
  }

  console.log("PASS: Pi loaded exact private extension/skill/prompt/theme/local-package resources; ambient/project resources and sibling catalog stayed isolated; no installer ran");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
