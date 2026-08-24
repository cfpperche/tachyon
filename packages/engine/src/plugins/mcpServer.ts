/**
 * 516 — a forma de um servidor MCP que um plugin traz, e a substituição de `${PLUGIN_ROOT}`.
 *
 * Isto é o que sobrou de um módulo de 417 linhas que fazia parsing, validação, coleta de variáveis de
 * ambiente exigidas e cálculo de identidade de remoção — tudo para sustentar a mesclagem de servidores
 * no `.mcp.json` do PROJETO, que o sistema novo não faz. O que os adaptadores de claude e codex ainda
 * precisam são estas duas coisas: o tipo, e a substituição.
 *
 * A substituição falha fechada de propósito. Deixar o literal `${PLUGIN_ROOT}` passar foi o defeito
 * t-b6180e: o shell expande para vazio e o comando vira `/servers/srv`, um caminho absoluto que não é
 * o que ninguém escreveu.
 */
export interface McpServerStdio {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  /** nome da variável → referência exata `${VAR}` (nunca um valor literal). */
  env: Record<string, string>;
}

export interface McpServerHttp {
  name: string;
  transport: "http";
  url: string;
  /** nome do header → template que referencia ≥1 `${VAR}`; nunca um segredo cru. */
  headers: Record<string, string>;
}

export type McpServer = McpServerStdio | McpServerHttp;

export const PLUGIN_ROOT_TOKEN = "${PLUGIN_ROOT}";
const PLUGIN_ROOT_PREFIX = `${PLUGIN_ROOT_TOKEN}/`;

/** Trocar um `${PLUGIN_ROOT}/…` inicial pela raiz absoluta do payload. Sem o token, passa direto. */
export function resolveMcpPluginRootPath(value: string, pluginRoot: string | undefined): string {
  if (!value.startsWith(PLUGIN_ROOT_PREFIX)) return value;
  if (typeof pluginRoot !== "string" || pluginRoot.length === 0 || !pluginRoot.startsWith("/") || pluginRoot.includes("\0") || pluginRoot.includes("\\")) {
    throw new Error("MCP ${PLUGIN_ROOT} substitution requires an absolute pluginRoot");
  }
  const root = pluginRoot.endsWith("/") ? pluginRoot.slice(0, -1) : pluginRoot;
  return `${root}/${value.slice(PLUGIN_ROOT_PREFIX.length)}`;
}

/** Um servidor com `${PLUGIN_ROOT}/…` resolvido no comando e nos argumentos; http passa intacto. */
export function withResolvedMcpPluginRoot(server: McpServer, pluginRoot: string | undefined): McpServer {
  if (server.transport !== "stdio") return server;
  const command = resolveMcpPluginRootPath(server.command, pluginRoot);
  const args = server.args.map((a) => resolveMcpPluginRootPath(a, pluginRoot));
  if (command === server.command && args.every((a, i) => a === server.args[i])) return server;
  return { ...server, command, args };
}
