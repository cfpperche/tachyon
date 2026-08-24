import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Uri } from "vscode";
import { __createdPanels, __registeredWebviewPanelSerializers, __resetVscodeMock, __setPanelVisible } from "../mocks/vscode.js";
import { PluginsPanelManager, PLUGINS_VIEW_TYPE, pluginsRefreshKind, type PluginsPanelState } from "../../apps/vscode-extension/src/webview/PluginsPanel.js";
import { registerTrustedPanelSerializer } from "../../apps/vscode-extension/src/webview/shared/panelSerializer.js";
import type { SectionPanelState } from "../../apps/vscode-extension/src/webview/shared/SectionPanelManager.js";
import { readyMessage } from "@tachyon/webview-ui/webview/plugins/messages.js";
import { MANIFEST_FILE } from "@tachyon/engine/plugins2/manifest.js";
import type { WorkspacePluginProfileTarget } from "../../apps/vscode-extension/src/shell/WorkspacePresentation.js";

/**
 * 516 — a aba Plugins como app de painel, sobre o sistema novo.
 *
 * Três afirmações, de naturezas diferentes.
 *
 * A CARDINALIDADE é a do app: um painel por projeto, reabrir revela em vez de duplicar, dois projetos
 * são dois painéis. Para Plugins isso não é preferência — o que está instalado é um fato POR
 * workspace (`.tachyon/plugins/` é enraizado num `workspaceRoot`), então dois projetos têm duas
 * respostas diferentes e mostrá-las em dois painéis é o correto.
 *
 * O DOMÍNIO encolheu com o sistema, e o que sobrou tem de continuar valendo: a resolução do projeto é
 * ESTRITA (um painel nunca toma emprestado os plugins de outro), e remover REVOGA as concessões antes
 * de apagar o payload (t-b1940c) — a ordem é a decisão, porque apagar primeiro deixaria concessões
 * vivas apontando para um diretório que não existe mais.
 *
 * O que sumiu junto com o sistema antigo: consentimento por runtime, checagem de atualização, guarda
 * de ocupado, e o `poll` de 3 segundos. Não há estado de frescor que mude sozinho, então não há o que
 * reconsultar — os casos que defendiam esse estado defendiam algo que deixou de existir.
 *
 * Todo caso dirige o FIO — a mensagem que um cliente real posta — e não os internos do manager.
 */

const dirs: string[] = [];
const mkroot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "plugins-app-"));
  dirs.push(dir);
  return dir;
};

