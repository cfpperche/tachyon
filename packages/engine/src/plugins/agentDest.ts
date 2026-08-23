/**
 * t-54cdb2 — resolve plugin materialization destinations when the install scope is an agent.
 *
 * Workspace dests stay the measured runtime project paths (`.claude/skills`, `.mcp.json`, …).
 * Agent dests are the private harness home. Isolation of authorization (profile grants) is a
 * different mechanism; this module only answers "where may the engine write?".
 *
 * Isolation floor (task body + specs 226/298):
 *  - complete isolated harness (`harness:{}` or a canonical profile) qualifies
 *  - `isolate: transcript` / private configHome alone does NOT
 *  - missing agent, or an agent that cannot isolate a dest, fail closed — never fall back to
 *    workspace-global dests
 *
 * Codex skills have no isolated discovery root (measured: `<cwd>/.agents/skills` from cwd to
 * repo root, no CODEX_HOME substitute). Agent-scoped Codex skill dests are therefore refused.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { isValidAgentName } from "../config/nameValidation.js";
import { LOCKFILE_REL_PATH, parseLockfile, type MaterializedTarget } from "./lockfile.js";
import { PLUGIN_PAYLOAD_ROOT, PLUGIN_SKILLS_DIR, isContainedRelPath } from "./paths.js";
import type { Runtime } from "./manifest.js";
import {
  type AgentInstallScope,
  type InstallScope,
  WORKSPACE_INSTALL_SCOPE,
  isAgentInstallScope,
  sameInstallScope,
} from "./installScope.js";

const SKILL_NAME_SEG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const HARNESS_REL = ".tachyon/harness";

export type IsolationKind =
  | "canonical-profile"
  | "codex-home"
  | "transcript"
  | "none";

export interface RuntimeDestLayout {
  settingsRel: string;
  skillsRel: string | null;
  mcpRel: string | null;
}

export interface HarnessIdentity {
  agent: string;
  kind: IsolationKind;
  adapter: string | null;
  destRootRel: string;
  worktree: boolean;
}

export interface DestResolution {
  scope: InstallScope;
  dests: Record<Runtime, RuntimeDestLayout>;
  identity: HarnessIdentity | null;
}

export interface DestResolutionFailure {
  error: string;
}

export const WORKSPACE_DESTS: Record<Runtime, RuntimeDestLayout> = {
  claude: { settingsRel: ".claude/settings.json", skillsRel: ".claude/skills", mcpRel: ".mcp.json" },
  codex: { settingsRel: ".codex/hooks.json", skillsRel: ".agents/skills", mcpRel: ".codex/config.toml" },
  grok: { settingsRel: ".grok/hooks/tachyon-plugins.json", skillsRel: ".grok/skills", mcpRel: null },
};

export function agentHarnessRel(agent: string): string {
  return `${HARNESS_REL}/${agent}`;
}

export function agentSkillDestRel(agent: string, skill: string): string {
  return `${agentHarnessRel(agent)}/skills/${skill}`;
}

export function agentClaudeMcpRel(agent: string): string {
  return `${agentHarnessRel(agent)}/mcp.json`;
}

export function agentClaudeSettingsRel(agent: string): string {
  return `${agentHarnessRel(agent)}/settings.json`;
}

export function agentCodexConfigRel(agent: string): string {
  return `${agentHarnessRel(agent)}/config.toml`;
}

export function agentCodexHooksRel(agent: string): string {
  return `${agentHarnessRel(agent)}/hooks.json`;
}

export function agentGrokSkillsRel(agent: string): string {
  return `${agentHarnessRel(agent)}/skills`;
}

export function agentGrokHooksRel(agent: string): string {
  return `${agentHarnessRel(agent)}/.grok/hooks/tachyon-plugins.json`;
}

export function isHarnessSkillDest(file: string): boolean {
  const m = /^\.tachyon\/harness\/([A-Za-z][A-Za-z0-9_-]*)\/skills\/([^/]+)$/.exec(file);
  return !!m && isValidAgentName(m[1]!) && SKILL_NAME_SEG.test(m[2]!);
}

export function isHarnessMcpDest(runtime: Runtime, file: string): boolean {
  const m = /^\.tachyon\/harness\/([A-Za-z][A-Za-z0-9_-]*)\/(mcp\.json|config\.toml)$/.exec(file);
  if (!m || !isValidAgentName(m[1]!)) return false;
  if (runtime === "claude") return m[2] === "mcp.json";
  if (runtime === "codex") return m[2] === "config.toml";
  return false;
}

export function isHarnessSettingsDest(runtime: Runtime, file: string): boolean {
  const m = /^\.tachyon\/harness\/([A-Za-z][A-Za-z0-9_-]*)\/(.+)$/.exec(file);
  if (!m || !isValidAgentName(m[1]!)) return false;
  const rest = m[2]!;
  if (runtime === "claude") return rest === "settings.json";
  if (runtime === "codex") return rest === "hooks.json";
  if (runtime === "grok") return rest === ".grok/hooks/tachyon-plugins.json";
  return false;
}

export function targetScope(target: { scope?: InstallScope }): InstallScope {
  return target.scope ?? WORKSPACE_INSTALL_SCOPE;
}

export function targetMatchesScope(target: { scope?: InstallScope }, scope: InstallScope): boolean {
  return sameInstallScope(targetScope(target), scope);
}

interface ProfileProbe {
  adapter: string | null;
  worktree: boolean;
}

function readAgentProfile(workspaceRoot: string, agent: string): ProfileProbe | null {
  const file = path.join(workspaceRoot, ".tachyon", "agents", agent, "agent.yml");
  let text: string;
  try {
    const st = fs.lstatSync(file);
    if (st.isSymbolicLink() || !st.isFile()) return null;
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = parseYaml(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rec = parsed as Record<string, unknown>;
    const runtime = rec.runtime && typeof rec.runtime === "object" && !Array.isArray(rec.runtime)
      ? rec.runtime as Record<string, unknown>
      : null;
    const adapter = typeof runtime?.adapter === "string" ? runtime.adapter : null;
    const workspace = rec.workspace && typeof rec.workspace === "object" && !Array.isArray(rec.workspace)
      ? rec.workspace as Record<string, unknown>
      : null;
    const worktree = workspace?.worktree && typeof workspace.worktree === "object" && !Array.isArray(workspace.worktree)
      ? (workspace.worktree as Record<string, unknown>).enabled === true
      : false;
    return { adapter, worktree };
  } catch {
    return null;
  }
}

export function inspectAgentIsolation(workspaceRoot: string, agent: string): {
  ok: true;
  identity: HarnessIdentity;
} | {
  ok: false;
  error: string;
} {
  if (!isValidAgentName(agent)) {
    return { ok: false, error: `agent name '${agent}' is not a valid agent name` };
  }
  const destRootRel = agentHarnessRel(agent);
  const profile = readAgentProfile(workspaceRoot, agent);
  if (profile) {
    const adapter = profile.adapter;
    if (adapter === "claude" || adapter === "grok") {
      return {
        ok: true,
        identity: {
          agent,
          kind: "canonical-profile",
          adapter,
          destRootRel,
          worktree: profile.worktree,
        },
      };
    }
    if (adapter === "codex") {
      return {
        ok: true,
        identity: {
          agent,
          kind: "codex-home",
          adapter,
          destRootRel,
          worktree: profile.worktree,
        },
      };
    }
    return {
      ok: false,
      error: `agent '${agent}' runtime '${adapter ?? "unknown"}' has no measured isolated harness for plugin dests`,
    };
  }

  // No canonical profile is the whole answer: `.tachyon/agents/<name>/agent.yml` is the only place a
  // Saved Agent is declared. The `agents:` block of `tachyon.yml` used to be a second answer here, and
  // outlived both the file (0.93.30) and the inline species itself (legacyFleetGate) as a fallback that
  // could no longer fire (t-987825).
  return { ok: false, error: `agent '${agent}' does not exist` };
}

function agentDestsFor(identity: HarnessIdentity): Record<Runtime, RuntimeDestLayout> {
  const agent = identity.agent;
  const claude: RuntimeDestLayout = {
    settingsRel: agentClaudeSettingsRel(agent),
    skillsRel: `${agentHarnessRel(agent)}/skills`,
    mcpRel: agentClaudeMcpRel(agent),
  };
  // Codex: private CODEX_HOME isolates MCP/hooks. Skills stay undiscoverable from that home
  // (measured 0.146.1). skillsRel=null so the planner skips them instead of writing `.agents/skills`.
  const codex: RuntimeDestLayout = {
    settingsRel: agentCodexHooksRel(agent),
    skillsRel: null,
    mcpRel: agentCodexConfigRel(agent),
  };
  const grok: RuntimeDestLayout = {
    settingsRel: agentGrokHooksRel(agent),
    skillsRel: agentGrokSkillsRel(agent),
    mcpRel: null,
  };
  return { claude, codex, grok };
}

export function resolveInstallDests(workspaceRoot: string, scope: InstallScope = WORKSPACE_INSTALL_SCOPE): DestResolution | DestResolutionFailure {
  if (!isAgentInstallScope(scope)) {
    return { scope: WORKSPACE_INSTALL_SCOPE, dests: WORKSPACE_DESTS, identity: null };
  }
  const inspected = inspectAgentIsolation(workspaceRoot, scope.name);
  if (!inspected.ok) return { error: inspected.error };
  return { scope, dests: agentDestsFor(inspected.identity), identity: inspected.identity };
}

export function validSkillDestPath(runtime: Runtime, file: string): boolean {
  if (!isContainedRelPath(file)) return false;
  const workspace = WORKSPACE_DESTS[runtime].skillsRel;
  if (workspace) {
    const prefix = `${workspace}/`;
    if (file.startsWith(prefix) && SKILL_NAME_SEG.test(file.slice(prefix.length))) return true;
  }
  return isHarnessSkillDest(file);
}

export function validMcpDestPath(runtime: Runtime, file: string): boolean {
  if (!isContainedRelPath(file)) return false;
  if (WORKSPACE_DESTS[runtime].mcpRel !== null && file === WORKSPACE_DESTS[runtime].mcpRel) return true;
  return isHarnessMcpDest(runtime, file);
}

export function validSettingsDestPath(runtime: Runtime, file: string): boolean {
  if (!isContainedRelPath(file)) return false;
  if (file === WORKSPACE_DESTS[runtime].settingsRel) return true;
  return isHarnessSettingsDest(runtime, file);
}

/** Shared payload root stays one copy. Agent dests are directory symlinks to that payload. */
export function pluginSkillPayloadRel(pluginName: string, skill: string): string {
  return `${PLUGIN_PAYLOAD_ROOT}/${pluginName}/${PLUGIN_SKILLS_DIR}/${skill}`;
}

