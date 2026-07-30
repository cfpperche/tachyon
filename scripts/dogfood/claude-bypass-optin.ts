/**
 * SDD 471 / t-98427e — headless dogfood for the per-agent bypassPermissions authorization.
 *
 * The security property under test: a `~/.claude/settings.json` carrying
 * `permissions.defaultMode: "bypassPermissions"` must NOT reach a canonical agent's private home
 * just because the person has it globally. Only an agent whose own profile names the authorization
 * projects it — and then it must reach that agent's private CLAUDE_CONFIG_DIR on every lifecycle
 * phase, while a sibling agent reading the SAME global file stays refused.
 *
 * Drives the real profile loader, the real Claude projector and the real HarnessManager against a
 * controlled HOME.
 *
 * Run: npm run dogfood -- claude-bypass-optin
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { loadProfileAwareConfig } from "../../src/config/agentProfileConfigLoader.js";
import { CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR } from "../../src/config/agentProfileProjection.js";
import type { AgentProfileAuthorityRecord } from "../../src/config/agentProfileAuthority.js";
import { HarnessManager } from "../../src/harness/HarnessManager.js";
import { adapterForRuntime } from "../../src/resume/adapters.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const LIFECYCLE = ["fresh", "restart", "resume", "fork"];

/** The real-world global setting this spec is about. */
const GLOBAL_SETTINGS = {
  $schema: "https://json.schemastore.org/claude-code-settings.json",
  permissions: { defaultMode: "bypassPermissions", allow: ["Read"] },
  theme: "dark",
};

const cleanup: string[] = [];
function temporaryDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  cleanup.push(dir);
  return dir;
}

function sha256(bytes: string | Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function writeProfile(root: string, agentName: string, nativeConfig: unknown): Buffer {
  const directory = path.join(root, ".tachyon", "agents", agentName);
  fs.mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from(stringify({
    schemaVersion: 1,
    agentId: AGENT_ID,
    runtime: { adapter: "claude", executable: "claude" },
    nativeConfig,
  }));
  fs.writeFileSync(path.join(directory, "agent.yml"), bytes);
  return bytes;
}

function load(root: string, agentName: string, bytes: Buffer, homeDir: string) {
  return loadProfileAwareConfig({
    yamlText: `agents:\n  ${agentName}:\n    profile: .tachyon/agents/${agentName}/agent.yml\n`,
    workspaceRoot: root,
    authorities: new Map([[agentName, {
      schemaVersion: 1,
      agentName,
      agentId: AGENT_ID,
      revision: "profile-r1",
      canonicalSha256: sha256(bytes),
      runtimeInspector: { ...CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR },
    } as AgentProfileAuthorityRecord]]),
    homeDir,
  });
}

function makeHome(): string {
  const home = temporaryDir("tachyon-bypass-home-");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(GLOBAL_SETTINGS, null, 2));
  // The private home symlinks the real home's credentials; a redirected config home starts logged
  // out without it, so the harness refuses to materialize.
  fs.writeFileSync(path.join(home, ".credentials.json"), "{}\n");
  return home;
}

const PERMISSIONS_POLICY = {
  source: "global", treatment: "overlay", refresh: "every-launch", lifecycle: LIFECYCLE,
};

