import { parse } from "@iarna/toml";
import {
  carryNativeConfigSources,
  nativeConfigAuthorizations,
  GROK_ALWAYS_APPROVE_AUTHORIZATION,
  type GrokScalarNativeConfigFamily,
  type ResolvedAgentNativeConfigProjection,
} from "@tachyon/shared/config/agentNativeConfigPolicy.js";
import type { AgentProfileV1 } from "./agentProfileSchema.js";

/**
 * t-26f508 — the canonical Grok native-configuration projector.
 *
 * ## What it is for
 *
 * Before this, a canonical Grok agent's private `GROK_HOME` held a Bridge-only `config.toml`. That
 * kept the home isolated and made every other native behavior disappear: the person's model, their
 * approval posture, their TUI preferences and their telemetry choice were all silently reset to
 * Grok's built-in defaults. Isolation and behavior parity are independent — that is the lesson the
 * installed Codex rollout paid for (`t-5ca3dd`) — so this projector carries a closed, measured
 * subset of the person's own global configuration into the private home, family by family, and
 * nothing else.
 *
 * ## Why `global` is the only source
 *
 * Measured on Grok 0.2.112 with `grok inspect --json`: a project `.grok/config.toml` loads as a
 * `project` layer and the shipped guide states it contributes only `[mcp_servers]`, `[plugins]` and
 * `[permission]`. Its `[ui]`/`[features]` keys are ignored outright, and in the measurement its
 * `[permission]` block did not reach the effective rule set either (`permissions.loaded` stayed 0).
 * A `workspace` source would therefore be a policy the runtime never honors, so
 * `resolveAgentNativeConfigSupport` refuses it and this file reads one file.
 *
 * The project layer is not thereby harmless — it still injects `[mcp_servers]` — but that is ambient
 * TOOLING, handled fail-closed by the profile inspector, not something a family selects.
 *
 * ## Why the global file is not allowlisted
 *
 * `~/.grok/config.toml` is the person's own file and legitimately carries `[cli]`, `[marketplace]`,
 * `[model.*]` and more. Only the selected keys are read; everything else stays opaque and unauthored
 * rather than blocking activation. This mirrors the Claude projector's `global` arm, and it is the
 * difference between a closed projection and a copy.
 */

type SourceName = "global";

/** The measured Grok build every enum and key path below was read against. */
export const GROK_MEASURED_CLI_VERSION = "grok 0.2.112";

/**
 * Dotted `config.toml` paths per family, in render order.
 *
 * `[ui]` is split across two families on purpose: the keys that decide whether the agent asks before
 * acting belong to Permissions, so excluding that family also drops the approval-prompt defaults,
 * while Interface stays purely about what the TUI looks like.
 */
const FAMILY_KEYS: Record<GrokScalarNativeConfigFamily, readonly string[]> = {
  permissions: [
    "ui.permission_mode",
    "ui.yolo",
    "ui.default_selected_permission",
    "ui.remember_tool_approvals",
    "permission.allow",
    "permission.ask",
    "permission.deny",
  ],
  interface: [
    "ui.simple_mode",
    "ui.vim_mode",
    "ui.screen_mode",
    "ui.max_thoughts_width",
    "ui.compact_mode",
    "ui.show_thinking_blocks",
    "ui.group_tool_verbs",
    "ui.collapsed_edit_blocks",
    "ui.page_flip_on_send",
  ],
  featureFlags: [
    "features.telemetry",
    "features.feedback",
    "features.codebase_indexing",
    "features.two_pass_compaction",
    "features.remote_fetch",
  ],
};

/**
 * t-52964c — keys this projector once carried and deliberately no longer does, each with the reason
 * a person needs to hear when their own global config still sets one.
 *
 * Withdrawing a key is not the same as never having listed it. A profile that selects the family
 * keeps loading and keeps launching, but the key stops reaching the private home — and doing that
 * quietly would rebuild, one layer down, exactly the defect that made this list necessary. So a
 * withdrawn key that is PRESENT in a selected family's source is announced: the value is dropped,
 * the person is told which key and why, and the agent stays launchable. It is a warning and never an
 * error, because inheriting a key is not a mistake the person made.
 *
 * An entry stays for as long as the key can plausibly still sit in someone's `~/.grok/config.toml`.
 * Deleting one early turns the announcement back into silence.
 */