export function materializeSkillDest(srcAbs: string, destAbs: string, mode: "copy" | "link"): void {
  fs.rmSync(destAbs, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destAbs), { recursive: true, mode: 0o700 });
  if (mode === "link") {
    fs.symlinkSync(srcAbs, destAbs);
    return;
  }
  fs.cpSync(srcAbs, destAbs, { recursive: true, dereference: false });
}

function readLockfileSafe(workspaceRoot: string): ReturnType<typeof parseLockfile>["lockfile"] | undefined {
  const file = path.join(workspaceRoot, LOCKFILE_REL_PATH);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseLockfile(text);
  return parsed.lockfile;
}

function agentScopeOf(agent: string): AgentInstallScope {
  return { type: "agent", name: agent };
}

function destOwnedByAgent(file: string, agent: string): boolean {
  const prefix = `${agentHarnessRel(agent)}/`;
  return file === agentHarnessRel(agent) || file.startsWith(prefix);
}

/**
 * Re-apply engine dests after a harness rematerialize. Grant projection replaces the skill tree
 * and rewrites mcp/settings; this overlays lockfile dests scoped to `agent` so a spawn does not
 * drop an agent-scoped install. Existing dests (grant copies) are left alone. Missing skill dests
 * are re-linked to the shared payload (zero extra plugin bytes). MCP/hooks merge; `tachyon_bridge`
 * is never overwritten.
 */
