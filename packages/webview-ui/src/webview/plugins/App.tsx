/**
 * 516 — a aba Plugins.
 *
 * ## O que sumiu da tela, e por quê
 *
 * O card antigo carregava seis estados de frescor, um par instalado/aplicado, uma gaveta de
 * consentimento com aceite por runtime, decisões Keep/Replace por skill em colisão, botões de
 * atualizar, reinstalar, checar atualização, reparar hooks e reidratar ferramentas.
 *
 * Nenhum deles sobrevive a duas mudanças: não há origem remota (então não há frescor a exibir) e
 * instalar não escreve no projeto (então não há colisão, nem um segundo passo para aplicar o que
 * ainda não foi aplicado). O que a tela faz agora é o que o sistema faz: mostrar o que está
 * instalado e o que cada um traz, instalar um arquivo, remover, abrir a documentação.
 *
 * ## Quem recebe o quê não está aqui
 *
 * Um card diz quais runtimes um plugin PODE servir — propriedade do payload. Quem de fato recebe é
 * decisão por agente e mora no Agent Studio, junto do resto do que aquele agente recebeu. Repetir a
 * concessão aqui daria duas telas para uma decisão, que foi exatamente o desenho que a spec 515
 * gastou uma fatia desfazendo.
 */
import { Badge, Button, EmptyState, Icon, PageChrome, PathPicker, type PathPickerListing } from "../shared/ui";
import type { InstalledPluginVM, PluginsViewModel } from "@tachyon/engine/plugins2/viewModel.js";

export interface PluginsDispatch {
  refresh(): void;
  /** abrir o seletor de arquivo do produto. */
  install(): void;
  browseZips(dir: string): void;
  systemBrowseZip(): void;
  installFrom(zipPath: string): void;
  closeZips(): void;
  remove(name: string): void;
  openDocs(name: string): void;
}

/** 516 — tudo o que o seletor precisa, num objeto que o host substitui inteiro. */
export interface ZipPickerState {
  candidates: Array<{ path: string; name: string; dir: string }>;
  roots: string[];
  listing?: PathPickerListing;
  error?: string;
}

function Card({ plugin, dispatch }: { plugin: InstalledPluginVM; dispatch: PluginsDispatch }) {
  return (
    <div class="ds-card pcard" data-testid={`plugin-${plugin.name}`}>
      <div class="pcard-head">
        <span class="pname">{plugin.name}</span>
        <span class="pver">v{plugin.version}</span>
        <span class="pcard-actions">
          {plugin.docs ? <Button icon="book" onClick={() => dispatch.openDocs(plugin.name)}>Docs</Button> : null}
          <Button icon="trash" onClick={() => dispatch.remove(plugin.name)}>Remove</Button>
        </span>
      </div>
      <div class="pdesc">{plugin.description}</div>
      <div class="pmeta">
        {/* O que ele TRAZ, que é a única pergunta que sobrou sobre um plugin instalado. */}
        {plugin.capabilities.map((capability) => (
          <Badge key={capability.kind} title={capability.names.join(", ")}>{capability.label}</Badge>
        ))}
        <span class="pruntimes">
          {plugin.runtimes.map((runtime) => <span key={runtime} class="prt">{runtime}</span>)}
        </span>
      </div>
      {plugin.requires.length > 0 ? (
        <div class="prequires">
          {plugin.requires.map((tool) => (
            <span key={tool.name} class={`ptool${tool.present === false ? " is-missing" : ""}`}>
              <Icon name={tool.present === false ? "warning" : tool.present === true ? "check" : "circle-outline"} />
              {tool.name}
              {/* Sem medição, não se afirma nada: "não medido" e "ausente" não são a mesma coisa. */}
              {tool.present === false ? " — install it and it becomes available" : ""}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function App({ vm, busy, zips, dispatch }: { vm?: PluginsViewModel; busy?: string; zips?: ZipPickerState; dispatch: PluginsDispatch }) {
  return (
    <div class="ck-plugins-root ds-page">
      <PageChrome
        title="Plugins"
        hint="A plugin extends what an agent can do. Install one, then grant it to an agent in Agent Studio."
        actions={<Button icon="file-zip" onClick={() => dispatch.install()}>Install from zip</Button>}
      />

      <div class="plist">
        {!vm ? (
          <EmptyState message="Reading the catalogue…" />
        ) : vm.installed.length === 0 && vm.broken.length === 0 ? (
          <EmptyState message={<>No plugins installed.<br />Install one from a <span class="ds-mono">.zip</span> on this machine.</>} />
        ) : (
          <>
            {vm.installed.map((plugin) => <Card key={plugin.name} plugin={plugin} dispatch={dispatch} />)}
            {/* Uma pasta que não carrega aparece com o motivo. Sumir em silêncio faria o humano
                procurar um plugin que está lá e não pôde ser lido. */}
            {vm.broken.map((broken) => (
              <div key={broken.dirName} class="ds-card pcard is-broken" data-testid={`broken-${broken.dirName}`}>
                <div class="pcard-head">
                  <span class="pname"><Icon name="error" /> {broken.dirName}</span>
                  <span class="pcard-actions"><Button icon="trash" onClick={() => dispatch.remove(broken.dirName)}>Remove</Button></span>
                </div>
                <div class="pdesc">{broken.errors.join(" · ")}</div>
              </div>
            ))}
          </>
        )}
      </div>

      {zips ? (
        <PathPicker
          open
          data-testid="plugin-zip-picker"
          title="Install a plugin"
          subtitle={zips.error ? `Could not read the workspace: ${zips.error}` : "Choose the .zip to install. Reinstalling replaces what is there."}
          suggestions={zips.candidates.map((c) => ({ name: c.name, path: c.path, kind: "zip" as const }))}
          listing={zips.listing}
          onBrowse={(dir) => dispatch.browseZips(dir)}
          onSystemBrowse={() => dispatch.systemBrowseZip()}
          onClose={() => dispatch.closeZips()}
          onSelect={(filePath) => dispatch.installFrom(filePath)}
        />
      ) : null}
      {busy ? <div class="busy"><span class="codicon codicon-loading" /> {busy}</div> : null}
    </div>
  );
}
