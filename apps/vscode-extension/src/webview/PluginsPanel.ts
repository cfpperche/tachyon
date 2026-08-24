import * as vscode from "vscode";
import * as os from "node:os";
import * as path from "node:path";
import type { PluginGrantsRevocationV1, WorkspacePluginProfileTarget } from "../shell/WorkspacePresentation.js";
import {
  SectionPanelManager,
  type SectionAppConfig,
  type SectionPanelState,
  type SectionPanelTarget,
} from "./shared/SectionPanelManager.js";
import { webviewApp, type WebviewAppEntry } from "./webviewApps.js";
import type { ControlWorkspaceScope } from "./shared/ControlWorkspaceScope.js";
import { chooseZipWithSystemDialog } from "./shared/systemFileDialog.js";
import { browseForZip, findZipCandidates, zipSearchRoots } from "@tachyon/engine/files/zipPicker.js";
import { installFromZip, uninstall } from "@tachyon/engine/plugins2/install.js";
import { readCatalog } from "@tachyon/engine/plugins2/catalog.js";
import { buildPluginsViewModel } from "@tachyon/engine/plugins2/viewModel.js";
import {
  busyMessage,
  pluginsMessage,
  resultMessage,
  zipsMessage,
  READY,
  type PluginsActionType,
  type ZipsMessage,
} from "@tachyon/webview-ui/webview/plugins/messages";

/**
 * 516 — a aba Plugins.
 *
 * ## Por que este arquivo encolheu de 1.117 linhas para ~200
 *
 * O painel antigo era grande porque o SISTEMA era grande: ele orquestrava prévia de instalação,
 * gaveta de consentimento com aceite por runtime, decisões Keep/Replace por skill em colisão,
 * transação de aplicação com guarda de fingerprint, checagem de atualização re-resolvendo o endereço
 * de origem, provisionamento de ferramenta com barra de progresso, reidratação após clone, reparo de
 * git hooks e aplicar/desaplicar contribuição.
 *
 * Nada disso existe mais. Instalar é descompactar numa pasta que não colide com nada de ninguém;
 * desinstalar é apagá-la; e o catálogo é o disco. O que sobra é o que um painel deve ser: um ADAPTADOR
 * entre a tela e o domínio, sem domínio dentro.
 *
 * ## O que ele deliberadamente NÃO faz
 *
 * Conceder. Quem recebe qual capacidade é decisão por agente e mora no Agent Studio, junto do resto do
 * que aquele agente recebeu. A spec 515 gastou uma fatia inteira desfazendo o desenho em que
 * instalar e conceder eram duas telas para uma decisão só.
 */

/**
 * The viewType, and it is the RETIRED one on purpose — the fourth call in this spec's series, and the one
 * that makes the rule readable. C4 REUSED `tachyonTaskDetail` and paid a two-field rename for it; C5 could
 * NOT reuse the retired Board viewType; D1 reused `tachyonServerInspector` for free.
 *
 * The question that decides it is not "was the tombstone a redirect" — all three were — but **does the id
 * still NAME this app, and does its legacy record map onto this app's key with no residue?** For the Board
 * the answer was no on the first half: the product screen is called the Board, its manifest row is
 * `{view: "board", viewId: "tachyonBoard"}`, and the retired Board viewType names a screen that no
 * longer exists under that name. Here both halves are yes — the app IS Plugins, its bundle directory IS
 * `plugins`, and the pre-410 panel's one scoping field (`wsHash`) is exactly the one field a `dashboard`
 * key is made of. So `migrateLegacy` renames it and the panel VS Code hands back is REUSED: a window
 * closed since before 410 gets its Plugins tab back rather than watching one close and another open, and
 * there is no second viewType left behind for a future reader to keep in sync.
 */
export const PLUGINS_VIEW_TYPE = "tachyonPlugins";

/**
 * The persisted shape the STANDALONE panel wrote before SDD 410 retired it. It is not what this app
 * persists — `SectionPanelManager` writes `project` — but the viewType is the same, so a window that has
 * been closed since before 410 can still hand us one of these. `migrateLegacy` below is the whole of the
 * compatibility shim, and it has no UI: it translates ONE field name.
 */