/**
 * t-318d7d / 515 — materialize the ONE skill dest a grant names, when the disk does not have it.
 *
 * ## Why anything has to be written at launch at all
 *
 * Measured on codex 0.149.0 (t-ef3c1f): codex discovers skills from `<cwd>/.agents/skills` and from
 * `~/.agents/skills`, and from nowhere else — not from its own `CODEX_HOME`. So for a Codex agent, a
 * grant that exists only as a record delivers nothing: something must put the skill where the runtime
 * looks. That gap had no teeth while such an agent could hold no grant at all; it grew them in 0.93.39,
 * when the launch stopped writing the tree and started DELIVERING WHAT THE INSTALLER LEFT. Measured on
 * this workspace: three skill dests recorded as materialized, none of the three on disk, and a Codex
 * agent granted `agent-browser` refused at resume by the fail-closed digest check.
 *
 * ## Why it no longer asks the lockfile
 *
 * The first version looked the dest up in the lockfile — the installer's record of what it wrote. That
 * worked only because the installer wrote workspace dests for everyone, which is exactly what spec 515
 * removes: once install stops declaring `skill-dir`, a lookup finds nothing and the Codex agent is
 * refused again. The dependency was never necessary, only convenient. **The grant already carries the
 * payload it attests** (`path: .tachyon/plugins/<name>/skills/<skill>`, resolved to `sourcePath`), and
 * that is the whole of what materializing needs. Deriving from the grant also makes the delivery say
 * something true that the lockfile route could not: what is on disk is what THIS agent was granted,
 * rather than what some install once left for everybody.
 *
 * ## What it will not do
 *
 * Repair, not ownership: only the entry the caller names, only when it is ABSENT, and only from a
 * payload that exists. An entry already present — the human's, another plugin's, anything — is never
 * touched, which is the whole difference between this and the tree replacement that must not run at a
 * workspace root. A missing payload returns false rather than creating a dangling link, and the
 * caller's own digest check then refuses by name.
 */
