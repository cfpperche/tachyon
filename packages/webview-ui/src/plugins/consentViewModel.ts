import type { Runtime, ToolLaunchPolicy } from "@tachyon/engine/plugins/manifest.js";
import type { DependencyState } from "./pluginDeps.js";
export type ConsentOp = "install" | "update" | "remove";


export interface ConsentRow {
  k: string;
  v: string;
}


/** A declared runtime in the consent drawer's per-runtime selector (spec 263). `selected` = will be
 *  materialized (install: user-toggleable; update/remove: fixed to the consented set). `present` = the
 *  runtime's config dir already exists in the workspace (label "present"); false ⇒ install will CREATE it. */
export interface ConsentRuntime {
  runtime: Runtime;
  selected: boolean;
  present: boolean;
}


/** One shell command that will run on an agent event once materialized (the security review surface). */
export interface ConsentCommand {
  runtime: Runtime;
  command: string;
}


/** A settings-hook block this plugin registers in one runtime. This is an install disclosure, not a
 * per-agent grant: projection into managed agent sessions remains workspace policy. */
export interface ConsentSettingsHook {
  runtime: Runtime;
  event: string;
  /** Exact runtime matchers. Empty means the hook block did not declare a matcher. */
  matchers: string[];
}


/** A file/dir Tachyon will write. */
export interface ConsentWrite {
  file: string;
  note?: string;
}


export interface ConsentConflict {
  settingsRel: string;
  /** baseline groups the user edited/removed (won't auto-update). */
  edited: number;
  /** user-added groups a new-version group would duplicate. */
  collided: number;
}


/** A skill this install/update materializes + the runtimes it lands in. */
export interface ConsentSkill {
  name: string;
  runtimes: Runtime[];
}


/** A colliding skill destination that needs a Keep/Replace decision (keyed by destRel). */
export interface ConsentSkillCollision {
  skill: string;
  runtime: Runtime;
  /** the decision key the apply echoes in `skillDecisions`. */
  destRel: string;
}


/** An MCP server this install/update materializes — the security surface: the exact command/url it will run
 *  and the env vars the user must provide. */
export interface ConsentMcp {
  name: string;
  transport: "stdio" | "http";
  /** the exact command + args (stdio) or the url (http). */
  detail: string;
  /** env-var NAMES this server references (the user provisions the values out-of-band). */
  env: string[];
  runtimes: Runtime[];
}


/** spec 264 — a git-hook this install/update will register: the exact command that runs on EVERY commit. */
export interface ConsentGitHook {
  event: string;
  /** the command/leaf that runs on the event (argv, or "<script> (payload script)"). */
  command: string;
  /** true ⇒ a pre-existing user hook will be chained first (preserved). */
  chainsPrior: boolean;
}


/** spec 349 — a UI surface this install/update will register. */
export interface ConsentView {
  id: string;
  title: string;
  surface: "editor" | "sidebar";
  entry: string;
  fleet: "summary";
  actions: Array<{ name: string; disclosure: string }>;
  disclosure: string;
}


/** spec 265 — a tool this install/update will DOWNLOAD + EXECUTE (the highest-trust capability). The drawer
 *  shows the resolved platform, the declared + redirect-resolved URL, the pinned checksum, and the publisher.
 *  Copy must say: the sha256 proves INTEGRITY against the manifest, NOT that the publisher is trustworthy. */
export interface ConsentTool {
  name: string;
  version: string;
  /** the resolved platform key the artifact is pinned for. */
  platform: string;
  /** the manifest-declared download URL. */
  declaredUrl: string;
  /** the redirect-resolved URL actually fetched (provenance). */
  finalUrl: string;
  /** the pinned artifact sha256 (integrity vs the manifest). */
  sha256: string;
  /** the URL host — surfaced as the publisher identity (NOT a trust assertion). */
  publisher: string;
  /** spec 269 — when present, this tool ALWAYS launches with these enforced env/args and refuses these args
   *  (shown in the drawer so the user consents to the forced launch behavior, not just the download). */
  launchPolicy?: ToolLaunchPolicy;
}


/** spec 284 — a DATA artifact this install will DOWNLOAD + STORE (read-only; never executed). Lower-trust than a
 *  tool: the drawer copy says "downloaded + stored, NOT executed" and that the sha256 proves integrity, not trust. */
export interface ConsentData {
  name: string;
  version: string;
  /** the resolved platform key, or "any" for a single cross-platform blob. */
  platform: string;
  declaredUrl: string;
  finalUrl: string;
  /** the pinned content sha256 (integrity vs the manifest). */
  sha256: string;
  /** the URL host — the publisher identity (NOT a trust assertion). */
  publisher: string;
}


/** spec 285 — an EXTERNAL system tool the plugin needs but Tachyon does NOT provision: present/missing + the
 *  host-PM assisted-install argv (when offerable) + manual guidance. Informational at install (the plugin installs
 *  regardless); the user triggers the assisted install separately. */
export interface ConsentExternalTool {
  name: string;
  present: boolean;
  /** spec 289 — the candidate binary names when more than one is accepted (audit disclosure: which host binaries
   *  satisfy this one requirement, e.g. google-chrome / chromium); absent for a single-name tool. */
  names?: string[];
  /** spec 289 — the winning trusted path when present. */
  resolvedPath?: string;
  /** the host-PM assisted-install argv (shown shell-quoted for display; run argv-directly in a visible terminal). */
  install?: string[];
  manual: string;
}