const WITHDRAWN_KEYS: Readonly<
  Record<string, { readonly family: GrokScalarNativeConfigFamily; readonly reason: string }>
> = {
  "features.lsp_tools": {
    family: "featureFlags",
    reason:
      "measured on Grok 0.2.114, the `lsp` tool appears only when this flag is on AND a non-empty LSP"
      + " configuration is merged, and a canonical private home can never hold one — `.grok/lsp.json` is"
      + " ambient Grok input, which the profile inspector refuses outright. Projecting the flag announced"
      + " a capability that could not exist. Code intelligence is being built as a Tachyon capability"
      + " covering every runtime instead (t-4fbbb2)",
  },
};

/** Agent Studio's own family labels, so a refusal names the control the person has to change. */
const FAMILY_LABELS: Record<GrokScalarNativeConfigFamily, string> = {
  permissions: "Permissions",
  interface: "Interface",
  featureFlags: "Feature flags",
};

/**
 * The agent-owned selector paths, written from `runtime.*` rather than read from any file. Grok
 * resolves both from `[models]`; the CLI's `-m`/`--reasoning-effort` would work too, but argv is
 * composed around the brief and the resume id, while `config.toml` is regenerated wholesale on every
 * launch and so cannot drift between fresh, restart and resume.
 */
const SELECTOR_MODEL_KEY = "models.default";
const SELECTOR_EFFORT_KEY = "models.default_reasoning_effort";

/**
 * `--reasoning-effort`'s canonical levels, from the shipped 0.2.112 guide. Per-model menu option ids
 * (`deep`, …) are deliberately refused: they resolve against whatever model is selected, so a value
 * that is valid today becomes invalid the moment the model changes, and the failure would surface as
 * a dead agent rather than as a rejected profile.
 */
const GROK_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * `[ui] permission_mode` values. The first six are the measured `--permission-mode` enum (already
 * recorded by `runtimeProfile.grok`); `always-approve` and `ask` are the additional spellings the
 * shipped configuration guide documents for the config key, and `always-approve` is the one a real
 * `~/.grok/config.toml` in this workspace actually carries.
 */
const GROK_PERMISSION_MODES = new Set([
  "default",
  "acceptEdits",
  "auto",
  "ask",
  "dontAsk",
  "bypassPermissions",
  "plan",
  "always-approve",
]);

/** The two spellings of "stop asking" — one authorization covers both, plus the legacy `yolo` flag. */
const GROK_ALWAYS_APPROVE_MODES = new Set(["always-approve", "bypassPermissions"]);

const GROK_SCREEN_MODES = new Set(["fullscreen", "minimal"]);
const GROK_SELECTED_PERMISSIONS = new Set([
  "always_allow_all_sessions",
  "allow_command_always",
  "allow_once",
  "reject",
]);

const MAX_THOUGHTS_WIDTH_MIN = 20;
const MAX_THOUGHTS_WIDTH_MAX = 500;
/** A permission rule list is a policy, not a payload; a runaway list is a mistake, not a preference. */
const MAX_PERMISSION_RULES = 256;
const MAX_PERMISSION_RULE_LENGTH = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (Array.isArray(value)) return "a list";
  if (value === null) return "null";
  if (isRecord(value)) return "an object";
  return String(value);
}

function valueAt(source: Record<string, unknown>, field: string): unknown {
  return field.split(".").reduce<unknown>((value, key) => (isRecord(value) ? value[key] : undefined), source);
}