export function restoreWorkspaceSkillDest(destRoot: string, skill: string, payloadDir: string): boolean {
  const destAbs = path.join(destRoot, skill);
  if (fs.existsSync(destAbs)) return false; // already there: never replace what is present
  let payload: fs.Stats;
  try {
    payload = fs.statSync(payloadDir);
  } catch {
    return false; // the grant names a payload that is gone — nothing honest to restore from
  }
  if (!payload.isDirectory()) return false;
  materializeSkillDest(payloadDir, destAbs, "link");
  return true;
}

export function overlayAgentPluginDests(workspaceRoot: string, agent: string): void {
  const lockfile = readLockfileSafe(workspaceRoot);
  if (!lockfile) return;
  const scope = agentScopeOf(agent);
  for (const plugin of Object.values(lockfile.plugins)) {
    const mine = plugin.targets.filter((t) => targetMatchesScope(t, scope) && destOwnedByAgent(t.file, agent));
    for (const t of mine) overlayOneTarget(workspaceRoot, plugin.name, t);
  }
}

function overlayOneTarget(workspaceRoot: string, pluginName: string, target: MaterializedTarget): void {
  const destAbs = path.join(workspaceRoot, target.file);
  if (target.kind === "skill-dir") {
    if (fs.existsSync(destAbs)) return;
    const srcAbs = path.join(workspaceRoot, pluginSkillPayloadRel(pluginName, path.posix.basename(target.file)));
    if (!fs.existsSync(srcAbs)) return;
    materializeSkillDest(srcAbs, destAbs, "link");
    return;
  }
  if (target.kind === "mcp-server" && target.ref && target.removal !== undefined) {
    if (target.ref === "tachyon_bridge") return;
    mergeClaudeMcpIfAbsent(destAbs, target.ref, target.removal);
    mergeCodexMcpIfAbsent(destAbs, target.ref, target.removal);
    return;
  }
  if (target.kind === "settings-hook" && target.ref && target.removal !== undefined) {
    mergeSettingsHookIfAbsent(destAbs, target.ref, target.removal);
  }
}

function mergeClaudeMcpIfAbsent(file: string, ref: string, entry: unknown): void {
  if (!file.endsWith(`${path.sep}mcp.json`) && !file.endsWith("/mcp.json")) return;
  let doc: { mcpServers?: Record<string, unknown> } = {};
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> };
  } catch {
    doc = {};
  }
  if (!doc.mcpServers || typeof doc.mcpServers !== "object" || Array.isArray(doc.mcpServers)) {
    doc.mcpServers = {};
  }
  if (doc.mcpServers.tachyon_bridge === undefined && ref === "tachyon_bridge") return;
  if (doc.mcpServers[ref] !== undefined) return;
  doc.mcpServers[ref] = entry;
  atomicWriteJson(file, doc);
}

function mergeCodexMcpIfAbsent(file: string, ref: string, removal: unknown): void {
  if (!file.endsWith(`${path.sep}config.toml`) && !file.endsWith("/config.toml")) return;
  if (typeof removal !== "string") return;
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    text = "";
  }
  const header = `[mcp_servers.${ref}]`;
  if (text.includes(header)) return;
  const next = text.trimEnd() === "" ? removal : `${text.trimEnd()}\n\n${removal}`;
  atomicWriteText(file, next.endsWith("\n") ? next : `${next}\n`);
}

function mergeSettingsHookIfAbsent(file: string, event: string, removal: unknown): void {
  if (!file.endsWith(`${path.sep}settings.json`) && !file.endsWith("/settings.json") && !file.endsWith("tachyon-plugins.json") && !file.endsWith(`${path.sep}hooks.json`)) {
    return;
  }
  let doc: Record<string, unknown> = {};
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    doc = {};
  }
  const hooks = doc.hooks && typeof doc.hooks === "object" && !Array.isArray(doc.hooks)
    ? { ...(doc.hooks as Record<string, unknown>) }
    : {};
  if (hooks[event] !== undefined) return;
  hooks[event] = removal;
  doc.hooks = hooks;
  atomicWriteJson(file, doc);
}

let __seq = 0;
function atomicWriteJson(file: string, value: unknown): void {
  atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function atomicWriteText(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${__seq++}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
