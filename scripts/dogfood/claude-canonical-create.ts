/**
 * t-45e80d — headless dogfood for canonical Claude create-save.
 *
 * Drives the real lifecycle commit + the real profile-aware config loader against a controlled
 * HOME whose ~/.claude/settings.json carries the exact global keys reported in 0.56.109:
 *   $schema, _comment, mcpServers, statusLine, tui, skipDangerousModePermissionPrompt,
 *   switchModelsOnFlag, skipAutoPermissionPrompt (plus the authored theme/permissions).
 *
 * Asserts the product outcome: creation converges (activation succeeds, pointer + authority land)
 * while unselected global keys stay opaque and a selected-family invalid value still fails closed.
 *
 * t-af504e — `statusLine` moved OUT of that opaque set: it belongs to the Interface family now, so
 * the private home preserves the person's status line instead of blanking it. The rest of the
 * 0.56.109 key list is unchanged and still has to stay opaque.
 *
 * Run: npm run dogfood -- claude-canonical-create
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import {
  commitAgentProfileLifecycle,
  type AgentProfileLifecycleConfigPort,
} from "../../src/config/agentProfileLifecycle.js";
import type { AgentProfileAuthorityRecord } from "../../src/config/agentProfileAuthority.js";
import type { AgentProfileAuthorityPort } from "../../src/config/agentProfileTransactions.js";
import { loadProfileAwareConfig } from "../../src/config/agentProfileConfigLoader.js";
import { CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR } from "../../src/config/agentProfileProjection.js";
import { defaultClaudeScalarNativeConfigPolicy } from "../../src/config/agentNativeConfigPolicy.js";

const AGENT = "claude";

/** The real-world global settings that blocked creation in 0.56.109. */
const AMBIENT_GLOBAL_SETTINGS = {
  $schema: "https://json.schemastore.org/claude-code-settings.json",
  _comment: "personal global config",
  mcpServers: { local: { command: "some-server" } },
  statusLine: { type: "command", command: "personal-status-line" },
  tui: { theme: "dark" },
  skipDangerousModePermissionPrompt: true,
  switchModelsOnFlag: true,
  skipAutoPermissionPrompt: true,
  theme: "dark",
  alwaysThinkingEnabled: true,
};

const cleanup: string[] = [];
function temporaryDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), label));
  cleanup.push(dir);
  return dir;
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

class MemoryAuthority implements AgentProfileAuthorityPort {
  readonly records = new Map<string, AgentProfileAuthorityRecord>();
  async read(name: string) { const v = this.records.get(name); return v ? structuredClone(v) : undefined; }
  async publish(record: AgentProfileAuthorityRecord) {
    if (this.records.has(record.agentName)) throw new Error("authority CAS conflict");
    this.records.set(record.agentName, structuredClone(record));
  }
  async replace(record: AgentProfileAuthorityRecord, expected: AgentProfileAuthorityRecord) {
    if (JSON.stringify(this.records.get(record.agentName)) !== JSON.stringify(expected)) {
      throw new Error("authority CAS conflict");
    }
    this.records.set(record.agentName, structuredClone(record));
  }
  async retire(name: string, expected: AgentProfileAuthorityRecord) {
    if (JSON.stringify(this.records.get(name)) !== JSON.stringify(expected)) throw new Error("authority CAS conflict");
    this.records.delete(name);
  }
}

function configPort(root: string): AgentProfileLifecycleConfigPort {
  const file = path.join(root, "tachyon.yml");
  return {
    read: () => fs.readFileSync(file, "utf8"),
    replace: (expected, text) => {
      const current = fs.readFileSync(file, "utf8");
      if (sha256(current) !== expected) throw new Error("config CAS conflict");
      fs.writeFileSync(file, text);
    },
  };
}

function makeHome(settings: unknown): string {
  const home = temporaryDir("tachyon-dogfood-claude-home-");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify(settings, null, 2));
  return home;
}

/**
 * Create-save exactly as Agent Studio does: commit the lifecycle transaction, and let the
 * activation step reload config through the real loader bound to the controlled HOME.
 */
