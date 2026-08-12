/**
 * spec 254 — the MCP config FORMAT CODEC: read / render / merge / remove / compare an MCP server in a runtime's
 * native config, runtime-generic (dispatch to the per-runtime adapter renderers). Extracted from `engine.ts`
 * so the on-disk MCP format knowledge lives in one place; the engine keeps the *planning* (which servers ×
 * which runtimes) + the lockfile-target *validators* (which need the adapter registry).
 *
 * Fail-closed: a present-but-broken config is an ERROR, never silently "server absent" (which would let a merge
 * clobber it). Content-aware: `currentMcp` exposes the on-disk entry so the engine leaves a user-edited server
 * as an orphan instead of overwriting it.
 */

import fs from "node:fs";
import path from "node:path";
import type { Runtime } from "./manifest.js";
import type { McpServer } from "./mcp.js";
import { renderClaudeMcpEntry } from "./adapters/claude.js";
import { renderCodexMcpBlock } from "./adapters/codex.js";
import { setClaudeMcpServer, removeClaudeMcpServer, getClaudeMcpServer, setCodexMcpServer, removeCodexMcpServer, getCodexMcpServerBlock } from "../registration/adapters.js";
import { readFile, atomicWrite } from "./fsx.js";

/** A valid MCP server name (kebab) — also the lockfile `ref` and the config key. Mirrors mcp.ts SERVER_NAME_RE. */
export const MCP_SERVER_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Read a runtime's MCP config FAIL-CLOSED (mirrors readSettings): absent → undefined; unreadable, or (for
 *  claude) not valid JSON-object → ERROR. Never treats a broken/present config as "server absent" (which would
 *  let a merge clobber it or throw uncaught). */
export function readMcpConfig(workspaceRoot: string, runtime: Runtime, rel: string): { text?: string; error?: string } {
  const rd = readFile(path.join(workspaceRoot, rel));
  if (rd.error) return { error: `${rel}: ${rd.error}` };
  if (rd.missing) return {};
  if (runtime === "claude") {
    try {
      const p: unknown = JSON.parse(rd.text as string);
      if (typeof p !== "object" || p === null || Array.isArray(p)) return { error: `${rel}: not a JSON object — refusing to overwrite` };
    } catch {
      return { error: `${rel}: invalid JSON — refusing to overwrite a broken config file` };
    }
  }
  return { text: rd.text };
}

/** The rendered representation of a server for `runtime` — the merged config entry AND the lockfile removal
 *  identity (claude: the `mcpServers.<name>` object; codex: the `[mcp_servers.<name>]` block text).
 *  `pluginRoot` is the absolute materialized payload root; required when command/args use `${PLUGIN_ROOT}`. */
export function renderMcp(runtime: Runtime, server: McpServer, pluginRoot?: string): unknown {
  if (runtime === "claude") return renderClaudeMcpEntry(server, pluginRoot);
  if (runtime === "codex") return renderCodexMcpBlock(server, pluginRoot);
  // grok has no project MCP install path (engine ADAPTERS.grok.mcpRel is null); never invent a codex shape.
  throw new Error(`renderMcp: runtime '${runtime}' has no plugin MCP codec`);
}

/** Merge a server into the runtime's MCP config text (render + place by name). */
export function setMcpServer(runtime: Runtime, configText: string | undefined, server: McpServer, pluginRoot?: string): string {
  if (runtime === "claude") return setClaudeMcpServer(configText, server.name, renderClaudeMcpEntry(server, pluginRoot));
  if (runtime === "codex") return setCodexMcpServer(configText, server.name, renderCodexMcpBlock(server, pluginRoot));
  throw new Error(`setMcpServer: runtime '${runtime}' has no plugin MCP codec`);
}

/** Write an already-rendered lockfile `removal` back into the runtime config (apply uses the same bytes unapply will match). */
export function setMcpFromRemoval(runtime: Runtime, configText: string | undefined, name: string, removal: unknown): string {
  if (runtime === "claude") {
    if (typeof removal !== "object" || removal === null || Array.isArray(removal)) {
      throw new Error(`setMcpFromRemoval: claude removal for '${name}' is not an object`);
    }
    return setClaudeMcpServer(configText, name, removal as Record<string, unknown>);
  }
  if (runtime === "codex") {
    if (typeof removal !== "string") throw new Error(`setMcpFromRemoval: codex removal for '${name}' is not a block string`);
    return setCodexMcpServer(configText, name, removal);
  }
  throw new Error(`setMcpFromRemoval: runtime '${runtime}' has no plugin MCP codec`);
}

/** Remove a server by name from the runtime's MCP config text. */
export function removeMcpServerText(runtime: Runtime, configText: string | undefined, name: string): string {
  if (runtime === "claude") return removeClaudeMcpServer(configText, name);
  if (runtime === "codex") return removeCodexMcpServer(configText, name);
  throw new Error(`removeMcpServerText: runtime '${runtime}' has no plugin MCP codec`);
}

/** The current on-disk representation of server `name` (for content-aware removal: an edited server ≠ what we
 *  recorded → leave it as an orphan, never clobber a user's edit). */
export function currentMcp(runtime: Runtime, configText: string | undefined, name: string): unknown {
  if (runtime === "claude") return getClaudeMcpServer(configText, name);
  if (runtime === "codex") return getCodexMcpServerBlock(configText, name);
  throw new Error(`currentMcp: runtime '${runtime}' has no plugin MCP codec`);
}

/** Compare two rendered MCP representations (claude entry object / codex block string) structurally. */
export function mcpRepEquals(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Persist a runtime's MCP config text, deleting the file when it reduces to empty / `{}` (no Tachyon-only husk). */
export function writeMcpConfig(file: string, text: string): void {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed === "{}") fs.rmSync(file, { force: true });
  else atomicWrite(file, text);
}
