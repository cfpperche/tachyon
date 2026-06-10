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

/** True when `.mcp.json` already registers this exact Bridge URL. */
export function claudeAlreadyRegistered(existing: string | undefined, url: string): boolean {
  return entryMatches(
    existing,
    (root) => (root.mcpServers as Record<string, unknown> | undefined)?.tachyon,
    { type: "http", url },
  );
}

/** True when `opencode.json` already registers this exact Bridge URL. */
export function opencodeAlreadyRegistered(existing: string | undefined, url: string): boolean {
  return entryMatches(
    existing,
    (root) => (root.mcp as Record<string, unknown> | undefined)?.tachyon,
    { type: "remote", url, enabled: true },
  );
}

/** Merge the Bridge into a (possibly existing) Claude Code `.mcp.json`. Throws on unparseable existing content. */
export function buildClaudeMcpJson(existing: string | undefined, url: string): string {
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
  servers.tachyon = { type: "http", url };
  root.mcpServers = servers;
  return `${JSON.stringify(root, null, 2)}\n`;
}

/** Merge the Bridge into a (possibly existing) `opencode.json`. */
export function buildOpencodeJson(existing: string | undefined, url: string): string {
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
  mcp.tachyon = { type: "remote", url, enabled: true };
  root.mcp = mcp;
  return `${JSON.stringify(root, null, 2)}\n`;
}

/** Codex CLI config snippet (~/.codex/config.toml) — offered for copy/paste, never written to the user's home. */
export function codexSnippet(url: string): string {
  return [
    "# Add to ~/.codex/config.toml",
    "[mcp_servers.tachyon]",
    `url = "${url}"`,
    "",
    "# If your Codex version doesn't support HTTP MCP servers yet, proxy over stdio:",
    "# [mcp_servers.tachyon]",
    '# command = "npx"',
    `# args = ["-y", "mcp-remote", "${url}"]`,
  ].join("\n");
}

export function buildOffers(url: string, existing: { claudeMcpJson?: string; opencodeJson?: string }): RegistrationOffer[] {
  return [
    {
      runtime: "claude-code",
      title: "Claude Code (.mcp.json)",
      file: ".mcp.json",
      content: buildClaudeMcpJson(existing.claudeMcpJson, url),
      upToDate: claudeAlreadyRegistered(existing.claudeMcpJson, url),
      snippet: JSON.stringify({ mcpServers: { tachyon: { type: "http", url } } }, null, 2),
      notes: "Workspace-scoped; Claude Code picks it up on next session (approve the server when prompted).",
    },
    {
      runtime: "opencode",
      title: "OpenCode (opencode.json)",
      file: "opencode.json",
      content: buildOpencodeJson(existing.opencodeJson, url),
      upToDate: opencodeAlreadyRegistered(existing.opencodeJson, url),
      snippet: JSON.stringify({ mcp: { tachyon: { type: "remote", url, enabled: true } } }, null, 2),
      notes: "Workspace-scoped remote MCP entry.",
    },
    {
      runtime: "codex",
      title: "Codex CLI (~/.codex/config.toml)",
      snippet: codexSnippet(url),
      notes: "User-scoped file — copy the snippet yourself; Tachyon does not write outside the workspace.",
    },
    {
      runtime: "generic",
      title: "Any MCP client (generic URL)",
      snippet: url,
      notes: `Streamable-HTTP endpoint. stdio-only clients: npx -y mcp-remote ${url}`,
    },
  ];
}
