/**
 * t-283149 — what Tachyon actually handed the runtime, as a projection a person can read.
 *
 * Tachyon injects CODE into someone's runtime: lifecycle hooks that run commands, a status-line
 * wrapper, MCP wiring, minted environment. Until this module there was no surface that showed any of
 * it. The one time a human asked the runtime itself — Claude's `/hooks` — it answered "No hooks
 * configured for this event" while four were running and writing files.
 *
 * The module is PURE on purpose. Reading `/proc`, settings files and the ledger is the caller's job;
 * everything here is a total function over what the caller found. That keeps the two decisions that
 * actually matter — what counts as a secret, and where a settings key came from — testable without a
 * live agent, and it is why redaction can be asserted rather than hoped for.
 */

/** A secret is decided by KEY, never by shape of value. See `isSecretEnvKey`. */
export const REDACTED = "•••" as const;

export type SettingsOrigin =
  /** Projected from the person's global runtime config, because the profile's family allowlist carries it. */
  | "projected"
  /** Present in the person's global config and NOT projectable — it never reaches the agent. */
  | "not-projected"
  /** Owned by the agent profile itself (selectors, and anything the profile authors directly). */
  | "agent-owned"
  /** Injected by Tachyon: lifecycle hooks, dangerous-mode consent, observability. */
  | "host";

export interface InspectedSetting {
  key: string;
  /** Rendered value. Objects are summarized by the caller; secrets never reach here unredacted. */
  value: string;
  origin: SettingsOrigin;
  /** Present when the host wrapped a value the person authored, rather than replacing it. */
  wraps?: string;
}

export interface InspectedHook {
  event: string;
  command: string;
  /** One line: what this hook is FOR. Absent when Tachyon did not author it. */
  purpose?: string;
  /** The file it writes, when the hook is one Tachyon injected and we know its sink. */
  writes?: string;
}

export interface InspectedSession {
  agent: string;
  runtime: string;
  /** `live` when a process was found; `last-known` when the projection came from files alone. */
  state: "live" | "last-known";
  /** The launch argv, secrets already redacted. Empty when no process was found. */
  command: readonly string[];
  hooks: readonly InspectedHook[];
  settings: readonly InspectedSetting[];
  mcpServers: readonly string[];
  /** True when the runtime was told to ignore ambient MCP config. */
  strictMcp: boolean;
  env: readonly { key: string; value: string }[];
  /** Things this runtime does not expose. Stated, never silently omitted — parity.md's rule. */
  notExposed: readonly string[];
}

/**
 * Secrets are decided by KEY, matching what AgentManager already treats as a secret when redacting
 * captured pane output (spec 351): any key containing TOKEN. Value-shape heuristics are deliberately
 * avoided — they miss a secret that does not look like one, and that failure is silent.
 */
export function isSecretEnvKey(key: string): boolean {
  return key.toUpperCase().includes("TOKEN") || key.toUpperCase().includes("SECRET");
}

/** Env worth showing: what Tachyon minted, plus the runtime's config home. Everything else is noise. */
export function inspectEnv(
  env: Readonly<Record<string, string>>,
  extraKeys: readonly string[] = [],
): { key: string; value: string }[] {
  const interesting = Object.keys(env)
    .filter((key) => key.startsWith("TACHYON_") || extraKeys.includes(key))
    .sort();
  return interesting.map((key) => ({
    key,
    value: isSecretEnvKey(key) ? REDACTED : env[key] ?? "",
  }));
}

/**
 * Redact secrets from an argv. A token can reach the command line as `--flag=<secret>` or as its own
 * argument, so the previous token is consulted; matching on the VALUE would need us to recognize a
 * secret by shape, which is the thing `isSecretEnvKey` exists to avoid.
 */
export function redactCommand(argv: readonly string[], secrets: readonly string[]): string[] {
  const real = secrets.filter((secret) => secret.length >= 8);
  return argv.map((arg) => {
    let out = arg;
    for (const secret of real) out = out.split(secret).join(REDACTED);
    return out;
  });
}

