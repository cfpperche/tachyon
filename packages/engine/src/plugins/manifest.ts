/**
 * 516 — o que um plugin declara, e o que ele apenas mostra.
 *
 * ## A regra que encolheu o manifesto
 *
 * O manifesto antigo tinha nove campos, e quase todos existiam para dizer onde as coisas estavam:
 * `blocks` apontava a pasta de hooks, `config` apontava o arquivo de config, `tools` e `data`
 * descreviam downloads. Aqui a posição no payload É a declaração — `skills/x/` é a skill `x`, e não
 * há campo que diga isso. Sobram os seis fatos que nenhum diretório consegue afirmar: quem é o
 * plugin, que versão, o que faz, onde se lê sobre ele, para quais runtimes o autor o escreveu, e de
 * que ferramenta externa ele depende.
 *
 * ## Quem consegue consumir o quê não é escolha nossa
 *
 * Cada família pertence aos runtimes que sabem lê-la, e isso é propriedade medida dos runtimes, não
 * uma tabela de gosto: skills os quatro consomem; `extensions`, `prompts`, `themes` e `packages` são
 * vocabulário do pi (medido em 0.84.2 — `--extension`, `--prompt-template`, `--theme`); hooks
 * nativos e servidores MCP existem em claude, codex e grok e não na materialização do pi.
 *
 * Por isso `runtimes` é OPCIONAL: ausente significa "todos os que conseguem consumir o que este
 * payload traz", que é a resposta certa para a forma comum (um plugin só de skills serve os quatro).
 * Declarar passa a ser um estreitamento deliberado do autor — "esta skill é escrita no idioma do
 * codex" —, informação que o payload não tem como dizer sozinho.
 *
 * ## As recusas são pelo nome
 *
 * Um manifesto do formato antigo não é lido pela metade e não é "quase compatível": cada campo que
 * saiu recusa o plugin dizendo o que fazer no lugar. Um plugin do catálogo antigo instalado por
 * acidente com metade das capacidades silenciosamente ausentes seria pior do que não instalar.
 */
import fs from "node:fs";
import path from "node:path";

export const RUNTIMES = ["claude", "codex", "grok", "pi"] as const;
export type Runtime = (typeof RUNTIMES)[number];

export const MANIFEST_FILE = "tachyon-plugin.json";

/** A família de capacidade, e os runtimes que sabem consumi-la. */
/**
 * As famílias, e a FORMA de cada uma no payload.
 *
 * `file` está aqui porque duas delas não são diretórios e nunca foram: o pi recebe um prompt como um
 * `.md` e um tema como um `.json`, e é isso que ele passa em `--prompt-template` / `--theme`. O
 * resolvedor de perfil exige exatamente isso desde a 428 (`type === "file"` e a extensão certa).
 *
 * A 516 nasceu com "toda capacidade é um diretório nomeado", o que é verdade para skill, extensão e
 * pacote — e falso para as duas de dado. O descasamento só apareceu quando um plugin foi concedido a
 * um agente pi pela primeira vez, em 2026-08-24, e o resolvedor recusou um prompt que era pasta.
 * Forçar as duas a virarem diretório significaria mexer no resolvedor E na entrega para desembrulhar
 * de novo; deixá-las serem o que já são não mexe em nenhum dos dois.
 */
export const CAPABILITY_KINDS = {
  skill: { dir: "skills", runtimes: ["claude", "codex", "grok", "pi"] },
  extension: { dir: "extensions", runtimes: ["pi"] },
  prompt: { dir: "prompts", runtimes: ["pi"], file: ".md" },
  theme: { dir: "themes", runtimes: ["pi"], file: ".json" },
  package: { dir: "packages", runtimes: ["pi"] },
} as const satisfies Record<string, { dir: string; runtimes: readonly Runtime[]; file?: string }>;

export type CapabilityKind = keyof typeof CAPABILITY_KINDS;

