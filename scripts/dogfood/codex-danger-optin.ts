/**
 * SDD 472 / t-b0440a — headless dogfood for the per-agent Codex danger authorizations.
 *
 * The security property under test: a `~/.codex/config.toml` carrying `approval_policy = "never"`
 * or `sandbox_mode = "danger-full-access"` must NOT reach a canonical agent's private CODEX_HOME
 * just because the person has it globally. Only an agent whose own profile names the matching
 * authorization projects it, a sibling reading the SAME config stays refused, and every measured
 * safe value keeps working untouched.
 *
 * Drives the real profile loader, the real Codex projector and the real HarnessManager.
 *
 * Value enums are measured — see docs/specs/472-codex-danger-value-optin/plan.md.
 *
 * Run: node scripts/dogfood/run.mjs codex-danger-optin
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { loadProfileAwareConfig } from "../../src/config/agentProfileConfigLoader.js";
import { CODEX_EMPTY_NATIVE_INPUT_INSPECTOR } from "../../src/config/agentProfileProjection.js";
import type { AgentProfileAuthorityRecord } from "../../src/config/agentProfileAuthority.js";
import { HarnessManager } from "../../src/harness/HarnessManager.js";
import { adapterForRuntime } from "@tachyon/shared/resume/adapters.js";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const LIFECYCLE = ["fresh", "restart", "resume"];
const PERMISSIONS = { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle: LIFECYCLE };
const SELECTORS = { source: "agent", treatment: "overlay", refresh: "every-launch", lifecycle: LIFECYCLE };

/** The real-world global config this spec is about. */
const DANGEROUS_CONFIG = 'approval_policy = "never"\nsandbox_mode = "danger-full-access"\n';

const cleanup: string[] = [];
function temporaryDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  cleanup.push(dir);
  return dir;
}

function sha256(bytes: string | Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function writeProfile(root: string, agentName: string, authorize?: string[]): Buffer {
  const directory = path.join(root, ".tachyon", "agents", agentName);
  fs.mkdirSync(directory, { recursive: true });
  const bytes = Buffer.from(stringify({
    schemaVersion: 1,
    agentId: AGENT_ID,
    runtime: { adapter: "codex", executable: "codex", model: "gpt-5.6" },
    nativeConfig: {
      selectors: SELECTORS,
      permissions: { ...PERMISSIONS, ...(authorize ? { authorize } : {}) },
    },
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
      runtimeInspector: { ...CODEX_EMPTY_NATIVE_INPUT_INSPECTOR },
    } as AgentProfileAuthorityRecord]]),
    homeDir,
  });
}

function makeHome(config: string): string {
  const home = temporaryDir("tachyon-codex-danger-home-");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), config);
  return home;
}

