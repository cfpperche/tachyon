/**
 * SDD 481 / t-ce83a2 — headless dogfood for the measured Grok Runtime Config adapter.
 *
 * The claim under test is the one a unit test cannot make: that what Control writes is what the
 * INSTALLED Grok actually reads. Every check drives the real `inspectGrokRuntimeConfig` /
 * `applyGrokRuntimeConfigChange` against a disposable `GROK_HOME` and then asks the real binary,
 * through `grok inspect --json`, what it discovered. No network, no login, no user home.
 *
 * Run: node scripts/dogfood/run.mjs grok-runtime-config
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  GROK_GLOBAL_CONFIG_DOCUMENT,
  GROK_TRUST_DOCUMENT,
  GROK_WORKSPACE_CONFIG_DOCUMENT,
  applyGrokRuntimeConfigChange,
  inspectGrokRuntimeConfig,
} from "../../apps/vscode-extension/src/runtimeConfig/grokInventory.js";

const checks: boolean[] = [];

function report(what: string, ok: boolean, detail?: unknown): boolean {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  checks.push(ok);
  return ok;
}

function grokVersion(): string | undefined {
  try {
    return execFileSync("grok", ["--version"], { encoding: "utf8", timeout: 30_000 }).trim();
  } catch {
    return undefined;
  }
}

const version = grokVersion();
if (!version) {
  // Never report a green that was not measured: an absent runtime is an absent measurement.
  console.log("DOGFOOD SKIP — grok is not installed on this host, so nothing was measured.");
  process.exit(2);
}
console.log(`Measuring against ${version}\n`);

const home = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-grok-dogfood-home-"));
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-grok-dogfood-repo-"));
// Measured: Grok resolves `projectRoot` from the git repository, and project hooks load only inside
// one. Project-scoped `[mcp_servers]` loads from the working directory either way.
execFileSync("git", ["init", "-q"], { cwd: repo, timeout: 60_000 });

function inspectWithGrok(): {
  mcpServers: Array<{ name: string }>;
  hooks: Array<{ event: string }>;
  projectTrusted: boolean;
} {
  return JSON.parse(execFileSync("grok", ["inspect", "--json"], {
    cwd: repo,
    env: { ...process.env, GROK_HOME: home },
    encoding: "utf8",
    timeout: 120_000,
  }));
}

function document(id: string) {
  const snapshot = inspectGrokRuntimeConfig({ workspaceRoot: repo, grokHome: home, agents: {} });
  return snapshot.documents.find((candidate) => candidate.id === id)!;
}

try {
  fs.writeFileSync(path.join(home, "config.toml"), [
    "# a comment the person wrote",
    "[cli]",
    'installer = "internal"',
    "",
    "[models]",
    'default = "grok-4.5"',
    "",
    '[models."corp-proxy"]',
    'api_key = "DO-NOT-EXPOSE-KEY"',
    "",
    "[ui]",
    "max_thoughts_width = 120",
    'permission_mode = "always-approve"',
    "",
    "[mcp_servers.keepme]",
    'command = "/bin/true"',
    "",
    "[mcp_servers.killme]",
    'command = "/bin/true"',
    "",
  ].join("\n"));
  fs.mkdirSync(path.join(repo, ".grok", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".grok", "config.toml"), '[mcp_servers.repo_tools]\ncommand = "/bin/true"\n');
  fs.writeFileSync(
    path.join(repo, ".grok", "hooks", "demo.json"),
    JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hook" }] }] } }),
  );

  console.log("== 1: the inventory names what Grok discovers, and no payload ==");
  {
    const snapshot = inspectGrokRuntimeConfig({ workspaceRoot: repo, grokHome: home, agents: {} });
    const global = snapshot.documents.find((candidate) => candidate.id === GROK_GLOBAL_CONFIG_DOCUMENT)!;
    const workspace = snapshot.documents.find((candidate) => candidate.id === GROK_WORKSPACE_CONFIG_DOCUMENT)!;
    const discovered = inspectWithGrok();
    report(
      "Control lists the same MCP names the runtime discovered",
      JSON.stringify([...global.mcpServers, ...workspace.mcpServers].map((server) => server.name).sort())
        === JSON.stringify(discovered.mcpServers.map((server) => server.name).sort()),
      { control: [...global.mcpServers, ...workspace.mcpServers].map((s) => s.name), grok: discovered.mcpServers.map((s) => s.name) },
    );
    report("no credential, command or payload reaches the snapshot", !JSON.stringify(snapshot).includes("DO-NOT-EXPOSE"));
    report("the workspace document offers no scalar editor", workspace.knownSettings.length === 0);
    report(
      "the authority key is visible and read-only",
      global.knownSettings.some((setting) => setting.key === "ui.permission_mode" && !setting.editable && !!setting.readOnlyReason),
    );
  }

  console.log("\n== 2: a Control write is a write the runtime honors ==");
  {
    const before = document(GROK_GLOBAL_CONFIG_DOCUMENT);
    applyGrokRuntimeConfigChange({
      workspaceRoot: repo,
      grokHome: home,
      documentId: GROK_GLOBAL_CONFIG_DOCUMENT,
      expectedRevision: before.revision,
      changes: [
        { kind: "set-mcp-enabled", name: "killme", enabled: false },
        { kind: "setting", key: "ui.max_thoughts_width", value: 140 },
      ],
    });
    const text = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    const discovered = inspectWithGrok();
    report(
      "the disabled server disappears from the runtime's own discovery",
      !discovered.mcpServers.some((server) => server.name === "killme")
      && discovered.mcpServers.some((server) => server.name === "keepme"),
      discovered.mcpServers.map((server) => server.name),
    );
    report("the comment, the unknown table and the provider credential survive the write",
      text.includes("# a comment the person wrote") && text.includes('api_key = "DO-NOT-EXPOSE-KEY"') && text.includes('installer = "internal"'));
    report("the measured scalar is patched in place", text.includes("max_thoughts_width = 140"));
    report("no lock file is left behind", !fs.existsSync(path.join(home, "config.toml.tachyon-runtime-config.lock")));
  }

  console.log("\n== 3: re-enabling restores the server ==");
  {
    const before = document(GROK_GLOBAL_CONFIG_DOCUMENT);
    report("Control reads back the disabled state", before.mcpServers.find((server) => server.name === "killme")?.enabled === false);
    applyGrokRuntimeConfigChange({
      workspaceRoot: repo,
      grokHome: home,
      documentId: GROK_GLOBAL_CONFIG_DOCUMENT,
      expectedRevision: before.revision,
      changes: [{ kind: "set-mcp-enabled", name: "killme", enabled: true }],
    });
    report(
      "the runtime discovers it again",
      inspectWithGrok().mcpServers.some((server) => server.name === "killme"),
    );
  }

  console.log("\n== 4: a stale revision is refused, not merged ==");
  {
    const stale = document(GROK_GLOBAL_CONFIG_DOCUMENT).revision;
    fs.appendFileSync(path.join(home, "config.toml"), "\n[unrelated]\nwritten_by_someone_else = true\n");
    let refused = false;
    try {
      applyGrokRuntimeConfigChange({
        workspaceRoot: repo,
        grokHome: home,
        documentId: GROK_GLOBAL_CONFIG_DOCUMENT,
        expectedRevision: stale,
        changes: [{ kind: "setting", key: "models.default", value: "grok-build" }],
      });
    } catch {
      refused = true;
    }
    report("a concurrent edit makes the save fail closed", refused);
    report(
      "the concurrent edit is still there",
      fs.readFileSync(path.join(home, "config.toml"), "utf8").includes("written_by_someone_else = true"),
    );
  }

  console.log("\n== 5: folder trust is reported, never granted ==");
  {
    const untrusted = document(GROK_TRUST_DOCUMENT);
    const beforeHooks = inspectWithGrok();
    report(
      "an undecided workspace reads as not trusted, and the runtime runs no project hook",
      untrusted.knownSettings.find((setting) => setting.key === "trusted")?.value === "Not decided"
      && beforeHooks.hooks.length === 0 && beforeHooks.projectTrusted === false,
      { hooks: beforeHooks.hooks.length, projectTrusted: beforeHooks.projectTrusted },
    );
    let refused = false;
    try {
      applyGrokRuntimeConfigChange({
        workspaceRoot: repo,
        grokHome: home,
        documentId: GROK_TRUST_DOCUMENT,
        expectedRevision: untrusted.revision,
        changes: [{ kind: "setting", key: "trusted", value: true }],
      });
    } catch {
      refused = true;
    }
    report("Control refuses to grant trust", refused && !fs.existsSync(path.join(home, "trusted_folders.toml")));

    // Grant it the way Grok does, then confirm Control reports the new state truthfully.
    fs.writeFileSync(
      path.join(home, "trusted_folders.toml"),
      `[folders."${repo}"]\ntrusted = true\ndecided_at = 1784138766\n`,
    );
    const afterHooks = inspectWithGrok();
    report(
      "once the runtime trusts the folder, Control reports it and the project hook loads",
      document(GROK_TRUST_DOCUMENT).knownSettings.find((setting) => setting.key === "trusted")?.value === "true"
      && afterHooks.projectTrusted === true && afterHooks.hooks.length === 1,
      { hooks: afterHooks.hooks.length, projectTrusted: afterHooks.projectTrusted },
    );
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
}

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${failed === 0 ? "DOGFOOD PASS" : "DOGFOOD FAIL"} — ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