/** Campos do formato antigo, e o que fazer no lugar de cada um. */
const RETIRED_FIELDS: Record<string, string> = {
  tools: "Tachyon não baixa mais binário — declare a ferramenta em `requires` e o operador a instala",
  data: "Tachyon não baixa mais artefato — traga o arquivo no payload ou declare a ferramenta em `requires`",
  externalTools: "renomeado para `requires`, e agora é uma lista de nomes",
  blocks: "os hooks nativos vivem em `hooks/<runtime>/` por convenção",
  gitHooks: "git hooks saem da v1 e voltam como um sistema próprio",
  dependencies: "sem resolvedor de dependência: diga na `description` o que precisa ser instalado antes",
  docsUrl: "renomeado para `docs`",
  config: "o arquivo que o humano edita vive em `config/` por convenção",
};

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  /** onde se lê sobre o plugin. */
  docs?: string;
  /** estreitamento deliberado do autor; ausente = todos os que consomem o payload. */
  runtimes?: Runtime[];
  /** ferramentas externas que precisam existir no PATH. Detectadas, nunca instaladas. */
  requires?: string[];
}

/** Uma capacidade encontrada no payload — a posição é a declaração. */
export interface PluginCapability {
  kind: CapabilityKind;
  name: string;
  /** caminho relativo à raiz do plugin. */
  rel: string;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  /** raiz absoluta do plugin no disco. */
  dir: string;
  capabilities: PluginCapability[];
  /** hooks nativos por runtime, de `hooks/<runtime>/`. */
  hooks: Partial<Record<Runtime, string>>;
  /** verdadeiro quando o payload traz um `mcp.json`. */
  mcp: boolean;
  /** os runtimes que este plugin de fato serve: declarados ∩ capazes, ou capazes quando não declarado. */
  runtimes: Runtime[];
}