/** Why `key` cannot be projected, or undefined when it can. */
function valueRejection(key: string, value: unknown): string | undefined {
  if (key === "ui.permission_mode") {
    return typeof value === "string" && GROK_PERMISSION_MODES.has(value)
      ? undefined
      : `value ${describe(value)} is not projectable (supported: ${[...GROK_PERMISSION_MODES].join(", ")};`
        + ` measured against ${GROK_MEASURED_CLI_VERSION})`;
  }
  if (key === "ui.screen_mode") {
    return typeof value === "string" && GROK_SCREEN_MODES.has(value)
      ? undefined
      : `value ${describe(value)} is not projectable (supported: ${[...GROK_SCREEN_MODES].join(", ")})`;
  }
  if (key === "ui.default_selected_permission") {
    return typeof value === "string" && GROK_SELECTED_PERMISSIONS.has(value)
      ? undefined
      : `value ${describe(value)} is not projectable (supported: ${[...GROK_SELECTED_PERMISSIONS].join(", ")})`;
  }
  if (key === "ui.max_thoughts_width") {
    return Number.isSafeInteger(value)
      && (value as number) >= MAX_THOUGHTS_WIDTH_MIN
      && (value as number) <= MAX_THOUGHTS_WIDTH_MAX
      ? undefined
      : `must be an integer between ${MAX_THOUGHTS_WIDTH_MIN} and ${MAX_THOUGHTS_WIDTH_MAX}, got ${describe(value)}`;
  }
  if (key === "permission.allow" || key === "permission.ask" || key === "permission.deny") {
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
      return `must be a list of strings, got ${describe(value)}`;
    }
    if (value.length > MAX_PERMISSION_RULES) return `must hold at most ${MAX_PERMISSION_RULES} rules`;
    const oversized = value.find((entry) => (entry as string).length > MAX_PERMISSION_RULE_LENGTH);
    if (oversized !== undefined) return `holds a rule longer than ${MAX_PERMISSION_RULE_LENGTH} characters`;
    return undefined;
  }
  return typeof value === "boolean" ? undefined : `must be a boolean, got ${describe(value)}`;
}

/**
 * The dangerous capability a value grants, when it grants one. Named for the capability rather than
 * for the key, so authorizing it cannot be read as authorizing a key's future values.
 */
function dangerousCapability(key: string, value: unknown): string | undefined {
  if (key === "ui.permission_mode" && typeof value === "string" && GROK_ALWAYS_APPROVE_MODES.has(value)) {
    return "the agent never asks before running a tool";
  }
  if (key === "ui.yolo" && value === true) return "the agent never asks before running a tool";
  return undefined;
}

export interface GrokNativeConfigProjectionResult {
  projection: ResolvedAgentNativeConfigProjection;
  errors: string[];
  warnings: string[];
}

/**
 * Project the measured Grok global subset selected by this profile's families.
 *
 * Errors are refusals the person must resolve (a malformed or unmeasured value); warnings are values
 * that were dropped because the agent never authorized the capability behind them. The split matters:
 * an unauthorized `always-approve` inherited from someone's global config must not make their agent
 * unlaunchable, but it must not silently become that agent's posture either.
 */
