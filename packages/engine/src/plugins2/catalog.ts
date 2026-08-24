/**
 * 516 — o que está instalado, lido do disco.
 *
 * ## Por que não há lockfile
 *
 * O lockfile antigo existia por uma razão só, e era boa: a instalação MESCLAVA entradas em arquivos
 * compartilhados do workspace — um servidor em `.mcp.json`, um bloco de hooks em `settings.json` —, e
 * só um registro sabe qual linha num arquivo de outra pessoa era nossa. Sem essas escritas, não
 * sobra nada que o disco não diga: `.tachyon/plugins/<nome>/tachyon-plugin.json` traz nome, versão e
 * descrição, e o payload ao lado traz as capacidades.
 *
 * Manter um índice "leve" seria manter uma segunda verdade. A spec 515 mediu o custo disso neste
 * mesmo workspace: o lockfile afirmava seis diretórios de skill materializados e o disco tinha um.
 * Um registro que pode divergir do disco vai divergir, e quando divergir será ele que mente.
 *
 * ## A leitura é tolerante a uma pasta ruim, e nunca silenciosa
 *
 * Um plugin que não carrega não derruba o catálogo — ele aparece como `broken`, com o motivo. Um
 * catálogo que engolisse a pasta quebrada mostraria um plugin a menos e nenhuma explicação, que é a
 * forma de erro que este projeto passou a sessão inteira recusando.
 */
import fs from "node:fs";
import path from "node:path";
import { loadPlugin, MANIFEST_FILE, type LoadedPlugin } from "./manifest.js";

/** Onde os payloads vivem, relativo à raiz do workspace. */
export const PLUGINS_REL = ".tachyon/plugins";

export interface BrokenPlugin {
  /** o nome do diretório, que é tudo o que se sabe quando o manifesto não lê. */
  dirName: string;
  errors: string[];
}

export interface Catalog {
  installed: LoadedPlugin[];
  broken: BrokenPlugin[];
}

export function pluginsRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, PLUGINS_REL);
}

export function pluginDir(workspaceRoot: string, name: string): string {
  return path.join(pluginsRoot(workspaceRoot), name);
}

/** Ler todo o catálogo. Um workspace sem plugins responde vazio, não erro. */
export function readCatalog(workspaceRoot: string): Catalog {
  const root = pluginsRoot(workspaceRoot);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { installed: [], broken: [] };
  }
  const installed: LoadedPlugin[] = [];
  const broken: BrokenPlugin[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (!fs.existsSync(path.join(dir, MANIFEST_FILE))) {
      broken.push({ dirName: entry.name, errors: [`no ${MANIFEST_FILE} — this directory is not a plugin`] });
      continue;
    }
    const loaded = loadPlugin(dir);
    if (!loaded.plugin) {
      broken.push({ dirName: entry.name, errors: loaded.errors });
      continue;
    }
    // O nome do diretório é o endereço; o do manifesto é a identidade. Divergirem significa que
    // alguém renomeou a pasta, e daí em diante a concessão apontaria para um lugar e o card falaria
    // de outro. Recusar é mais barato que escolher um dos dois.
    if (loaded.plugin.manifest.name !== entry.name) {
      broken.push({ dirName: entry.name, errors: [`directory is '${entry.name}' but the manifest says '${loaded.plugin.manifest.name}' — rename the directory to match`] });
      continue;
    }
    installed.push(loaded.plugin);
  }
  installed.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  broken.sort((a, b) => a.dirName.localeCompare(b.dirName));
  return { installed, broken };
}

/** Um plugin instalado, pelo nome. `undefined` quando não está instalado ou não carrega. */
export function readInstalled(workspaceRoot: string, name: string): LoadedPlugin | undefined {
  const dir = pluginDir(workspaceRoot, name);
  if (!fs.existsSync(path.join(dir, MANIFEST_FILE))) return undefined;
  const loaded = loadPlugin(dir);
  return loaded.plugin?.manifest.name === name ? loaded.plugin : undefined;
}