export interface PluginsPanelState {
  schemaVersion: 1;
  view: typeof PLUGINS_VIEW_TYPE;
  wsHash: string;
}


/** the one invalidation kind this app knows: "the plugin catalogue you are showing may be stale". */
type PluginsRefreshKind = "plugins";

interface InboundMsg {
  type?: PluginsActionType;
  /** o plugin de uma ação de card. */
  name?: string;
  /** um diretório em que o seletor entrou, ou o arquivo que o humano escolheu. */
  dir?: string;
  zipPath?: string;
}

interface PanelIO {
  post(): void;
  postBusy(label: string): void;
  postResult(ok: boolean, message: string): void;
  postZips(message: ZipsMessage): void;
}

export class PluginsPanelManager {
  private readonly manager: SectionPanelManager<PluginsRefreshKind>;

  constructor(
    extensionUri: vscode.Uri,
    private readonly getWorkspaces: () => WorkspacePluginProfileTarget[],
    private readonly onPluginsChanged: () => void = () => undefined,
    app: WebviewAppEntry = webviewApp("plugins"),
    workspaceScope?: ControlWorkspaceScope,
  ) {
    this.manager = new SectionPanelManager<PluginsRefreshKind>(extensionUri, this.configFor(app), workspaceScope);
  }

  /** Open Plugins for one project, or REVEAL the panel already open for it. */
  open(project: string): void {
    this.manager.open({ project });
  }

  openInCurrentScope(): boolean {
    return this.manager.openInCurrentScope();
  }

  /** The fan-out door, for a caller that has one. Returns how many panels actually did work. */
  refresh(): number {
    return this.manager.refresh("plugins");
  }

  /** the upstream event cursor expired: every hidden panel rebuilds instead of replaying on reveal. */
  markSourceResync(): void {
    this.manager.markSourceResync();
  }

  /**
   * Revive a panel VS Code restored across a window reload. Accepts BOTH this app's own persisted state
   * and the pre-410 standalone panel's `{wsHash}` — same viewType, so both can arrive here, and a legacy
   * record deserves the project it named rather than a disposed tab.
   */
  deserialize(panel: vscode.WebviewPanel, state: SectionPanelState | PluginsPanelState): void {
    this.manager.deserialize(panel, migrateLegacy(state));
  }

  get openKeys(): string[] {
    return this.manager.openKeys;
  }

  dispose(): void {
    this.manager.dispose();
  }

  private workspaceFor(target: SectionPanelTarget): WorkspacePluginProfileTarget | undefined {
    // ESTRITO: o projeto É metade da chave deste painel, então resolvê-lo com folga deixaria dois
    // painéis caírem no mesmo workspace sob chaves diferentes. Um projeto que não está mais anexado diz
    // isso; nunca toma emprestado os plugins de outro — o que numa superfície que INSTALA coisas não
    // seria um erro cosmético.
    return this.getWorkspaces().find((w) => w.wsHash === target.project);
  }

  private configFor(app: WebviewAppEntry): SectionAppConfig<PluginsRefreshKind> {
    return {
      app,
      styleFiles: ["codicon.css", "tokens.css", "faces.css", "design-system.css", "quick-picker.css", "plugins.tailwind.css", "plugins.css"],
      title: () => vscode.l10n.t("Plugins"),
      refreshKindFor: pluginsRefreshKind,
      bind: (session) => {
        const post = (): void => {
          const ws = this.workspaceFor(session.target);
          if (!ws) {
            session.post(resultMessage(false, `No Tachyon workspace attached for this Plugins panel (${session.target.project}).`));
            return;
          }
          session.post(pluginsMessage(buildPluginsViewModel({ catalog: readCatalog(ws.workspaceRoot) })));
        };
        const io: PanelIO = {
          post,
          postBusy: (label) => { session.post(busyMessage(label)); },
          postResult: (ok, message) => { session.post(resultMessage(ok, message)); },
          postZips: (message) => { session.post(message); },
        };
        return {
          // `replay` e `resync` fazem o mesmo trabalho, e isso é propriedade da superfície: o modelo é
          // uma leitura completa de um diretório, então não há delta que um rebuild não dê.
          replay: () => { post(); },
          resync: () => { post(); },
          onMessage: (raw) => {
            const ws = this.workspaceFor(session.target);
            if (!ws) {
              session.post(resultMessage(false, `No Tachyon workspace attached for this Plugins panel (${session.target.project}).`));
              return;
            }
            void this.onMessage(ws, raw as InboundMsg, io);
          },
        };
      },
    };
  }

