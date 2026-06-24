/**
 * Per-runtime MCP registration adapters. Pure snippet/JSON builders — file IO and
 * user confirmation live in the extension command.
 *
 * Runtime client support for streamable-HTTP MCP moves fast; verify against each
 * runtime's official docs when bumping these shapes. Clients that only speak stdio
 * can proxy with `npx mcp-remote <url>` (documented in README).
 */

export type RuntimeId = "claude-code" | "codex" | "opencode" | "generic";

export interface RegistrationOffer {
  runtime: RuntimeId;
  title: string;
  /** Workspace-relative file the snippet belongs in; undefined = nothing to write (copy/paste flow). */
  file?: string;
  /** Full new file content when we can merge mechanically; undefined = manual snippet. */
  content?: string;
  /** True when the existing file already carries the exact entry — connect becomes a no-op. */
  upToDate?: boolean;
  snippet: string;
  notes: string;
}

function entryMatches(existing: string | undefined, pick: (root: Record<string, unknown>) => unknown, expected: Record<string, unknown>): boolean {
  if (existing === undefined || existing.trim().length === 0) return false;
  try {
    const parsed: unknown = JSON.parse(existing);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const entry = pick(parsed as Record<string, unknown>);
    return JSON.stringify(entry) === JSON.stringify(expected);
  } catch {
    return false;
  }
}

/** Escape a string for safe interpolation into a RegExp (server names are kebab-validated, so this is
 *  defense-in-depth for the generic writer). */
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** True when `.mcp.json` registers `name` with EXACTLY `entry`. Generic over the server (spec 254 — the
 *  Bridge passes "tachyon"; the plugin engine passes a plugin server). */
export function claudeMcpServerMatches(existing: string | undefined, name: string, entry: Record<string, unknown>): boolean {
  return entryMatches(existing, (root) => (root.mcpServers as Record<string, unknown> | undefined)?.[name], entry);
}

/** The entry currently registered under `mcpServers.<name>` in `.mcp.json` (own key only), or undefined. */
export function getClaudeMcpServer(existing: string | undefined, name: string): unknown {
  if (existing === undefined || existing.trim().length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const servers = (parsed as Record<string, unknown>).mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) return undefined;
  return Object.hasOwn(servers as Record<string, unknown>, name) ? (servers as Record<string, unknown>)[name] : undefined;
}

/** True when `.mcp.json` registers a server named `name` (own key), regardless of its value. */
export function claudeMcpServerPresent(existing: string | undefined, name: string): boolean {
  return getClaudeMcpServer(existing, name) !== undefined;
}

/** True when `.mcp.json` already registers this exact Bridge URL (+auth header when required). */
export function claudeAlreadyRegistered(existing: string | undefined, url: string, auth = false): boolean {
  return claudeMcpServerMatches(existing, "tachyon", expectedClaudeEntry(url, auth));
}

/** True when `opencode.json` already registers this exact Bridge URL (+auth header when required). */
export function opencodeAlreadyRegistered(existing: string | undefined, url: string, auth = false): boolean {
  return entryMatches(
    existing,
    (root) => (root.mcp as Record<string, unknown> | undefined)?.tachyon,
    expectedOpencodeEntry(url, auth),
  );
}

export const TOKEN_ENV_REF_CLAUDE = "Bearer ${TACHYON_BRIDGE_TOKEN}";
export const TOKEN_ENV_REF_OPENCODE = "Bearer {env:TACHYON_BRIDGE_TOKEN}";

/** The exact entry a correct Claude Code registration carries. */
export function expectedClaudeEntry(url: string, auth: boolean): Record<string, unknown> {
  return auth ? { type: "http", url, headers: { Authorization: TOKEN_ENV_REF_CLAUDE } } : { type: "http", url };
}

/** The exact entry a correct OpenCode registration carries. */
export function expectedOpencodeEntry(url: string, auth: boolean): Record<string, unknown> {
  return auth
    ? { type: "remote", url, enabled: true, headers: { Authorization: TOKEN_ENV_REF_OPENCODE } }
    : { type: "remote", url, enabled: true };
}