const extensionUri = Uri.file("/ext");
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Instalar à mão é exatamente o que a instalação faz: uma pasta com manifesto e payload. */
function install(root: string, name: string): string {
  const dir = path.join(root, ".tachyon", "plugins", name);
  fs.mkdirSync(path.join(dir, "skills", name), { recursive: true });
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ name, version: "1.0.0", description: `${name} does things`, docs: "https://example.dev/docs" }));
  fs.writeFileSync(path.join(dir, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: x\n---\nbody\n`);
  return dir;
}

function target(root: string, hash: string, revokePluginGrants?: (pluginName: string) => Promise<unknown>): WorkspacePluginProfileTarget {
  return {
    workspaceRoot: root,
    wsHash: hash,
    folderName: `ws-${hash}`,
    gitExec: async () => ({ code: 1, stdout: "", stderr: "fake git: unavailable" }),
    ...(revokePluginGrants ? { revokePluginGrants } : {}),
  } as unknown as WorkspacePluginProfileTarget;
}

const managerFor = (targets: WorkspacePluginProfileTarget[]) => new PluginsPanelManager(extensionUri, () => targets);

type Panel = typeof __createdPanels[number];

const posted = (panel: Panel, type: string): Array<Record<string, unknown>> =>
  panel.webview.posted.filter((m) => (m as { type?: string }).type === type) as Array<Record<string, unknown>>;

const installedIn = (panel: Panel): string[] => {
  const last = posted(panel, "plugins").at(-1) as { vm: { installed: Array<{ name: string }> } } | undefined;
  return (last?.vm.installed ?? []).map((p) => p.name);
};

/** Abrir e dar o `ready` do próprio cliente — o primeiro modelo chega pelo GATE, nunca por onMessage. */
async function open(mgr: PluginsPanelManager, project: string): Promise<Panel> {
  mgr.open(project);
  const panel = __createdPanels.at(-1)!;
  panel.webview.__receive(readyMessage());
  await flush();
  return panel;
}

describe("516 — a cardinalidade da aba Plugins é `dashboard`", () => {
  it("abre UM painel por projeto e REVELA no segundo open", async () => {
    const mgr = managerFor([target(mkroot(), "ws-1")]);
    await open(mgr, "ws-1");
    mgr.open("ws-1");
    expect(__createdPanels).toHaveLength(1);
    expect(mgr.openKeys).toEqual(["tachyonPlugins|ws-1"]);
  });

  it("dá um painel a cada PROJETO — o que está instalado é fato por workspace", async () => {
    const a = mkroot();
    const b = mkroot();
    install(a, "primeiro");
    install(b, "segundo");
    const mgr = managerFor([target(a, "ws-1"), target(b, "ws-2")]);
    const pa = await open(mgr, "ws-1");
    const pb = await open(mgr, "ws-2");
    expect(__createdPanels).toHaveLength(2);
    expect(installedIn(pa)).toEqual(["primeiro"]);
    expect(installedIn(pb)).toEqual(["segundo"]);
  });

  it("resolve um projeto que não tem e DIZ, em vez de tomar emprestados os plugins de outro", async () => {
    const root = mkroot();
    install(root, "alheio");
    const mgr = managerFor([target(root, "ws-1")]);
    const panel = await open(mgr, "ws-outro");
    expect(posted(panel, "plugins")).toHaveLength(0);
    expect((posted(panel, "result").at(-1) as { ok: boolean; message: string }).message).toContain("No Tachyon workspace attached");
  });
});

describe("516 — o catálogo que a tela mostra é o disco", () => {
  it("mostra o que está instalado, com o que cada um traz", async () => {
    const root = mkroot();
    install(root, "sdd");
    const panel = await open(managerFor([target(root, "ws-1")]), "ws-1");
    const vm = (posted(panel, "plugins").at(-1) as { vm: { installed: Array<{ name: string; capabilities: Array<{ label: string }>; runtimes: string[] }> } }).vm;
    expect(vm.installed[0]!.capabilities.map((c) => c.label)).toEqual(["1 skill"]);
    expect(vm.installed[0]!.runtimes).toEqual(["claude", "codex", "grok", "pi"]);
  });

  it("um `refresh` relê o disco — instalar por fora e pedir refresh mostra o novo", async () => {
    const root = mkroot();
    const panel = await open(managerFor([target(root, "ws-1")]), "ws-1");
    expect(installedIn(panel)).toEqual([]);
    install(root, "apareceu");
    panel.webview.__receive({ type: "refresh" });
    await flush();
    expect(installedIn(panel)).toEqual(["apareceu"]);
  });
});

describe("516 — remover revoga antes de apagar (t-b1940c)", () => {
  it("revoga as concessões ANTES de o payload ir, e nomeia quem perdeu o quê", async () => {
    const root = mkroot();
    const dir = install(root, "tdd-guard");
    const asked: Array<{ plugin: string; payloadStillThere: boolean }> = [];
    const mgr = managerFor([target(root, "ws-1", async (plugin: string) => {
      asked.push({ plugin, payloadStillThere: fs.existsSync(dir) });
      return {
        schemaVersion: 1,
        revoked: [
          { agent: "claude", referenceId: plugin, deselected: true, running: true },
          { agent: "grok", referenceId: plugin, deselected: false, running: false },
        ],
        errors: [],
      };
    })]);
    const panel = await open(mgr, "ws-1");

    panel.webview.__receive({ type: "remove", name: "tdd-guard" });
    await flush();

    // ANTES de o payload ir: no momento da revogação o diretório que a concessão aponta ainda existia.
    expect(asked).toEqual([{ plugin: "tdd-guard", payloadStillThere: true }]);
    expect(fs.existsSync(dir)).toBe(false); // e a remoção o apagou depois
    const result = posted(panel, "result").at(-1) as { ok: boolean; message: string };
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Revoked tdd-guard from claude (tdd-guard), grok (tdd-guard)");
    // t-746f0f nesta porta também: o que um agente vivo perdeu só chega no próximo launch, e a mensagem diz.
    expect(result.message).toContain("Running agents keep their launched copy until restart.");
  });

  it("uma revogação incompleta RECUSA a remoção — nada é apagado enquanto alguém segura", async () => {
    const root = mkroot();
    const dir = install(root, "tdd-guard");
    const mgr = managerFor([target(root, "ws-1", async (plugin: string) => ({
      schemaVersion: 1,
      revoked: [],
      errors: [{ agent: "codex", referenceId: plugin, error: "profile is locked" }],
    }))]);
    const panel = await open(mgr, "ws-1");

    panel.webview.__receive({ type: "remove", name: "tdd-guard" });
    await flush();

    expect(fs.existsSync(dir)).toBe(true);
    const result = posted(panel, "result").at(-1) as { ok: boolean; message: string };
    expect(result.ok).toBe(false);
    expect(result.message).toContain("codex (tdd-guard): profile is locked");
    expect(result.message).toContain("was not removed");
  });

  it("uma falha da porta de revogação também recusa, em vez de deixar concessão viva", async () => {
    const root = mkroot();
    const dir = install(root, "tdd-guard");
    const mgr = managerFor([target(root, "ws-1", async () => { throw new Error("engine unreachable"); })]);
    const panel = await open(mgr, "ws-1");

    panel.webview.__receive({ type: "remove", name: "tdd-guard" });
    await flush();

    expect(fs.existsSync(dir)).toBe(true);
    expect((posted(panel, "result").at(-1) as { message: string }).message).toContain("engine unreachable");
  });

  it("remover um plugin que ninguém concedeu não diz nada sobre concessões", async () => {
    const root = mkroot();
    const dir = install(root, "solo");
    const mgr = managerFor([target(root, "ws-1", async () => ({ schemaVersion: 1, revoked: [], errors: [] }))]);
    const panel = await open(mgr, "ws-1");

    panel.webview.__receive({ type: "remove", name: "solo" });
    await flush();

    expect(fs.existsSync(dir)).toBe(false);
    const result = posted(panel, "result").at(-1) as { ok: boolean; message: string };
    expect(result.ok).toBe(true);
    expect(result.message).not.toContain("Revoked");
  });
});

describe("516 — o portão, e a revivência do painel", () => {
  it("reclama `ready` para o portão e mais nada — `refresh` é ação humana", () => {
    expect(pluginsRefreshKind(readyMessage())).toBe("plugins");
    expect(pluginsRefreshKind({ type: "refresh" })).toBeUndefined();
    expect(pluginsRefreshKind({ type: "remove", name: "x" })).toBeUndefined();
    expect(pluginsRefreshKind(undefined)).toBeUndefined();
  });

  it("ignora o poll do cliente enquanto escondido, e alcança uma vez ao ser revelado", async () => {
    const root = mkroot();
    install(root, "um");
    const panel = await open(managerFor([target(root, "ws-1")]), "ws-1");
    const antes = posted(panel, "plugins").length;

    __setPanelVisible(panel, false);
    install(root, "dois");
    panel.webview.__receive(readyMessage());
    await flush();
    expect(posted(panel, "plugins")).toHaveLength(antes);

    __setPanelVisible(panel, true);
    await flush();
    expect(installedIn(panel)).toEqual(["dois", "um"]);
  });

  it("persiste o projeto e revive na mesma chave, reusando o painel que o VS Code devolve", async () => {
    const root = mkroot();
    const mgr = managerFor([target(root, "ws-1")]);
    mgr.open("ws-1");
    // Ler o estado persistido da PÁGINA RENDERIZADA em vez de re-derivá-lo: é o que um reload real
    // realmente devolveria.
    const persisted = JSON.parse(/__tachyonPersistedState=(\{.*?\});/.exec(__createdPanels[0]!.webview.html)![1]!) as SectionPanelState;
    expect(persisted).toEqual({ schemaVersion: 1, view: PLUGINS_VIEW_TYPE, project: "ws-1" });

    __createdPanels[0]!.dispose();
    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    const revived = managerFor([target(root, "ws-1")]);
    registerTrustedPanelSerializer<SectionPanelState>(context, PLUGINS_VIEW_TYPE, (panel, state) => revived.deserialize(panel, state));
    const registration = __registeredWebviewPanelSerializers.find((r) => r.viewType === PLUGINS_VIEW_TYPE);
    expect(registration, "no serializer registered for the Plugins viewType").toBeTruthy();

    const panel = makeRevivablePanel();
    await registration!.serializer.deserializeWebviewPanel(panel as never, persisted);

    expect(revived.openKeys).toEqual(["tachyonPlugins|ws-1"]);
    expect(panel.disposed).toBe(false);
    expect(__createdPanels.filter((p) => !p.disposed), "a revivência criou um segundo painel").toHaveLength(0);
  });

  it("revive um registro PRÉ-410 também: `wsHash` vira `project` e a aba é mantida", async () => {
    // Todo o shim de compatibilidade, e a razão de este viewType ter sido reusado em vez de trocado: a
    // alternativa é uma janela em que o humano vê uma aba fechar e outra abrir.
    const root = mkroot();
    const legacy: PluginsPanelState = { schemaVersion: 1, view: PLUGINS_VIEW_TYPE, wsHash: "ws-1" };
    const mgr = managerFor([target(root, "ws-1")]);
    const context = { subscriptions: [] } as unknown as import("vscode").ExtensionContext;
    registerTrustedPanelSerializer<SectionPanelState>(context, PLUGINS_VIEW_TYPE, (panel, state) => mgr.deserialize(panel, state));
    const registration = __registeredWebviewPanelSerializers.find((r) => r.viewType === PLUGINS_VIEW_TYPE);

    const panel = makeRevivablePanel();
    await registration!.serializer.deserializeWebviewPanel(panel as never, legacy as never);

    expect(mgr.openKeys).toEqual(["tachyonPlugins|ws-1"]);
    expect(panel.disposed).toBe(false);
  });
});

function makeRevivablePanel() {
  const disposeHandlers: Array<() => void> = [];
  const panel = {
    title: "",
    iconPath: undefined,
    disposed: false,
    visible: true,
    active: true,
    revealCount: 0,
    onDidChangeViewState: (_cb: () => void) => ({ dispose() {} }),
    webview: {
      html: "",
      options: {},
      cspSource: "vscode-webview:",
      posted: [] as unknown[],
      asWebviewUri: (uri: unknown) => uri,
      postMessage: async (msg: unknown) => { panel.webview.posted.push(msg); return true; },
      onDidReceiveMessage: (_cb: (msg: unknown) => void) => ({ dispose() {} }),
    },
    reveal: () => { panel.revealCount += 1; },
    dispose: () => { panel.disposed = true; for (const cb of disposeHandlers) cb(); },
    onDidDispose: (cb: () => void) => { disposeHandlers.push(cb); return { dispose() {} }; },
  };
  return panel;
}
