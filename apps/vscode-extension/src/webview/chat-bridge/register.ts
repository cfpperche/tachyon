import * as vscode from "vscode";
import {
  formatAgentListMarkdown,
  parseTachyonChat,
  TACHYON_CHAT_HELP,
} from "./parse.js";
import {
  preferredRunnableAgents,
  type ChatBridgeOps,
} from "./ops.js";

export const TACHYON_CHAT_PARTICIPANT_ID = "tachyon.chat";
export const TACHYON_TOOL_LIST = "tachyon_list_agents";
export const TACHYON_TOOL_SEND = "tachyon_send_prompt";

type SendToolInput = {
  agent?: string;
  text?: string;
  submit?: boolean;
  workspaceHash?: string;
};

/**
 * Register @tachyon chat participant + LM tools that forward to Tachyon agents.
 * Safe to call on every activate; tools no-op with a clear error if no workspace.
 */
export function registerTachyonChatBridge(
  context: vscode.ExtensionContext,
  ops: ChatBridgeOps,
): void {
  const participant = vscode.chat.createChatParticipant(
    TACHYON_CHAT_PARTICIPANT_ID,
    async (request, _ctx, stream, _token) => {
      try {
        await handleParticipant(request, stream, ops);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        stream.markdown(`**Tachyon chat bridge error:** ${msg}`);
      }
      return { metadata: { bridge: "tachyon-chat" } };
    },
  );
  participant.iconPath = new vscode.ThemeIcon("rocket");
  context.subscriptions.push(participant);

  context.subscriptions.push(
    vscode.lm.registerTool(TACHYON_TOOL_LIST, {
      async invoke(_options, _token) {
        const ws = ops.resolveWorkspace();
        if (!ws) {
          return textResult("No Tachyon workspace is active. Open a folder with tachyon.yml and Start Tachyon.");
        }
        const agents = await ops.listAgents(ws.wsHash);
        return textResult(formatAgentListMarkdown(agents, ws.folderName));
      },
    }),
  );

  context.subscriptions.push(
    vscode.lm.registerTool(TACHYON_TOOL_SEND, {
      async prepareInvocation(options, _token) {
        const input = (options.input ?? {}) as SendToolInput;
        const agent = typeof input.agent === "string" ? input.agent : "?";
        const preview = typeof input.text === "string" ? input.text.slice(0, 200) : "";
        return {
          invocationMessage: `Sending prompt to Tachyon agent '${agent}'`,
          confirmationMessages: {
            title: "Send prompt to Tachyon agent",
            message: new vscode.MarkdownString(
              `Send the following to **\`${agent}\`**?\n\n\`\`\`\n${preview}${preview.length >= 200 ? "…" : ""}\n\`\`\``,
            ),
          },
        };
      },
      async invoke(options, _token) {
        const input = (options.input ?? {}) as SendToolInput;
        const agent = typeof input.agent === "string" ? input.agent.trim() : "";
        const text = typeof input.text === "string" ? input.text : "";
        if (!agent) throw new Error("Missing required parameter 'agent'.");
        if (!text.trim()) throw new Error("Missing required parameter 'text'.");
        const submit = input.submit !== false;
        const wsHash = typeof input.workspaceHash === "string" ? input.workspaceHash : undefined;
        await ops.sendPrompt(agent, appendChatReferences(text, undefined), { submit, wsHash });
        return textResult(
          `Delivered to Tachyon agent \`${agent}\` (submit=${submit}). Check that agent's terminal/pane.`,
        );
      },
    }),
  );
}

async function handleParticipant(
  request: vscode.ChatRequest,
  stream: vscode.ChatResponseStream,
  ops: ChatBridgeOps,
): Promise<void> {
  const parsed = parseTachyonChat(request.prompt, request.command);

  if (parsed.kind === "help") {
    stream.markdown(TACHYON_CHAT_HELP);
    return;
  }

  const ws = ops.resolveWorkspace();
  if (!ws) {
    stream.markdown(
      "No Tachyon workspace is connected. Open a folder with `tachyon.yml` and run **Tachyon: Start** (or use Dev Host F5).",
    );
    return;
  }

  if (parsed.kind === "list") {
    stream.progress("Listing Tachyon agents…");
    const agents = await ops.listAgents(ws.wsHash);
    stream.markdown(formatAgentListMarkdown(agents, ws.folderName));
    return;
  }

  if (parsed.kind === "ambiguous") {
    stream.markdown(`**${parsed.reason}**\n\n${TACHYON_CHAT_HELP}`);
    return;
  }

  // send
  const agents = await ops.listAgents(ws.wsHash);
  const names = new Set(agents.map((a) => a.name));
  if (!names.has(parsed.agent)) {
    const runnable = preferredRunnableAgents(agents).map((a) => a.name);
    stream.markdown(
      `Agent \`${parsed.agent}\` not found in **${ws.folderName}**.\n\n` +
        (runnable.length
          ? `Known: ${runnable.map((n) => `\`${n}\``).join(", ")}`
          : "No agents listed — check Control / tachyon.yml."),
    );
    return;
  }

  const text = appendChatReferences(parsed.text, request);
  if (!text.trim()) {
    stream.markdown("Empty message after parsing. Add text after the agent name.");
    return;
  }

  stream.progress(`Sending to \`${parsed.agent}\`…`);
  await ops.sendPrompt(parsed.agent, text, { submit: true, wsHash: ws.wsHash });
  stream.markdown(
    [
      `Sent to **\`${parsed.agent}\`** in **${ws.folderName}** (submitted).`,
      "",
      "Open that agent's terminal or Activity pane to see the runtime pick it up.",
      "",
      "```",
      text.length > 800 ? `${text.slice(0, 800)}\n…` : text,
      "```",
    ].join("\n"),
  );
}

function appendChatReferences(text: string, request: vscode.ChatRequest | undefined): string {
  if (!request?.references?.length) return text;
  const chunks: string[] = [text.trimEnd(), "", "---", "### Chat context attachments"];
  for (const ref of request.references) {
    const id = ref.id || "ref";
    const model = ref.modelDescription ? ` (${ref.modelDescription})` : "";
    let valueStr = "";
    try {
      if (typeof ref.value === "string") valueStr = ref.value;
      else if (ref.value instanceof vscode.Uri) valueStr = ref.value.toString();
      else if (ref.value && typeof ref.value === "object") valueStr = JSON.stringify(ref.value, null, 2);
      else valueStr = String(ref.value ?? "");
    } catch {
      valueStr = "(unreadable attachment)";
    }
    if (valueStr.length > 6000) valueStr = `${valueStr.slice(0, 6000)}\n…[truncated]`;
    chunks.push("", `#### ${id}${model}`, "```", valueStr, "```");
  }
  return chunks.join("\n");
}

function textResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}