/** Parse an existing `.mcp.json` root; `{}` when absent/empty; throws when present-but-not-an-object. */
function parseClaudeRoot(existing: string | undefined): Record<string, unknown> {
  if (existing === undefined || existing.trim().length === 0) return {};
  const parsed: unknown = JSON.parse(existing);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(".mcp.json exists but is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function claudeServersOf(root: Record<string, unknown>): Record<string, unknown> {
  return typeof root.mcpServers === "object" && root.mcpServers !== null && !Array.isArray(root.mcpServers)
    ? (root.mcpServers as Record<string, unknown>)
    : {};
}

/** Merge one MCP server `name`→`entry` into a (possibly existing) `.mcp.json`, preserving every other key
 *  and server. Generic over the server (spec 254). Throws on unparseable/non-object existing content. */
export function setClaudeMcpServer(existing: string | undefined, name: string, entry: Record<string, unknown>): string {
  const root = parseClaudeRoot(existing);
  const servers = claudeServersOf(root);
  servers[name] = entry;
  root.mcpServers = servers;
  return `${JSON.stringify(root, null, 2)}\n`;
}

/** Remove one MCP server `name` from `.mcp.json`, preserving everything else; drops an emptied `mcpServers`.
 *  Returns the original text unchanged when `name` is absent (byte-stable no-op). */
export function removeClaudeMcpServer(existing: string | undefined, name: string): string {
  const root = parseClaudeRoot(existing);
  const servers = claudeServersOf(root);
  // Object.hasOwn (NOT `name in`): a name like `constructor` is a valid kebab server name but lives on
  // Object.prototype, so `in` would falsely report it present and break the byte-stable absent no-op.
  if (!Object.hasOwn(servers, name)) return existing ?? "";
  delete servers[name];
  if (Object.keys(servers).length > 0) root.mcpServers = servers;
  else delete root.mcpServers;
  return `${JSON.stringify(root, null, 2)}\n`;
}

/** Merge the Bridge into a (possibly existing) Claude Code `.mcp.json`. Throws on unparseable existing content. */
export function buildClaudeMcpJson(existing: string | undefined, url: string, auth = false): string {
  return setClaudeMcpServer(existing, "tachyon", expectedClaudeEntry(url, auth));
}

/** Merge the Bridge into a (possibly existing) `opencode.json`. */
export function buildOpencodeJson(existing: string | undefined, url: string, auth = false): string {
  let root: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim().length > 0) {
    const parsed: unknown = JSON.parse(existing);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("opencode.json exists but is not a JSON object");
    }
    root = parsed as Record<string, unknown>;
  }
  if (root.$schema === undefined) root.$schema = "https://opencode.ai/config.json";
  const mcp =
    typeof root.mcp === "object" && root.mcp !== null && !Array.isArray(root.mcp)
      ? (root.mcp as Record<string, unknown>)
      : {};
  mcp.tachyon = expectedOpencodeEntry(url, auth);
  root.mcp = mcp;
  return `${JSON.stringify(root, null, 2)}\n`;
}

/** The `[mcp_servers.tachyon]` TOML block (HTTP/streamable server with optional bearer env var). */
function codexTachyonBlock(url: string, auth: boolean): string {
  const lines = ["[mcp_servers.tachyon]", `url = "${url}"`];
  if (auth) lines.push('bearer_token_env_var = "TACHYON_BRIDGE_TOKEN"');
  return lines.join("\n") + "\n";
}

/** Extract the `[mcp_servers.<name>]` block range (header → next table header / EOF). null if absent. Generic
 *  over the server name (spec 254). */