/** A colliding MCP server name that needs a Keep/Replace decision. */
export interface ConsentMcpCollision {
  server: string;
  runtime: Runtime;
  /** the decision key the apply echoes in `mcpDecisions` (`${runtime} ${ref}`). */
  key: string;
}


export interface ConsentVM {
  op: ConsentOp;
  pluginName: string;
  /** the version being installed/updated to (or the installed version being removed). */
  version: string;
  /** drawer title, e.g. "Install tdd-guard@1.3.0". */
  title: string;
  /** the confirm button label ("Install" | "Update" | "Force update" | "Remove"). */
  confirmLabel: string;
  /** ① provenance rows (source/commit/integrity) — absent for a local-dir install or a remove. */
  provenance?: ConsentRow[];
  /** spec 276 — the plugin's DIRECT declared dependencies + their install-time state (satisfied/out-of-range/
   *  missing). Surfaced so the human sees an unmet requirement BEFORE confirming. Advisory: never blocks install,
   *  never auto-installs — a plugin author's CLAIM, not a trusted endorsement. */
  requires?: DependencyState[];
  /** ② compatible + skipped runtimes (install/update only). */
  runtimes?: ConsentRuntime[];
  /** ③ permission summary — every shell command that will run on agent events (install/update only). */
  wiredCommands?: ConsentCommand[];
  /** Runtime settings-hooks this package registers. Informational: managed-agent projection is controlled
   * workspace-wide by `settings.agentHookProjection`, never by a per-agent capability grant. */
  settingsHooks?: ConsentSettingsHook[];
  /** ④ file writes preview (install/update only). */
  writes?: ConsentWrite[];
  /** update conflicts (the user edited installed hooks / a new group would duplicate). */
  conflicts?: ConsentConflict[];
  /** ⑤ skills this install/update materializes (per-runtime destinations). */
  skills?: ConsentSkill[];
  /** colliding skill destinations needing a Keep/Replace decision; Replace is destructive (double-confirm). */
  skillCollisions?: ConsentSkillCollision[];
  /** ⑥ MCP servers this plugin ships (Phase C: install records them; they stay inert until apply). */
  mcp?: ConsentMcp[];
  /** colliding MCP server names needing a Keep/Replace decision (records which name apply may overwrite). */
  mcpCollisions?: ConsentMcpCollision[];
  /** true when this plugin ships ANY MCP server → the drawer requires a dedicated acknowledgement
   *  (the servers are not written at install; apply is the act that arms them). */
  requiresMcpConfirm?: boolean;
  /** ⑦ spec 264 — git-hooks this install/update registers (run on EVERY commit, for every actor). */
  gitHooks?: ConsentGitHook[];
  /** true when this install/update registers ANY git-hook → the drawer requires a dedicated acknowledgement
   *  (runs on every commit for the human too, reads staged content, `--no-verify` bypasses it). */
  requiresGitHookConfirm?: boolean;
  /** spec 349 — UI surfaces this install/update registers. */
  views?: ConsentView[];
  /** true when this install/update registers ANY view → dedicated UI acknowledgement. */
  requiresViewConfirm?: boolean;
  /** true when any view reads a curated fleet summary → separate data-scope acknowledgement. */
  requiresFleetReadConfirm?: boolean;
  /** dedicated per-action acknowledgement keys (`<viewId>:<action>`). */
  requiresActionConfirm?: Record<string, string>;
  /** ⑧ spec 265 — tools this install/update will DOWNLOAD + EXECUTE (the highest-trust capability). */
  tools?: ConsentTool[];
  /** true when this install/update provisions ANY tool → the drawer requires a dedicated acknowledgement
   *  (downloads + executes a binary; sha256 proves integrity vs the manifest, not publisher trust). */
  requiresToolConfirm?: boolean;
  /** ⑨ spec 284 — DATA artifacts this install/update will DOWNLOAD + STORE (read-only, never executed). */
  data?: ConsentData[];
  /** true when this install/update provisions ANY data artifact → a dedicated (lighter than tool) acknowledgement
   *  (downloaded + stored, NOT executed; sha256 proves integrity vs the manifest). */
  requiresDataConfirm?: boolean;
  /** ⑩ spec 285 — external system tools the plugin needs (present/missing). Informational: installing the plugin
   *  runs nothing; the user triggers an assisted install (a separate, strongly-acked terminal action) if a tool is missing. */
  externalTools?: ConsentExternalTool[];
  /** true when the new version is LOWER than installed (a force-gated downgrade). */
  isDowngrade?: boolean;
  /** confirm proceeds as a `force` (conflicts and/or downgrade present) — the drawer warns. */
  requiresForce?: boolean;
  /** remove summary: what the uninstall will un-merge/delete — hook groups, skills, MCP servers, git-hooks —
   *  plus the conservative orphans (hook groups / MCP servers you edited) left in place. (The committed payload
   *  + any installer-created empty dirs are always removed too; those aren't counted here.) */
  removeSummary?: { removedCount: number; skillCount: number; mcpCount: number; gitHookCount: number; viewCount?: number; orphans: number };
  /** the consent token the apply must echo (install/update = the InstallPreview fingerprint; remove = name). */
  token: string;
  warnings?: string[];
  /** non-empty ⇒ the operation cannot proceed; the drawer shows the errors and disables confirm. */
  errors?: string[];
}
