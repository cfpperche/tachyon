/**
 * Pure parsers for @tachyon chat prompts (no vscode).
 * Dev Host / prototype bridge — keep deterministic for unit tests.
 */

export type ParsedTachyonChat =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "send"; agent: string; text: string }
  | { kind: "ambiguous"; reason: string };

/**
 * Parse free-form or slash-command body for the @tachyon participant.
 * `command` is VS Code chat slash command name when the user used /list /send /help.
 */
export function parseTachyonChat(prompt: string, command?: string): ParsedTachyonChat {
  const body = (prompt ?? "").trim();
  const cmd = (command ?? "").trim().toLowerCase();

  if (cmd === "help" || (!cmd && /^(help|\?)$/i.test(body))) return { kind: "help" };
  if (cmd === "list" || (!cmd && /^list(\s+agents?)?$/i.test(body))) return { kind: "list" };

  if (cmd === "send") {
    return parseSendBody(body);
  }

  if (!body) return { kind: "help" };

  // Free-form: "to grok: fix padding" | "grok: message" | "send grok message"
  const toColon = body.match(/^to\s+(\S+)\s*:\s*([\s\S]+)$/i);
  if (toColon) {
    return { kind: "send", agent: toColon[1]!, text: toColon[2]!.trim() };
  }
  const bareColon = body.match(/^([A-Za-z0-9._-]+)\s*:\s*([\s\S]+)$/);
  if (bareColon && !/^(https?|file)$/i.test(bareColon[1]!)) {
    return { kind: "send", agent: bareColon[1]!, text: bareColon[2]!.trim() };
  }
  const sendPrefix = body.match(/^send\s+(\S+)\s+([\s\S]+)$/i);
  if (sendPrefix) {
    return { kind: "send", agent: sendPrefix[1]!, text: sendPrefix[2]!.trim() };
  }

  return {
    kind: "ambiguous",
    reason:
      "Could not parse a target agent. Use `/send <agent> <message>`, `agent: message`, or `/list`.",
  };
}

function parseSendBody(body: string): ParsedTachyonChat {
  const trimmed = body.trim();
  if (!trimmed) {
    return { kind: "ambiguous", reason: "Usage: /send <agentName> <message>" };
  }
  const m = trimmed.match(/^(\S+)\s+([\s\S]+)$/);
  if (!m) {
    return { kind: "ambiguous", reason: "Usage: /send <agentName> <message>" };
  }
  return { kind: "send", agent: m[1]!, text: m[2]!.trim() };
}

export function formatAgentListMarkdown(
  agents: Array<{ name: string; running?: boolean; kind?: string; lifetime?: string }>,
  workspaceLabel: string,
): string {
  if (agents.length === 0) {
    return `No agents in workspace **${workspaceLabel}**.`;
  }
  const lines = [
    `Agents in **${workspaceLabel}** (${agents.length}):`,
    "",
    "| name | kind | lifetime | running |",
    "| --- | --- | --- | --- |",
  ];
  for (const a of agents) {
    lines.push(
      `| \`${a.name}\` | ${a.kind ?? "?"} | ${a.lifetime ?? "?"} | ${a.running ? "yes" : "no"} |`,
    );
  }
  lines.push("", "Send with: `/send <name> <message>` or `name: message`");
  return lines.join("\n");
}

export const TACHYON_CHAT_HELP = [
  "## @tachyon — bridge to Tachyon workspace agents",
  "",
  "Routes your text into a **running Tachyon agent** (Bridge / worktree CLI), not the Copilot model.",
  "",
  "### Commands",
  "- `/list` — list agents in the active Tachyon workspace",
  "- `/send <agent> <message>` — paste + submit message to that agent",
  "- `/help` — this text",
  "",
  "### Free-form",
  "- `grok: fix the button padding`",
  "- `to claude: run the tests`",
  "",
  "### Agent mode tools",
  "- `#tachyon_list_agents`",
  "- `#tachyon_send_prompt`",
  "",
  "### Browser context",
  "Use the Integrated Browser **Add Element / Screenshot to Chat**, then `@tachyon /send <agent> …` so the attachment rides in the chat request references.",
].join("\n");