  private async onMessage(ws: WorkspacePluginProfileTarget, m: InboundMsg, io: PanelIO): Promise<void> {
    switch (m.type) {
      case "refresh":
        io.post();
        return;
      case "install":
        this.openZipPicker(ws, io);
        return;
      case "browseZips":
        if (m.dir) this.openZipPicker(ws, io, m.dir);
        return;
      // O diálogo do sistema é uma porta que o humano ESCOLHE de dentro do nosso seletor, nunca a
      // porta em que ele chega. `systemFileDialog.ts` é o único lugar que fala com o editor sobre isso.
      case "systemBrowseZip": {
        const chosen = await chooseZipWithSystemDialog(vscode.l10n.t("Install plugin"));
        if (chosen) await this.install(ws, chosen, io);
        return;
      }
      case "installFrom":
        if (m.zipPath) await this.install(ws, m.zipPath, io);
        return;
      case "remove":
        if (m.name) await this.remove(ws, m.name, io);
        return;
      case "openDocs":
        if (m.name) this.openDocs(ws, m.name, io);
        return;
      default:
        return;
    }
  }

  private async install(ws: WorkspacePluginProfileTarget, zipPath: string, io: PanelIO): Promise<void> {
    io.postBusy(vscode.l10n.t("Reading {0}…", path.basename(zipPath)));
    const result = await installFromZip(ws.workspaceRoot, zipPath);
    if (!result.plugin) {
      io.postResult(false, `Could not install '${path.basename(zipPath)}': ${result.errors.join("; ")}`);
      io.post();
      return;
    }
    const { name, version } = result.plugin.manifest;
    io.post();
    io.postResult(true, result.replaced
      ? vscode.l10n.t("Replaced '{0}' with v{1}. Grant it to an agent in Agent Studio.", name, version)
      : vscode.l10n.t("Installed '{0}' v{1}. Grant it to an agent in Agent Studio.", name, version));
    this.onPluginsChanged();
  }

  /**
   * Remover: revogar as concessões PRIMEIRO, apagar a pasta depois.
   *
   * t-b1940c — a ordem é a decisão, não um detalhe. Apagar primeiro deixaria concessões vivas
   * apontando para um diretório que não existe mais, e o agente que as tem seria recusado no launch
   * por `missing-reference` — um estado que o humano não pediu e não sabe desfazer. Por isso uma
   * revogação que não completa (falha da porta, ou recusa em qualquer agente) RECUSA a remoção: o
   * plugin continua instalado, que é o estado do qual ainda se pode sair.
   *
   * Esta é a única parte do painel que atravessa para o motor, porque é lá que vivem o cofre e a
   * transação canônica. O editor compõe a mensagem; ele não escreve perfis.
   */
  private async remove(ws: WorkspacePluginProfileTarget, name: string, io: PanelIO): Promise<void> {
    const revocation = await this.revokeGrantsBeforeRemove(ws, name);
    if (!revocation.ok) {
      io.postResult(false, `Could not remove '${name}'.${revocation.note}`);
      return;
    }
    const result = uninstall(ws.workspaceRoot, name);
    if (result.errors.length > 0) {
      io.postResult(false, result.errors.join("; "));
      return;
    }
    io.post();
    // Remover o que já não está é o estado desejado, não um erro — mas dizer "removido" sobre algo que
    // não estava lá afirmaria um trabalho que não houve.
    io.postResult(true, result.removed
      ? `${vscode.l10n.t("Removed '{0}'.", name)}${revocation.note}`
      : `${vscode.l10n.t("'{0}' was already gone.", name)}${revocation.note}`);
    this.onPluginsChanged();
  }