/**
 * t-a5d827 — replace the VALUE of a session-identity flag, not the flag itself.
 *
 * Grok's live argv is `grok -s <uuid> …`; Claude/Codex use `--resume <id>`. The panel must show that
 * a session was resumed or continued, never the identifier. Matching on value shape (UUID regex) is
 * deliberately avoided: a secret that does not look like a UUID would slip through, and a path that
 * happens to look like one would be destroyed. The previous token is the authority, same as tokens.
 */
const SESSION_IDENTITY_FLAGS = new Set(["-s", "--session", "--resume"]);

export function redactSessionArguments(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (SESSION_IDENTITY_FLAGS.has(arg) && index + 1 < argv.length && !argv[index + 1]!.startsWith("-")) {
      out.push(arg, "[session id — not shown]");
      index++;
      continue;
    }
    let replaced = arg;
    for (const flag of ["--resume=", "--session="]) {
      if (replaced.startsWith(flag) && replaced.length > flag.length) {
        replaced = `${flag}[session id — not shown]`;
        break;
      }
    }
    out.push(replaced);
  }
  return out;
}

/**
 * t-a5d827 — a settings value under an auth/token/secret key is presence, not content.
 *
 * Env-style refs (`${TACHYON_AGENT_BRIDGE_TOKEN}`) stay visible: they are the mechanism, not a secret.
 * Boolean and the panel's own presence prose pass through. Everything else under a sensitive key is
 * redacted so a leaked credential in a projected header never reaches the webview.
 */
export function isSensitiveSettingKey(key: string): boolean {
  // `headers.` catches any MCP header cell (Authorization, and anything else a server might mint).
  // Matching on value shape is avoided — a secret that does not look like one would slip through.
  return /token|secret|password|authorization|credentials|auth\.json|headers\./i.test(key);
}

export function redactSettingValue(key: string, rendered: string): string {
  if (!isSensitiveSettingKey(key)) return rendered;
  // auth.json rows are host-authored presence claims the Grok reader already phrased safely.
  if (key === "auth.json") return rendered;
  if (rendered.includes("${")) return rendered;
  if (rendered === "true" || rendered === "false" || rendered === "null" || rendered === "") return rendered;
  if (rendered.startsWith("private reconciled copy")) return rendered;
  return REDACTED;
}

/**
 * An argv entry this long WITH line breaks is prose, not a flag or a path. Both bounds matter: a long
 * path has no newlines, and a short multi-line value is not a brief.
 */
const PROSE_ARGUMENT_MIN_LENGTH = 400;

export function isProseArgument(arg: string): boolean {
  return arg.length >= PROSE_ARGUMENT_MIN_LENGTH && arg.includes("\n");
}

/**
 * Fold the opening brief out of a launch command so the flags stay readable.
 *
 * Both Claude and Codex take the primer + brief summary as a POSITIONAL argument — measured, ~7.9 KB
 * on a fresh start. Printed verbatim it buries `--settings`, `--model` and `--strict-mcp-config`
 * under a wall of prose, which are exactly what a person opens this panel to read. That failure has
 * the same shape as the one the panel exists to end: everything is present and nobody can read it.
 *
 * The text is not lost — it is already on disk under `.tachyon/briefs/spawn/<agent>.md`, and the
 * pane shows it. What is summarized is SAID to be summarized, never silently dropped.
 */
export function foldProseArguments(argv: readonly string[]): { command: string[]; folded: number } {
  let folded = 0;
  const command = argv.map((arg) => {
    if (!isProseArgument(arg)) return arg;
    folded++;
    // TextEncoder, not Buffer: this module is pure domain and the webview imports its types.
    const bytes = new TextEncoder().encode(arg).length;
    return `[opening brief — ${bytes} bytes, ${arg.split("\n").length} lines, not shown here]`;
  });
  return { command, folded };
}

/**
 * Where a settings key stands, given what the profile projects and what the host injects.
 *
 * The `not-projected` case is the one worth the whole function. A key sitting in the person's global
 * config that the family allowlist does not carry NEVER reaches the agent — no error, no warning, it
 * simply does not act. That is exactly how t-084b28 survived three releases: the key was there, it
 * looked right, and it was inert.
 */
export function classifySetting(
  key: string,
  where: { projectable: readonly string[]; hostInjected: readonly string[]; agentOwned: readonly string[] },
  presentInGlobal: boolean,
): SettingsOrigin {
  if (where.hostInjected.includes(key)) return "host";
  if (where.agentOwned.includes(key)) return "agent-owned";
  if (where.projectable.includes(key)) return "projected";
  return presentInGlobal ? "not-projected" : "host";
}

