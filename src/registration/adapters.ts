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

/** True when `.mcp.json` already registers this exact Bridge URL (+auth header when required). */
export function claudeAlreadyRegistered(existing: string | undefined, url: string, auth = false): boolean {
  return entryMatches(
    existing,
    (root) => (root.mcpServers as Record<string, unknown> | undefined)?.tachyon,
    expectedClaudeEntry(url, auth),
  );
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

/** Merge the Bridge into a (possibly existing) Claude Code `.mcp.json`. Throws on unparseable existing content. */
export function buildClaudeMcpJson(existing: string | undefined, url: string, auth = false): string {
  let root: Record<string, unknown> = {};
  if (existing !== undefined && existing.trim().length > 0) {
    const parsed: unknown = JSON.parse(existing);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(".mcp.json exists but is not a JSON object");
    }
    root = parsed as Record<string, unknown>;
  }
  const servers =
    typeof root.mcpServers === "object" && root.mcpServers !== null && !Array.isArray(root.mcpServers)
      ? (root.mcpServers as Record<string, unknown>)
      : {};
  servers.tachyon = expectedClaudeEntry(url, auth);
  root.mcpServers = servers;
  return `${JSON.stringify(root, null, 2)}\n`;
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

/** Extracts the `[mcp_servers.tachyon]` block (header → next table header / EOF) from TOML text. */
function codexTachyonRange(text: string): { start: number; end: number } | null {
  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\[mcp_servers\.tachyon\]\s*$/.test(lines[i])) {
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

export function codexAlreadyRegistered(existing: string | undefined, url: string, auth = false): boolean {
  if (!existing) return false;
  const range = codexTachyonRange(existing);
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
  const block = codexTachyonBlock(url, auth);
  if (existing === undefined || existing.trim().length === 0) return block;
  const range = codexTachyonRange(existing);
  const lines = existing.split("\n");
  if (range) {
    const before = lines.slice(0, range.start);
    const after = lines.slice(range.end);
    return [...before, ...block.split("\n").filter((_, i, a) => i < a.length - 1), ...after].join("\n");
  }
  // append, with a separating blank line if the file doesn't already end in one
  const sep = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return existing + sep + block;
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