function report(label: string, ok: boolean, detail: unknown): boolean {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
  console.log(`     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  return ok;
}

const checks: boolean[] = [];
const home = makeHome(DANGEROUS_CONFIG);
console.log(`\nglobal ~/.codex/config.toml: ${JSON.stringify(DANGEROUS_CONFIG)}`);

// ── 1: inheritance alone is not authorization.
console.log("\n== 1: unauthorized agent reading that config is refused ==");
{
  const root = temporaryDir("tachyon-codex-unauth-");
  const result = load(root, "plain", writeProfile(root, "plain"), home);
  const text = result.errors.join("\n");
  checks.push(report(
    "both dangerous values refused, each naming its consequence and the way out",
    result.config === undefined
    && text.includes("key 'approval_policy' value 'never' means the agent never asks before running a command")
    && text.includes("key 'sandbox_mode' value 'danger-full-access' means the agent runs without a sandbox")
    && text.includes("authorize it for this agent"),
    result.errors,
  ));
}

// ── 2: an explicit per-agent authorization projects the measured values.
console.log("\n== 2: authorized agent projects both measured values ==");
let authorizedProjection: unknown;
{
  const root = temporaryDir("tachyon-codex-auth-");
  const bytes = writeProfile(root, "trusted", ["neverAskForApproval", "dangerFullAccess"]);
  const result = load(root, "trusted", bytes, home);
  authorizedProjection = result.config?.agents.trusted?.profileNativeConfig;
  checks.push(report(
    "projection carries approval_policy=never and sandbox_mode=danger-full-access",
    result.errors.length === 0
    && JSON.stringify((authorizedProjection as { permissions?: unknown })?.permissions)
      === JSON.stringify({ approvalPolicy: "never", sandboxMode: "danger-full-access" }),
    { errors: result.errors, permissions: (authorizedProjection as { permissions?: unknown })?.permissions },
  ));
}

// ── 3: each authorization grants only the capability it names.
console.log("\n== 3: an authorization grants only what it names ==");
{
  const root = temporaryDir("tachyon-codex-partial-");
  const result = load(root, "partial", writeProfile(root, "partial", ["dangerFullAccess"]), home);
  checks.push(report(
    "authorizing the sandbox does not also authorize skipping approvals",
    result.config === undefined && result.errors.join("\n").includes("key 'approval_policy' value 'never'"),
    result.errors,
  ));
}

// ── 4: per-agent, not ambient — every agent above read the same global config.
console.log("\n== 4: authorization is per-agent, not ambient ==");
{
  const root = temporaryDir("tachyon-codex-sibling-");
  const sibling = load(root, "sibling", writeProfile(root, "sibling"), home);
  checks.push(report(
    "the sibling stays refused while the authorized agent projects",
    sibling.config === undefined && authorizedProjection !== undefined,
    { siblingRefused: sibling.config === undefined, authorizedProjected: authorizedProjection !== undefined },
  ));
}

// ── 5: every measured safe value still projects with no authorization.
console.log("\n== 5: measured safe values are untouched ==");
{
  const safe: Array<[string, string]> = [
    ["approval_policy", "untrusted"],
    ["approval_policy", "on-failure"],
    ["approval_policy", "on-request"],
    ["sandbox_mode", "read-only"],
    ["sandbox_mode", "workspace-write"],
  ];
  const failures: string[] = [];
  for (const [key, value] of safe) {
    const safeHome = makeHome(`${key} = "${value}"\n`);
    const root = temporaryDir("tachyon-codex-safe-");
    const result = load(root, "safe", writeProfile(root, "safe"), safeHome);
    if (result.errors.length > 0) failures.push(`${key}=${value}: ${result.errors.join("; ")}`);
  }
  checks.push(report(
    "untrusted / on-failure / on-request / read-only / workspace-write all project unchanged",
    failures.length === 0,
    failures.length === 0 ? `${safe.length}/${safe.length} measured safe values projected` : failures,
  ));
}

// ── 6: an unmeasured value is refused rather than projected blindly.
console.log("\n== 6: an unmeasured value is refused ==");
{
  const oddHome = makeHome('approval_policy = "yolo"\n');
  const root = temporaryDir("tachyon-codex-odd-");
  const result = load(root, "odd", writeProfile(root, "odd"), oddHome);
  checks.push(report(
    "unmeasured value refused, naming the measured set and the CLI it was measured against",
    result.config === undefined
    && result.errors.join("\n").includes("value 'yolo' is not projectable")
    && result.errors.join("\n").includes("measured against codex-cli"),
    result.errors,
  ));
}

// ── 7: the authorized values reach the private CODEX_HOME on every Codex lifecycle phase.
console.log("\n== 7: fresh / restart / resume all materialize it ==");
{
  const ws = temporaryDir("tachyon-codex-ws-");
  const codexHome = temporaryDir("tachyon-codex-real-");
  fs.writeFileSync(path.join(codexHome, "auth.json"), "{}\n");
  const codex = adapterForRuntime("codex")!;
  const mgr = new HarnessManager(ws, temporaryDir("tachyon-codex-realhome-"), {}, undefined, codexHome);
  const projection = authorizedProjection as Parameters<typeof mgr.materializeCanonicalCodexHome>[2];
  const configOf = (h: string) => fs.readFileSync(path.join(h, "config.toml"), "utf8");

  const fresh = mgr.materializeCanonicalCodexHome("trusted", codex, projection);
  const restart = mgr.materializeCanonicalCodexHome("trusted", codex, projection);
  const resume = mgr.materializeCanonicalCodexHome("trusted", codex, projection);
  const sameHome = restart.home === fresh.home && resume.home === fresh.home;
  const allCarry = [fresh, restart, resume].every((phase) =>
    configOf(phase.home).includes('approval_policy = "never"')
    && configOf(phase.home).includes('sandbox_mode = "danger-full-access"'));
  checks.push(report(
    "one private generation across fresh/restart/resume, all carrying the authorized values",
    sameHome && allCarry,
    { home: fresh.home, sameHome, allCarry },
  ));
}

for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${failed === 0 ? "DOGFOOD PASS" : "DOGFOOD FAIL"} — ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