/**
 * A status line present in BOTH the projected settings and the host layer is not a conflict, and must
 * not be rendered as two competing rows: the host wrapper carries the person's own command as
 * `priorCommand` and runs it inside itself, so the person still sees their status line while Tachyon
 * reads quota windows. Showing two rows would be a lie about what happens.
 */
export function foldWrappedStatusLine(
  settings: readonly InspectedSetting[],
  priorCommand: string | undefined,
): InspectedSetting[] {
  if (!priorCommand) return [...settings];
  const hostIndex = settings.findIndex((setting) => setting.key === "statusLine" && setting.origin === "host");
  if (hostIndex < 0) return [...settings];
  const folded = settings.filter((setting) => !(setting.key === "statusLine" && setting.origin !== "host"));
  return folded.map((setting) =>
    setting.key === "statusLine" && setting.origin === "host"
      ? { ...setting, wraps: priorCommand }
      : setting,
  );
}

/**
 * What each Tachyon-authored hook is for, keyed by the recorder script it runs. A hook we did not
 * author gets no purpose line rather than an invented one — the person's own hooks are theirs, and
 * describing them would be guessing.
 */
const HOOK_PURPOSE: ReadonlyArray<{ match: string; purpose: string; writes: string }> = [
  { match: "session-owner-record", purpose: "records which agent owns this session", writes: ".tachyon/activity/session-owners.jsonl" },
  { match: "handoff-pointer", purpose: "points the agent at the shared project handoff", writes: "(reads .tachyon/HANDOFF.md)" },
  { match: "continuity-pointer", purpose: "points the agent at its own continuity brief", writes: "(reads .tachyon/continuity/<agent>.md)" },
  { match: "persistence-stop-record", purpose: "marks the end of each turn", writes: ".tachyon/activity/persistence-stop.jsonl" },
];

export function describeHook(event: string, command: string): InspectedHook {
  const known = HOOK_PURPOSE.find((entry) => command.includes(entry.match));
  return known
    ? { event, command, purpose: known.purpose, writes: known.writes }
    : { event, command };
}

/**
 * t-0c963d — pull hooks out of the nested `{ Event: [{ matcher, hooks: [{ command }] }] }` shape.
 *
 * This lives in the pure layer because the SHAPE is shared even though the source is not: Claude
 * keeps it in a JSON settings file, Codex passes it as a TOML fragment on the argv, and both parse
 * into exactly this structure. Measured on a live Codex session — the four hooks come out identical
 * to Claude's. Duplicating the walk per reader would be the two-path defect on a fact about data.
 */
export function hooksFromConfig(config: Record<string, unknown> | undefined): InspectedHook[] {
  const hooks = config?.hooks;
  if (!hooks || typeof hooks !== "object") return [];
  const out: InspectedHook[] = [];
  for (const [event, matchers] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const matcher of matchers) {
      const inner = (matcher as { hooks?: unknown })?.hooks;
      if (!Array.isArray(inner)) continue;
      for (const entry of inner) {
        const command = (entry as { command?: unknown })?.command;
        if (typeof command === "string") out.push(describeHook(event, command));
      }
    }
  }
  return out;
}

/**
 * Flatten a nested config into dotted paths, because that is how a runtime's allowlist names its
 * keys: Codex's family list carries `tui.status_line`, not `tui`. Without this every nested key would
 * classify as "not delivered to this agent" — the single most misleading row this panel can show.
 *
 * Arrays and empty tables are leaves: `tui.status_line` is a list of widgets, and descending into it
 * would produce `tui.status_line.0` rows that mean nothing to anyone.
 */
export function flattenConfig(
  value: Record<string, unknown>,
  prefix = "",
): Array<{ key: string; value: unknown }> {
  const out: Array<{ key: string; value: unknown }> = [];
  for (const [key, inner] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const nested = inner && typeof inner === "object" && !Array.isArray(inner)
      ? inner as Record<string, unknown>
      : undefined;
    if (nested && Object.keys(nested).length > 0) out.push(...flattenConfig(nested, path));
    else out.push({ key: path, value: inner });
  }
  return out;
}
