/**
 * spec 265 task 10a — the `${tool:<name>}` placeholder parser (task-0 H3, codex task-10 review B).
 *
 * A git-hook ARGV-vector leaf may reference a tool this plugin provisions via `${tool:<name>}`, allowed ONLY:
 *  - in the argv-vector leaf form (never a shell-string/script leaf),
 *  - as a WHOLE argv token (never a substring — no shell to smuggle into),
 *  - naming a tool in THIS plugin's provisioned set (no cross-plugin references in v1, codex B).
 *
 * It resolves at materialization to a PLUGIN-SCOPED launcher invocation — three argv tokens:
 *   <absolute _tachyon-tool path> <pluginName> <toolName>
 * so the launcher re-validates that plugin's pinned binary before exec, path-independently.
 *
 * INERT in 10a: this is the pure parser/validator; the engine wires it into leaf materialization in 10c.
 */

/** `${tool:<kebab-name>}` as a WHOLE token. */
const WHOLE_PLACEHOLDER_RE = /^\$\{tool:([a-z][a-z0-9]*(?:-[a-z0-9]+)*)\}$/;
/** any `${tool:` occurrence (to catch substring/malformed uses). */
const CONTAINS_PLACEHOLDER_RE = /\$\{tool:/;

export interface PlaceholderOpts {
  pluginName: string;
  /** the tool names this plugin provisions (resolvable for this host). */
  provisionedTools: ReadonlySet<string>;
  /** the absolute path of the workspace's `_tachyon-tool` launcher shim. */
  launcherPath: string;
}

export type PlaceholderResult = { argv: string[] } | { error: string };

/** Resolve `${tool:...}` placeholders in an argv vector. Fail-closed on a substring use, an unknown/unprovisioned
 *  tool, or a malformed token. Returns the expanded argv, or a single error. */
export function resolveToolPlaceholders(argv: string[], opts: PlaceholderOpts): PlaceholderResult {
  const out: string[] = [];
  for (const tok of argv) {
    const m = WHOLE_PLACEHOLDER_RE.exec(tok);
    if (m) {
      const name = m[1];
      if (!opts.provisionedTools.has(name)) {
        return { error: `git-hook references \${tool:${name}} but plugin '${opts.pluginName}' provisions no tool '${name}' for this host` };
      }
      out.push(opts.launcherPath, opts.pluginName, name);
      continue;
    }
    if (CONTAINS_PLACEHOLDER_RE.test(tok)) {
      return { error: `\${tool:...} must be a WHOLE argv token (no substring/concatenation): '${tok}'` };
    }
    out.push(tok);
  }
  return { argv: out };
}

/** True when a value contains a `${tool:...}` reference — used to REJECT a placeholder in a non-argv (script)
 *  leaf, where there is no safe whole-token substitution. */
export function containsToolPlaceholder(text: string): boolean {
  return CONTAINS_PLACEHOLDER_RE.test(text);
}