export interface LoadResult {
  plugin?: LoadedPlugin;
  errors: string[];
}

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** Runtimes com hooks nativos e MCP — o pi materializa nem um nem outro (medido no HarnessManager). */
const HOOK_RUNTIMES: readonly Runtime[] = ["claude", "codex", "grok"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Ler e validar o manifesto de `dir`, sem olhar o payload. */
export function parseManifest(raw: unknown): { manifest?: PluginManifest; errors: string[] } {
  const errors: string[] = [];
  if (!isObject(raw)) return { errors: [`${MANIFEST_FILE} must be a JSON object`] };

  for (const [field, guidance] of Object.entries(RETIRED_FIELDS)) {
    if (field in raw) errors.push(`'${field}' is not a field in this format — ${guidance}`);
  }

  const name = raw.name;
  if (typeof name !== "string" || !NAME.test(name)) {
    errors.push("'name' must be lowercase words joined by hyphens (e.g. agent-browser)");
  }
  const version = raw.version;
  if (typeof version !== "string" || !SEMVER.test(version)) errors.push("'version' must be a semver string (e.g. 1.0.0)");
  const description = raw.description;
  if (typeof description !== "string" || description.trim().length === 0) {
    errors.push("'description' must say what the plugin does — it is the only thing a human reads before installing");
  }

  const docs = raw.docs;
  if (docs !== undefined && (typeof docs !== "string" || !/^https:\/\//.test(docs))) {
    errors.push("'docs' must be an https URL");
  }

  let runtimes: Runtime[] | undefined;
  if (raw.runtimes !== undefined) {
    if (!Array.isArray(raw.runtimes) || raw.runtimes.length === 0) {
      errors.push("'runtimes' must be a non-empty array, or absent to mean every runtime that can consume the payload");
    } else {
      const unknown = raw.runtimes.filter((r): r is string => typeof r === "string" && !RUNTIMES.includes(r as Runtime));
      const wrongType = raw.runtimes.filter((r) => typeof r !== "string");
      if (wrongType.length > 0) errors.push("'runtimes' must be an array of strings");
      if (unknown.length > 0) errors.push(`unknown runtime(s) ${unknown.join(", ")} — known: ${RUNTIMES.join(", ")}`);
      if (unknown.length === 0 && wrongType.length === 0) runtimes = [...new Set(raw.runtimes as Runtime[])].sort();
    }
  }

  let requires: string[] | undefined;
  if (raw.requires !== undefined) {
    if (!Array.isArray(raw.requires) || raw.requires.some((r) => typeof r !== "string" || r.trim().length === 0)) {
      errors.push("'requires' must be an array of external tool names");
    } else {
      requires = [...new Set(raw.requires as string[])].sort();
    }
  }

  const known = new Set(["name", "version", "description", "docs", "runtimes", "requires"]);
  const strays = Object.keys(raw).filter((k) => !known.has(k) && !(k in RETIRED_FIELDS));
  if (strays.length > 0) errors.push(`unknown field(s) ${strays.join(", ")} — this format has ${[...known].join(", ")}`);

  if (errors.length > 0) return { errors };
  return {
    manifest: {
      name: name as string,
      version: version as string,
      description: (description as string).trim(),
      ...(typeof docs === "string" ? { docs } : {}),
      ...(runtimes ? { runtimes } : {}),
      ...(requires ? { requires } : {}),
    },
    errors: [],
  };
}

/** Entradas de um diretório de família: um subdiretório, ou um arquivo nas famílias que são arquivo. */
function readFamily(dir: string, kind: CapabilityKind, errors: string[]): PluginCapability[] {
  const familyDir = CAPABILITY_KINDS[kind].dir;
  const fileExt: string | undefined = (CAPABILITY_KINDS[kind] as { file?: string }).file;
  const root = path.join(dir, familyDir);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // família ausente é o caso comum, não um erro
  }
  const found: PluginCapability[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (fileExt) {
      // Família de dado: a capacidade é o arquivo, e o nome é o basename sem a extensão.
      if (!entry.isFile() || !entry.name.endsWith(fileExt)) continue;
      const name = entry.name.slice(0, -fileExt.length);
      if (!NAME.test(name)) {
        errors.push(`${familyDir}/${entry.name}: a capability name must be lowercase words joined by hyphens`);
        continue;
      }
      found.push({ kind, name, rel: `${familyDir}/${entry.name}` });
      continue;
    }
    if (!entry.isDirectory()) continue; // um arquivo solto numa família de árvore não é uma capacidade nomeada
    if (!NAME.test(entry.name)) {
      errors.push(`${familyDir}/${entry.name}: a capability name must be lowercase words joined by hyphens`);
      continue;
    }
    found.push({ kind, name: entry.name, rel: `${familyDir}/${entry.name}` });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Carregar o plugin em `dir`: manifesto + o que o payload traz.
 *
 * O conjunto de runtimes servidos é a interseção do que o autor declarou com o que as famílias
 * presentes conseguem alimentar. Se a interseção for vazia, o plugin é recusado nomeando as duas
 * pontas — é um erro de autoria (um payload só de `extensions/` com `runtimes: ["claude"]` não
 * entrega nada a ninguém, e instalar isso seria instalar o silêncio).
 */
export function loadPlugin(dir: string): LoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8"));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { errors: [`could not read ${MANIFEST_FILE}: ${why}`] };
  }
  const parsed = parseManifest(raw);
  if (!parsed.manifest) return { errors: parsed.errors };

  const errors: string[] = [];
  const capabilities = (Object.keys(CAPABILITY_KINDS) as CapabilityKind[]).flatMap((kind) => readFamily(dir, kind, errors));

  const hooks: Partial<Record<Runtime, string>> = {};
  for (const runtime of HOOK_RUNTIMES) {
    const rel = `hooks/${runtime}`;
    try {
      if (fs.statSync(path.join(dir, rel)).isDirectory()) hooks[runtime] = rel;
    } catch { /* ausente */ }
  }

  let mcp = false;
  try { mcp = fs.statSync(path.join(dir, "mcp.json")).isFile(); } catch { /* ausente */ }

  const capable = new Set<Runtime>();
  for (const capability of capabilities) for (const rt of CAPABILITY_KINDS[capability.kind].runtimes) capable.add(rt);
  for (const rt of Object.keys(hooks) as Runtime[]) capable.add(rt);
  if (mcp) for (const rt of HOOK_RUNTIMES) capable.add(rt);

  if (capable.size === 0) {
    errors.push(`plugin '${parsed.manifest.name}' carries nothing — expected at least one of ${Object.values(CAPABILITY_KINDS).map((k) => `${k.dir}/`).join(", ")}, hooks/<runtime>/, or mcp.json`);
  }

  const declared = parsed.manifest.runtimes;
  const served = declared ? declared.filter((rt) => capable.has(rt)) : [...capable].sort();
  if (declared && served.length === 0 && capable.size > 0) {
    errors.push(`plugin '${parsed.manifest.name}' declares runtimes ${declared.join(", ")} but its payload only feeds ${[...capable].sort().join(", ")} — nothing would be delivered`);
  }

  if (errors.length > 0) return { errors };
  return { plugin: { manifest: parsed.manifest, dir, capabilities, hooks, mcp, runtimes: served }, errors: [] };
}