async function createSave(home: string, nativeConfig: Record<string, unknown>, seedRoster = true) {
  const root = temporaryDir("tachyon-dogfood-claude-ws-");
  // A real workspace already has at least one entry; seeding keeps rollback able to reload a
  // valid roster. `seedRoster: false` reproduces the empty-roster edge on purpose.
  fs.writeFileSync(
    path.join(root, "tachyon.yml"),
    seedRoster ? "agents: {}\nterminals:\n  shell:\n    cmd: bash\n" : "agents: {}\n",
  );
  const authority = new MemoryAuthority();
  const config = configPort(root);
  const activations: string[] = [];
  let lastErrors: string[] = [];

  const result = await commitAgentProfileLifecycle({
    workspaceRoot: root,
    agentName: AGENT,
    operation: "create",
    createProfile: {
      runtime: { adapter: "claude", executable: "claude" },
      nativeConfig,
    } as never,
    authority,
    config,
    activateState: (state) => {
      activations.push(state);
      if (state === "blocked") return;
      const record = authority.records.get(AGENT);
      const loaded = loadProfileAwareConfig({
        yamlText: config.read(),
        workspaceRoot: root,
        authorities: new Map(record ? [[AGENT, record]] : []),
        homeDir: home,
      });
      lastErrors = loaded.errors;
      // This is the production contract: a failed reload aborts activation and rolls the
      // transaction back, which is exactly how 0.56.109 refused to create `claude`.
      if (!loaded.config) {
        throw new Error(
          `trusted profile ${state} activation failed: ${loaded.errors.join("; ") || "unknown config failure"}`,
        );
      }
      lastProjection = loaded.config.agents[AGENT]?.profileNativeConfig;
    },
  });

  return { root, authority, config, result, activations, lastErrors };
}

let lastProjection: unknown;

