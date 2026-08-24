/**
 * 516 — o envelope host↔webview da aba Plugins.
 *
 * ## Por que ele encolheu tanto
 *
 * O envelope antigo tinha vinte e duas ações e quatro mensagens de host, e a maioria existia por
 * causa de coisas que não existem mais: checar atualização (não há origem remota), consentir por
 * runtime (a instalação não escreve em runtime nenhum), decidir Keep/Replace numa colisão (não há
 * escrita para colidir), aplicar e desaplicar contribuição (a entrega é decidida na concessão),
 * provisionar ferramenta (o Tachyon não baixa binário), reparar git hooks (saem da v1).
 *
 * Sobrou o que a tela realmente faz: mostrar o que está instalado, instalar um arquivo, remover, e
 * abrir a documentação.
 *
 * PURO por desenho (sem vscode, sem preact): importado pelo host, pelo webview e pelo harness de
 * preview, para que renomear um envelope quebre o BUILD e não uma captura de tela.
 */
import type { PluginsViewModel } from "@tachyon/engine/plugins2/viewModel.js";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

/** host → webview: o catálogo, lido do disco. */
export const PLUGINS = "plugins" as const;
export interface PluginsMessage {
  type: typeof PLUGINS;
  vm: PluginsViewModel;
}
export function pluginsMessage(vm: PluginsViewModel): PluginsMessage {
  return { type: PLUGINS, vm };
}

/** host → webview: uma operação longa está em curso. */
export const BUSY = "busy" as const;
export interface BusyMessage {
  type: typeof BUSY;
  label: string;
}
export function busyMessage(label: string): BusyMessage {
  return { type: BUSY, label };
}

/** host → webview: uma operação terminou. */
export const RESULT = "result" as const;
export interface ResultMessage {
  type: typeof RESULT;
  ok: boolean;
  message: string;
}
export function resultMessage(ok: boolean, message: string): ResultMessage {
  return { type: RESULT, ok, message };
}

/**
 * host → webview: o que o seletor de arquivo desenha.
 *
 * Duas telas numa mensagem só, porque são a mesma resposta em profundidades diferentes: `candidates`
 * é a tela de arquivos por perto em que ele abre, `listing` é um diretório em que o humano entrou.
 * `error` existe para que uma recusa viaje como MOTIVO — a primeira versão disso, em 514, desenhava
 * "no .zip found in " para uma consulta que tinha sido recusada.
 */
export const ZIPS = "zips" as const;
export interface ZipsMessage {
  type: typeof ZIPS;
  candidates: Array<{ path: string; name: string; dir: string }>;
  roots: string[];
  listing?: { dir: string; parent?: string; entries: Array<{ name: string; path: string; kind: "dir" | "zip" }>; error?: string };
  error?: string;
}
export function zipsMessage(
  candidates: ZipsMessage["candidates"],
  roots: string[],
  extra: { listing?: ZipsMessage["listing"]; error?: string } = {},
): ZipsMessage {
  return { type: ZIPS, candidates, roots, ...extra };
}

export type PluginsHostMessage = PluginsMessage | BusyMessage | ResultMessage | ZipsMessage;

/** webview → host: as seis coisas que a tela faz. Tipar a união faz de um `case` errado um erro de build. */
export type PluginsActionType =
  | "ready" | "refresh" | "install" | "browseZips" | "systemBrowseZip" | "installFrom" | "remove" | "openDocs";

/** t-d23f93 — a forma do toast de resultado. */
export interface Toast { ok: boolean; message: string; }