function codexMcpServerRange(text: string, name: string): { start: number; end: number } | null {
  const lines = text.split("\n");
  const headerRe = new RegExp(`^\\s*\\[mcp_servers\\.${escapeRegex(name)}\\]\\s*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return { start, end };
}

/**
 * Merge a codex `[mcp_servers.<name>]` block (the FULL block text incl. its header line) into config.toml —
 * replacing an existing same-name block in place (preserving every other line, comment, and table) or
 * appending with a separating blank line. The caller builds the block (the Bridge: url+bearer; the plugin
 * engine: renderCodexMcpBlock, which TOML-escapes its values). Generic over the server name (spec 254).
 */
export function setCodexMcpServer(existing: string | undefined, name: string, block: string): string {
  if (existing === undefined || existing.trim().length === 0) return block;
  const range = codexMcpServerRange(existing, name);
  const lines = existing.split("\n");
  if (range) {
    const before = lines.slice(0, range.start);
    const after = lines.slice(range.end);
    const merged = [...before, ...block.split("\n").filter((_, i, a) => i < a.length - 1), ...after].join("\n");
    // a block replaced at EOF would otherwise drop the file's trailing newline → re-add it so a repeated
    // set is byte-stable and the file keeps a terminating newline.
    return merged.endsWith("\n") ? merged : merged + "\n";
  }
  const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + block;
}

/** Remove the `[mcp_servers.<name>]` block from config.toml, preserving everything else. Returns the original
 *  text unchanged when `name` is absent (byte-stable no-op). */
export function removeCodexMcpServer(existing: string | undefined, name: string): string {
  if (existing === undefined) return "";
  const range = codexMcpServerRange(existing, name);
  if (!range) return existing;
  const lines = existing.split("\n");
  return [...lines.slice(0, range.start), ...lines.slice(range.end)].join("\n");
}

/** True when config.toml has a `[mcp_servers.<name>]` block. */
export function codexMcpServerPresent(existing: string | undefined, name: string): boolean {
  return existing !== undefined && codexMcpServerRange(existing, name) !== null;
}

/** The current `[mcp_servers.<name>]` block text (header + body, newline-terminated, trailing blank lines
 *  trimmed) for content-equality checks, or undefined when absent. */
export function getCodexMcpServerBlock(existing: string | undefined, name: string): string | undefined {
  if (existing === undefined) return undefined;
  const range = codexMcpServerRange(existing, name);
  if (!range) return undefined;
  const body = existing.split("\n").slice(range.start, range.end);
  while (body.length > 0 && body[body.length - 1].trim() === "") body.pop(); // drop blank separator lines
  return body.join("\n") + "\n";
}

export function codexAlreadyRegistered(existing: string | undefined, url: string, auth = false): boolean {
  if (!existing) return false;
  const range = codexMcpServerRange(existing, "tachyon");
  if (!range) return false;
  const block = existing.split("\n").slice(range.start, range.end).join("\n");
  const hasUrl = new RegExp(`url\\s*=\\s*"${url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(block);
  const hasAuth = /bearer_token_env_var\s*=\s*"TACHYON_BRIDGE_TOKEN"/.test(block);
  return hasUrl && (!auth || hasAuth);
}

/**
 * Merge the Bridge into a project-scoped `.codex/config.toml` (Codex supports
 * project-level config for trusted projects). Only the `[mcp_servers.tachyon]`
 * table is (re)written; every other line — comments, other servers, settings —
 * is preserved verbatim (targeted text edit, not a parse+restringify).
 */
export function buildCodexToml(existing: string | undefined, url: string, auth = false): string {
  return setCodexMcpServer(existing, "tachyon", codexTachyonBlock(url, auth));
}

/** Copy/paste snippet (kept for the stdio-proxy fallback note + manual paths). */
export function codexSnippet(url: string, auth = false): string {
  const lines = ["# .codex/config.toml (project-scoped — trust the project in Codex)", codexTachyonBlock(url, auth).trimEnd()];
  lines.push(
    "",
    "# If your Codex version doesn't support HTTP MCP servers yet, proxy over stdio:",
    "# [mcp_servers.tachyon]",
    '# command = "npx"',
    auth
      ? `# args = ["-y", "mcp-remote", "${url}", "--header", "Authorization: Bearer \${TACHYON_BRIDGE_TOKEN}"]`
      : `# args = ["-y", "mcp-remote", "${url}"]`,
  );
  return lines.join("\n");
}

export function buildOffers(
  url: string,
  existing: { claudeMcpJson?: string; opencodeJson?: string; codexToml?: string },
  auth = false,
): RegistrationOffer[] {
  const authNote = auth
    ? " Token comes from the TACHYON_BRIDGE_TOKEN env var — injected automatically into agents Tachyon spawns; external sessions: 'Tachyon: Copy Bridge Token'."
    : "";
  return [
    {
      runtime: "claude-code",
      title: "Claude Code (.mcp.json)",
      file: ".mcp.json",
      content: buildClaudeMcpJson(existing.claudeMcpJson, url, auth),
      upToDate: claudeAlreadyRegistered(existing.claudeMcpJson, url, auth),
      snippet: JSON.stringify({ mcpServers: { tachyon: expectedClaudeEntry(url, auth) } }, null, 2),
      notes: `Workspace-scoped; Claude Code picks it up on next session (approve the server when prompted).${authNote}`,
    },
    {
      runtime: "opencode",
      title: "OpenCode (opencode.json)",
      file: "opencode.json",
      content: buildOpencodeJson(existing.opencodeJson, url, auth),
      upToDate: opencodeAlreadyRegistered(existing.opencodeJson, url, auth),
      snippet: JSON.stringify({ mcp: { tachyon: expectedOpencodeEntry(url, auth) } }, null, 2),
      notes: `Workspace-scoped remote MCP entry.${authNote}`,
    },
    {
      runtime: "codex",
      title: "Codex CLI (.codex/config.toml)",
      file: ".codex/config.toml",
      content: buildCodexToml(existing.codexToml, url, auth),
      upToDate: codexAlreadyRegistered(existing.codexToml, url, auth),
      snippet: codexSnippet(url, auth),
      notes: `Workspace-scoped (project-level config; trust the project in Codex, restart it to pick it up).${authNote}`,
    },
    {
      runtime: "generic",
      title: "Any MCP client (generic URL)",
      snippet: url,
      notes: auth
        ? `Streamable-HTTP endpoint; requires 'Authorization: Bearer <token>' (Tachyon: Copy Bridge Token). stdio-only clients: npx -y mcp-remote ${url} --header "Authorization: Bearer \${TACHYON_BRIDGE_TOKEN}"`
        : `Streamable-HTTP endpoint. stdio-only clients: npx -y mcp-remote ${url}`,
    },
  ];
}