function report(label: string, ok: boolean, detail: unknown): boolean {
  console.log(`${ok ? "PASS" : "FAIL"} — ${label}`);
  console.log(`     ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  return ok;
}

const checks: boolean[] = [];

// ── Scenario 1: the reported failure — default policy (all families global) + real ambient keys.
console.log("\n== Scenario 1: create-save with ambient global keys (the 0.56.109 failure) ==");
console.log(`   ambient global keys: ${Object.keys(AMBIENT_GLOBAL_SETTINGS).join(", ")}`);
{
  lastProjection = undefined;
  const home = makeHome(AMBIENT_GLOBAL_SETTINGS);
  // Default authoring for a new canonical Claude agent: every scalar family from `global`.
  const nativeConfig = defaultClaudeScalarNativeConfigPolicy() as Record<string, unknown>;
  // `permissions` is absent from this HOME, so the selected families resolve to interface+flags.
  try {
    const run = await createSave(home, nativeConfig);
    checks.push(report(
      "creation converges (lifecycle committed, no activation failure)",
      Boolean(run.result.revision) && run.activations.includes("target") && run.lastErrors.length === 0,
      { revision: run.result.revision, activations: run.activations, errors: run.lastErrors },
    ));
    checks.push(report(
      "pointer + authority landed",
      /profile: \.tachyon\/agents\/claude\/agent\.yml/.test(run.config.read()) && run.authority.records.has(AGENT),
      { authority: run.authority.records.get(AGENT)?.revision },
    ));
    checks.push(report(
      "only allowlisted keys projected (incl. statusLine); ambient keys stayed opaque",
      JSON.stringify(lastProjection) === JSON.stringify({
        adapter: "claude",
        selectors: {},
        settings: {
          theme: "dark",
          statusLine: AMBIENT_GLOBAL_SETTINGS.statusLine,
          alwaysThinkingEnabled: true,
        },
      }),
      lastProjection,
    ));
  } catch (error) {
    checks.push(report("creation converges", false, error instanceof Error ? error.message : String(error)));
  }
}

// ── Scenario 2: fail-closed preserved for an invalid value inside a SELECTED family.
console.log("\n== Scenario 2: selected-family invalid value must still fail closed ==");
{
  const home = makeHome({ ...AMBIENT_GLOBAL_SETTINGS, permissions: { defaultMode: "bypassPermissions" } });
  const nativeConfig = defaultClaudeScalarNativeConfigPolicy() as Record<string, unknown>;
  let refused = false;
  let message = "";
  try {
    const run = await createSave(home, nativeConfig);
    message = JSON.stringify({ revision: run.result.revision, errors: run.lastErrors });
  } catch (error) {
    refused = true;
    message = error instanceof Error ? error.message : String(error);
  }
  checks.push(report(
    "bypassPermissions in the selected permissions family is refused",
    refused && message.includes("'permissions.defaultMode' value 'bypassPermissions' is not projectable"),
    message,
  ));
  checks.push(report(
    "the refusal names the way out (t-111190)",
    refused && message.includes("set the Permissions family to Exclude"),
    message,
  ));
  checks.push(report(
    "refusal is about the value, not the unselected-key allowlist",
    refused && !message.includes("outside the selected family allowlist"),
    message,
  ));
  checks.push(report(
    "refusal rolls back cleanly (not degraded) on a populated roster",
    refused && !message.includes("degraded"),
    message,
  ));
}

// ── Scenario 3: workspace source keeps refusing ambient tooling (contract unchanged).
console.log("\n== Scenario 3: workspace ambient tooling still refused ==");
{
  const home = makeHome(AMBIENT_GLOBAL_SETTINGS);
  const root = temporaryDir("tachyon-dogfood-claude-wsonly-");
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "settings.json"), JSON.stringify({
    permissions: { allow: ["Read"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "ambient" }] }] },
  }));
  const bytes = Buffer.from(stringify({
    schemaVersion: 1,
    agentId: "22222222-2222-4222-8222-222222222222",
    runtime: { adapter: "claude", executable: "claude" },
    nativeConfig: {
      permissions: {
        source: "workspace", treatment: "overlay", refresh: "every-launch",
        lifecycle: ["fresh", "restart", "resume", "fork"],
      },
    },
  }));
  fs.mkdirSync(path.join(root, ".tachyon", "agents", AGENT), { recursive: true });
  fs.writeFileSync(path.join(root, ".tachyon", "agents", AGENT, "agent.yml"), bytes);
  const loaded = loadProfileAwareConfig({
    yamlText: `agents:\n  ${AGENT}:\n    profile: .tachyon/agents/${AGENT}/agent.yml\n`,
    workspaceRoot: root,
    authorities: new Map([[AGENT, {
      schemaVersion: 1,
      agentName: AGENT,
      agentId: "22222222-2222-4222-8222-222222222222",
      revision: "profile-r1",
      canonicalSha256: sha256(bytes.toString("utf8")),
      runtimeInspector: { ...CLAUDE_CLOSED_PRIVATE_HOME_INPUT_INSPECTOR },
    } as AgentProfileAuthorityRecord]]),
    homeDir: home,
  });
  checks.push(report(
    "unselected workspace key 'hooks' is still refused",
    !loaded.config && loaded.errors.join("\n").includes("Claude workspace key 'hooks' is outside the selected family allowlist"),
    loaded.errors,
  ));
}

// ── Scenario 5: the real reporter's HOME (bypassPermissions present) converges once the
// permissions family is excluded — interface/featureFlags still project from global.
console.log("\n== Scenario 5: bypassPermissions HOME converges with permissions excluded ==");
{
  lastProjection = undefined;
  const home = makeHome({ ...AMBIENT_GLOBAL_SETTINGS, permissions: { defaultMode: "bypassPermissions" } });
  const nativeConfig = defaultClaudeScalarNativeConfigPolicy() as Record<string, unknown>;
  delete nativeConfig.permissions;
  try {
    const run = await createSave(home, nativeConfig);
    checks.push(report(
      "creation converges with permissions excluded",
      run.activations.includes("target") && run.lastErrors.length === 0,
      { activations: run.activations, errors: run.lastErrors, projection: lastProjection },
    ));
  } catch (error) {
    checks.push(report("creation converges with permissions excluded", false, error instanceof Error ? error.message : String(error)));
  }
}

// ── Scenario 4: rolling the FIRST agent back restores an empty roster, which loadConfig refuses.
// The durable restore is complete by then, so the person must get the real refusal and a clean
// rollback — not a degraded transaction blocking an agent that no longer exists (t-07d05c).
console.log("\n== Scenario 4: empty-roster rollback stays clean (t-07d05c) ==");
{
  const home = makeHome({ ...AMBIENT_GLOBAL_SETTINGS, permissions: { defaultMode: "bypassPermissions" } });
  let message = "";
  try {
    await createSave(home, defaultClaudeScalarNativeConfigPolicy() as Record<string, unknown>, false);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  checks.push(report(
    "first-agent rollback reports the real refusal, not a degraded transaction",
    message.includes("'permissions.defaultMode' value 'bypassPermissions' is not projectable")
    && !message.includes("degraded"),
    message,
  ));
}

for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });

const failed = checks.filter((ok) => !ok).length;
console.log(`\n${failed === 0 ? "DOGFOOD PASS" : "DOGFOOD FAIL"} — ${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