export function projectGrokNativeConfig(
  profile: Pick<AgentProfileV1, "runtime" | "nativeConfig">,
  sourceTexts: Partial<Record<SourceName, string>>,
  base: ResolvedAgentNativeConfigProjection,
): GrokNativeConfigProjectionResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  // Read from the PROFILE, never from the config file: the global file supplies a value, only this
  // agent's own authorization makes a dangerous one projectable.
  const authorized = nativeConfigAuthorizations(profile.nativeConfig, "permissions");
  const toml: Record<string, unknown> = {};

  if (profile.nativeConfig?.selectors?.source === "agent") {
    if (profile.runtime.provider) {
      errors.push("profile/native-config-selector: Grok provider has no measured canonical materialization");
    }
    if (profile.runtime.serviceTier) {
      errors.push("profile/native-config-selector: Grok serviceTier has no measured canonical materialization");
    }
    if (profile.runtime.model !== undefined) {
      if (profile.runtime.model.trim().length === 0) {
        errors.push("profile/native-config-selector: Grok model must be non-empty");
      } else {
        toml[SELECTOR_MODEL_KEY] = profile.runtime.model;
      }
    }
    if (profile.runtime.reasoningEffort !== undefined) {
      if (!GROK_REASONING_EFFORTS.has(profile.runtime.reasoningEffort)) {
        errors.push(
          `profile/native-config-selector: Grok reasoningEffort '${profile.runtime.reasoningEffort}' is unsupported;`
          + ` expected ${[...GROK_REASONING_EFFORTS].join(", ")}`,
        );
      } else {
        toml[SELECTOR_EFFORT_KEY] = profile.runtime.reasoningEffort;
      }
    }
  }

  const selected = (Object.keys(FAMILY_KEYS) as GrokScalarNativeConfigFamily[])
    .filter((family) => profile.nativeConfig?.[family]?.source === "global");
  if (selected.length > 0) {
    let parsed: unknown = {};
    const sourceText = sourceTexts.global;
    let readable = true;
    try {
      parsed = sourceText?.trim() ? parse(sourceText) : {};
    } catch (error) {
      errors.push(
        `profile/native-config-source: Grok global config is invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
      );
      readable = false;
    }
    if (readable && !isRecord(parsed)) {
      errors.push("profile/native-config-source: Grok global config must be a TOML table");
      readable = false;
    }
    if (readable) {
      for (const [key, withdrawn] of Object.entries(WITHDRAWN_KEYS)) {
        if (!selected.includes(withdrawn.family)) continue;
        if (valueAt(parsed as Record<string, unknown>, key) === undefined) continue;
        warnings.push(
          `profile/native-config-value: Grok global key '${key}' is no longer projected into this agent's`
          + ` private home: ${withdrawn.reason}`
          + `; your own global config is untouched and the key still applies to Grok run outside Tachyon`,
        );
      }
      for (const family of selected) {
        for (const key of FAMILY_KEYS[family]) {
          const value = valueAt(parsed as Record<string, unknown>, key);
          if (value === undefined) continue;
          const rejection = valueRejection(key, value);
          if (rejection) {
            // Name the offending key and the way out: the refusal is intentional fail-closed, so the
            // person needs to know which family to exclude rather than reading "unsupported value".
            errors.push(
              `profile/native-config-value: Grok global key '${key}' ${rejection}`
              + `; set the ${FAMILY_LABELS[family]} family to Exclude or change the global value`,
            );
            continue;
          }
          const dangerous = dangerousCapability(key, value);
          if (dangerous && !authorized.has(GROK_ALWAYS_APPROVE_AUTHORIZATION)) {
            // Omit the capability, keep the agent loadable, and say exactly how to opt in. An
            // inherited value is never consent on its own.
            warnings.push(
              `profile/native-config-value: Grok global key '${key}' value ${describe(value)} means ${dangerous};`
              + ` it was omitted because this agent does not explicitly authorize it`
              + `; authorize it for this agent, set the ${FAMILY_LABELS[family]} family to Exclude,`
              + ` or change the global value`,
            );
            continue;
          }
          toml[key] = structuredClone(value);
        }
      }
    }
  }

  return {
    // The spread drops the non-enumerable ownership metadata, so carry it across (t-59a11b).
    projection: Object.keys(toml).length > 0 ? carryNativeConfigSources({ ...base, toml }, base) : base,
    errors,
    warnings,
  };
}

/**
 * The render order the materializer uses. Exported so the private-home writer and this projector
 * cannot disagree about which paths exist or where they land, and so a new key has exactly one place
 * to be added.
 */
export const GROK_PROJECTED_KEY_ORDER: readonly string[] = [
  SELECTOR_MODEL_KEY,
  SELECTOR_EFFORT_KEY,
  ...FAMILY_KEYS.permissions,
  ...FAMILY_KEYS.interface,
  ...FAMILY_KEYS.featureFlags,
];

export { FAMILY_KEYS as GROK_NATIVE_CONFIG_FAMILY_KEYS, WITHDRAWN_KEYS as GROK_WITHDRAWN_NATIVE_CONFIG_KEYS };
