/**
 * spec 250 Step 4 — the codex runtime adapter. codex's hook config lives in `.codex/hooks.json` (the whole
 * file is the hooks container). The structure is the SAME as claude's hooks map, so the merge/un-merge logic
 * is the shared core (`./hooks.ts`); codex differs only in (a) its config file, (b) accepting a `statusMessage`
 * on a hook command, and (c) its matchers keying off codex tool names (e.g. `^apply_patch$` rather than `Edit`)
 * — but matchers are opaque strings to the engine, so that difference is the plugin author's, not Tachyon's.
 */

import { parseHooksBlock, type BlockParseResult } from "./hooks.js";
import type { McpServer } from "../mcp.js";

/** Codex hook events accepted in a plugin block. Verified against a live codex hook config (which uses
 *  SubagentStart/SubagentStop), so those ARE included; only `PostToolUseFailure` (a claude-only event) is
 *  excluded. Unknown keys fail closed. */
export const CODEX_HOOK_EVENTS: ReadonlySet<string> = new Set([
  "PreToolUse", "PostToolUse", "Notification", "UserPromptSubmit",
  "SessionStart", "SessionEnd", "Stop", "SubagentStart", "SubagentStop", "PreCompact", "PostCompact",
]);

/** Parse a plugin's `codex/hooks.json` (the inner event→groups map). codex commands MAY carry statusMessage. */
export function parseCodexHooksBlock(rawJson: string): BlockParseResult {
  return parseHooksBlock(rawJson, { knownEvents: CODEX_HOOK_EVENTS, allowStatusMessage: true, label: "codex" });
}

// ── spec 254 Step 2 — render a neutral MCP server to a codex `[mcp_servers.<name>]` TOML block ─────────────

/** Encode a string as a TOML basic string (quoted, with `\`/`"`/control escapes). The neutral schema already
 *  bars controls in command/url and bars quotes in env/header `${VAR}` refs, but a literal `arg` may contain
 *  any of them — so this is the real injection guard (codex review D6), not just defense-in-depth. */
function tomlStr(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else if (c < 0x20 || c === 0x7f) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return out + '"';
}

/** The single `${VAR}` name inside a header value (`${VAR}` or `Bearer ${VAR}`). */
function headerEnvVar(value: string): string {
  const m = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(value);
  return m ? m[1] : "";
}

/**
 * Render ONE neutral MCP server to its codex `.codex/config.toml` `[mcp_servers.<name>]` block (header +
 * body lines, newline-terminated). The server NAME is a validated kebab token → a safe TOML bare key. Values
 * are TOML-escaped. http auth maps to codex's structured fields (no free-form header string): an
 * `Authorization: Bearer ${VAR}` → `bearer_token_env_var`; every other header (incl. a bare-token
 * Authorization) → an `env_http_headers` inline table (header name → env-var name). Pure; the merge into the
 * file (Step 3) replaces only this block.
 */
export function renderCodexMcpBlock(server: McpServer): string {
  const lines = [`[mcp_servers.${server.name}]`];
  if (server.transport === "stdio") {
    lines.push(`command = ${tomlStr(server.command)}`);
    if (server.args.length > 0) lines.push(`args = [${server.args.map(tomlStr).join(", ")}]`);
    // codex does NOT expand `${VAR}` in `env` (that sets concrete values); its indirection is `env_vars`,
    // which forwards the named vars from codex's environment. The neutral schema guarantees each env key ==
    // its referenced var (mcp.ts), so the var names ARE the keys.
    const envKeys = Object.keys(server.env);
    if (envKeys.length > 0) lines.push(`env_vars = [${envKeys.map(tomlStr).join(", ")}]`);
  } else {
    lines.push(`url = ${tomlStr(server.url)}`);
    const envHeaders: string[] = [];
    for (const [name, value] of Object.entries(server.headers)) {
      const v = headerEnvVar(value);
      if (name.toLowerCase() === "authorization" && /^bearer /i.test(value)) {
        lines.push(`bearer_token_env_var = ${tomlStr(v)}`);
      } else {
        envHeaders.push(`${tomlStr(name)} = ${tomlStr(v)}`);
      }
    }
    if (envHeaders.length > 0) lines.push(`env_http_headers = { ${envHeaders.join(", ")} }`);
  }
  return lines.join("\n") + "\n";
}