  /**
   * Nomear quem perdeu o quê, ANTES de o payload ir embora.
   *
   * Um relatório vazio significa que nenhum perfil segurava concessão: ok, sem nada a dizer. Um
   * agente RODANDO fica com a cópia com que subiu até o próximo launch, e isso é dito aqui porque a
   * escrita do motor não alcança a sessão viva (t-746f0f).
   */
  private async revokeGrantsBeforeRemove(ws: WorkspacePluginProfileTarget, pluginName: string): Promise<{ ok: boolean; note: string }> {
    let report: PluginGrantsRevocationV1;
    try {
      report = await ws.revokePluginGrants(pluginName);
    } catch (e) {
      return { ok: false, note: ` Could not revoke agent grants: ${e instanceof Error ? e.message : String(e)} — ${pluginName} was not removed.` };
    }
    const notes: string[] = [];
    if (report.revoked.length > 0) {
      const byAgent = new Map<string, string[]>();
      for (const { agent, referenceId } of report.revoked) {
        const ids = byAgent.get(agent);
        if (ids) ids.push(referenceId);
        else byAgent.set(agent, [referenceId]);
      }
      notes.push(`Revoked ${pluginName} from ${[...byAgent].map(([agent, ids]) => `${agent} (${ids.join(", ")})`).join(", ")}.`);
      if (report.revoked.some((r) => r.running === true)) {
        notes.push("Running agents keep their launched copy until restart.");
      }
    }
    if (report.errors.length > 0) {
      return { ok: false, note: ` Could not revoke agent grants: ${report.errors.map((e) => `${e.agent} (${e.referenceId}): ${e.error}`).join("; ")} — ${pluginName} was not removed.${notes.length > 0 ? ` ${notes.join(" ")}` : ""}` };
    }
    return { ok: true, note: notes.length > 0 ? ` ${notes.join(" ")}` : "" };
  }

  private openDocs(ws: WorkspacePluginProfileTarget, name: string, io: PanelIO): void {
    const plugin = readCatalog(ws.workspaceRoot).installed.find((p) => p.manifest.name === name);
    const docs = plugin?.manifest.docs;
    if (!docs) {
      io.postResult(false, `'${name}' declares no docs URL.`);
      return;
    }
    void vscode.env.openExternal(vscode.Uri.parse(docs));
  }

  /**
   * Responder o seletor: os arquivos por perto, ou um diretório em que o humano entrou.
   *
   * Uma recusa viaja como MOTIVO, nunca como lista vazia — `browseForZip` põe o errno em
   * `listing.error` e o seletor o imprime. "Não tem nada aqui" e "permissão negada" são iguais numa
   * lista e não são o mesmo fato.
   */
  private openZipPicker(ws: WorkspacePluginProfileTarget, io: PanelIO, dir?: string): void {
    if (dir) {
      io.postZips(zipsMessage([], [], { listing: browseForZip(dir) }));
      return;
    }
    const roots = zipSearchRoots(ws.workspaceRoot, os.homedir(), os.tmpdir());
    const candidates = findZipCandidates(roots, undefined, undefined, "plugin").map((c) => ({ path: c.path, name: c.name, dir: c.dir }));
    io.postZips(zipsMessage(candidates, roots));
  }
}

export function pluginsRefreshKind(message: unknown): PluginsRefreshKind | undefined {
  if (!message || typeof message !== "object") return undefined;
  return (message as { type?: unknown }).type === READY ? "plugins" : undefined;
}

/**
 * The pre-410 standalone panel's state, translated into this app's. ONE field renamed — a compatibility
 * shim with NO UI, which is the one kind `spec.md` allows to survive a cutover. Anything already in the
 * new shape passes through untouched, and a record with neither field migrates to an EMPTY project, which
 * `sectionPanelKey` refuses — so the panel is disposed, the same outcome the serializer already gives an
 * unreadable state.
 */
function migrateLegacy(state: SectionPanelState | PluginsPanelState): SectionPanelState {
  if (typeof (state as Partial<SectionPanelState>).project === "string") return state as SectionPanelState;
  const legacy = state as Partial<PluginsPanelState>;
  return {
    schemaVersion: 1,
    view: PLUGINS_VIEW_TYPE,
    project: typeof legacy.wsHash === "string" ? legacy.wsHash : "",
  };
}