function report(label: string, ok: boolean, detail: unknown): boolean {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
  console.log(`     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  return ok;
}

const checks: boolean[] = [];
const home = makeHome();
console.log(`\nglobal ~/.claude/settings.json permissions: ${JSON.stringify(GLOBAL_SETTINGS.permissions)}`);

// ── 1: inheritance alone is not authorization.
console.log("\n== 1: unauthorized agent reading the same global file is refused ==");
{
  const root = temporaryDir("tachyon-bypass-unauth-");
  const bytes = writeProfile(root, "plain", { permissions: PERMISSIONS_POLICY });
  const result = load(root, "plain", bytes, home);
  checks.push(report(
    "refused, naming the value and the authorization route",
    result.config === undefined
    && result.errors.join("\n").includes("'bypassPermissions' is not projectable")
    && result.errors.join("\n").includes("authorize it explicitly for this agent"),
    result.errors,
  ));
}

// ── 2: an explicit per-agent authorization projects the measured value.
console.log("\n== 2: authorized agent projects the measured value ==");
let authorizedProjection: unknown;
{
  const root = temporaryDir("tachyon-bypass-auth-");
  const bytes = writeProfile(root, "trusted", {
    permissions: { ...PERMISSIONS_POLICY, authorize: ["bypassPermissions"] },
  });
  const result = load(root, "trusted", bytes, home);
  authorizedProjection = result.config?.agents.trusted?.profileNativeConfig;
  checks.push(report(
    "projection carries defaultMode bypassPermissions",
    result.errors.length === 0
    && JSON.stringify((authorizedProjection as { settings?: Record<string, unknown> })?.settings?.permissions)
      === JSON.stringify({ defaultMode: "bypassPermissions", allow: ["Read"] }),
    { errors: result.errors, projection: authorizedProjection },
  ));
}

// ── 3: authorization is per-agent, not ambient — both agents above shared one global file.
console.log("\n== 3: authorization is per-agent, not ambient ==");
{
  const root = temporaryDir("tachyon-bypass-sibling-");
  const bytes = writeProfile(root, "sibling", { permissions: PERMISSIONS_POLICY });
  const sibling = load(root, "sibling", bytes, home);
  checks.push(report(
    "the sibling agent stays refused while the authorized one projects",
    sibling.config === undefined && authorizedProjection !== undefined,
    { siblingRefused: sibling.config === undefined, authorizedProjected: authorizedProjection !== undefined },
  ));
}

// ── 4: the authorized value reaches the private home on every lifecycle phase.
console.log("\n== 4: fresh / restart / resume / fork all materialize it ==");
{
  const ws = temporaryDir("tachyon-bypass-ws-");
  const claude = adapterForRuntime("claude")!;
  const mgr = new HarnessManager(ws, home, {}, path.join(home, ".claude.json"));
  const projection = authorizedProjection as Parameters<typeof mgr.materializeCanonicalClaudeHome>[3];
  const settingsOf = (h: string) => JSON.parse(fs.readFileSync(path.join(h, "settings.json"), "utf8"));

  const fresh = mgr.materializeCanonicalClaudeHome("trusted", claude, undefined, projection);
  const restart = mgr.materializeCanonicalClaudeHome("trusted", claude, undefined, projection);
  const resume = mgr.materializeCanonicalClaudeHome("trusted", claude, undefined, projection);
  const fork = mgr.materializeCanonicalClaudeHome("trusted-fork", claude, undefined, projection);

  const want = JSON.stringify({ defaultMode: "bypassPermissions", allow: ["Read"] });
  const sameHome = restart.home === fresh.home && resume.home === fresh.home;
  const allCarry = [fresh, restart, resume, fork]
    .every((phase) => JSON.stringify(settingsOf(phase.home).permissions) === want);
  checks.push(report(
    "same generation for fresh/restart/resume, distinct private home for fork, all carrying it",
    sameHome && fork.home !== fresh.home && allCarry,
    { home: fresh.home, forkHome: fork.home, permissions: settingsOf(fork.home).permissions },
  ));
}

// ── 5: the authorization widens nothing else.
console.log("\n== 5: authorization does not widen anything else ==");
{
  const otherHome = temporaryDir("tachyon-bypass-other-home-");
  fs.mkdirSync(path.join(otherHome, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(otherHome, ".claude", "settings.json"), JSON.stringify({
    permissions: { defaultMode: "someOtherMode" },
  }));
  const root = temporaryDir("tachyon-bypass-other-");
  const bytes = writeProfile(root, "trusted", {
    permissions: { ...PERMISSIONS_POLICY, authorize: ["bypassPermissions"] },
  });
  const result = load(root, "trusted", bytes, otherHome);
  checks.push(report(
    "a different refused mode is still refused under the same authorization",
    result.config === undefined && result.errors.join("\n").includes("'someOtherMode' is not projectable"),
    result.errors,
  ));
}

for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${failed === 0 ? "DOGFOOD PASS" : "DOGFOOD FAIL"} — ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
