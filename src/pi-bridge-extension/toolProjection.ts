export interface McpToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolCallResult {
  content?: unknown[];
  structuredContent?: unknown;
  isError?: boolean;
}

export interface PiToolContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

export interface PiProjectedTool {
  name: string;
  label: string;
  description: string;
  promptSnippet: string;
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: PiToolContent[]; details: { bridgeTool: string; structuredContent?: unknown } }>;
}

export interface McpToolCaller {
  callTool(
    input: { name: string; arguments: Record<string, unknown> },
    resultSchema?: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<McpToolCallResult>;
}

function resultText(content: PiToolContent[]): string {
  return content
    .filter((item): item is PiToolContent & { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

export function projectMcpContent(result: McpToolCallResult): PiToolContent[] {
  const projected: PiToolContent[] = [];
  for (const item of result.content ?? []) {
    if (!item || typeof item !== "object") continue;
    const value = item as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") {
      projected.push({ type: "text", text: value.text });
      continue;
    }
    if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") {
      projected.push({ type: "image", data: value.data, mimeType: value.mimeType });
      continue;
    }
    projected.push({ type: "text", text: JSON.stringify(value) });
  }
  if (projected.length === 0 && result.structuredContent !== undefined) {
    projected.push({ type: "text", text: JSON.stringify(result.structuredContent, null, 2) });
  }
  if (projected.length === 0) projected.push({ type: "text", text: "Tachyon Bridge returned no content." });
  return projected;
}

export function projectMcpTool(
  tool: McpToolDescriptor,
  caller: McpToolCaller,
  schema: (input: Record<string, unknown>) => unknown,
): PiProjectedTool {
  return {
    name: tool.name,
    label: tool.title?.trim() || tool.name,
    description: tool.description?.trim() || `Call Tachyon Bridge tool ${tool.name}`,
    promptSnippet: tool.description?.trim() || `Call Tachyon Bridge tool ${tool.name}`,
    parameters: schema(tool.inputSchema),
    async execute(_toolCallId, params, signal) {
      const result = await caller.callTool(
        { name: tool.name, arguments: params },
        undefined,
        signal ? { signal } : undefined,
      );
      const content = projectMcpContent(result);
      if (result.isError) throw new Error(resultText(content) || `Tachyon Bridge tool ${tool.name} failed`);
      return {
        content,
        details: {
          bridgeTool: tool.name,
          ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
        },
      };
    },
  };
}
