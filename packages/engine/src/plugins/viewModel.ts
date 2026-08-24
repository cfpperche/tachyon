/**
 * 516 — o que a aba Plugins mostra.
 *
 * ## Por que este arquivo é curto
 *
 * O modelo antigo carregava seis estados de frescor — `up-to-date`, `update-available`,
 * `source-changed`, `drift`, `conflict`, `error` — porque um plugin vinha de um endereço remoto que
 * podia ter mudado embaixo dele. Sem origem remota não há frescor a exibir: o que está instalado é o
 * que o humano instalou, e a única pergunta que resta é o que ele traz.
 *
 * Some junto a distinção entre "instalado" e "aplicado": ela existia porque instalar escrevia no
 * projeto e o humano precisava de um segundo passo para consentir. Agora instalar não escreve em
 * lugar nenhum e a entrega é decidida na concessão, por agente — que é outra tela.
 *
 * PURO de propósito: sem fs, sem vscode. O host lê o catálogo e passa; toda derivação de exibição
 * fica testável fora do editor.
 */
import type { CapabilityKind, LoadedPlugin, Runtime } from "./manifest.js";
import type { Catalog } from "./catalog.js";

/** Uma família de capacidade como o card a resume: "3 skills", "1 prompt". */
export interface CapabilitySummaryVM {
  kind: CapabilityKind | "hooks" | "mcp";
  /** os nomes, em ordem — vazio para `hooks`/`mcp`, que não são nomeados. */
  names: string[];
  label: string;
}

export interface InstalledPluginVM {
  name: string;
  version: string;
  description: string;
  docs?: string;
  /** os runtimes que este plugin serve de fato. */
  runtimes: Runtime[];
  capabilities: CapabilitySummaryVM[];
  /** ferramentas externas declaradas. A presença é medida pelo host; ausente = não medido. */
  requires: Array<{ name: string; present?: boolean }>;
}

export interface BrokenPluginVM {
  dirName: string;
  errors: string[];
}

export interface PluginsViewModel {
  installed: InstalledPluginVM[];
  /** uma pasta que não carrega aparece aqui, com o motivo — nunca some da lista em silêncio. */
  broken: BrokenPluginVM[];
}

const PLURAL: Record<CapabilityKind, [string, string]> = {
  skill: ["skill", "skills"],
  extension: ["extension", "extensions"],
  prompt: ["prompt", "prompts"],
  theme: ["theme", "themes"],
  package: ["package", "packages"],
};

function summarize(plugin: LoadedPlugin): CapabilitySummaryVM[] {
  const out: CapabilitySummaryVM[] = [];
  for (const [kind, [one, many]] of Object.entries(PLURAL) as Array<[CapabilityKind, [string, string]]>) {
    const names = plugin.capabilities.filter((c) => c.kind === kind).map((c) => c.name);
    if (names.length === 0) continue;
    out.push({ kind, names, label: `${names.length} ${names.length === 1 ? one : many}` });
  }
  const hookRuntimes = Object.keys(plugin.hooks) as Runtime[];
  if (hookRuntimes.length > 0) {
    out.push({ kind: "hooks", names: [], label: `hooks for ${hookRuntimes.sort().join(", ")}` });
  }
  if (plugin.mcp) out.push({ kind: "mcp", names: [], label: "an MCP server" });
  return out;
}

export interface BuildInput {
  catalog: Catalog;
  /** presença medida das ferramentas externas, por nome. Ausente = o host não mediu. */
  toolPresence?: Record<string, boolean>;
}

export function buildPluginsViewModel({ catalog, toolPresence }: BuildInput): PluginsViewModel {
  return {
    installed: catalog.installed.map((plugin) => ({
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      description: plugin.manifest.description,
      ...(plugin.manifest.docs ? { docs: plugin.manifest.docs } : {}),
      runtimes: plugin.runtimes,
      capabilities: summarize(plugin),
      requires: (plugin.manifest.requires ?? []).map((name) => ({
        name,
        // Só afirma presença quando alguém mediu. Um `false` por omissão diria "não está instalado"
        // sobre uma pergunta que ninguém fez.
        ...(toolPresence && name in toolPresence ? { present: toolPresence[name]! } : {}),
      })),
    })),
    broken: catalog.broken.map((b) => ({ dirName: b.dirName, errors: b.errors })),
  };
}
