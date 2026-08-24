/**
 * 516 — instalar é descompactar; desinstalar é apagar.
 *
 * ## O que este módulo não faz, e é o ponto
 *
 * Não resolve endereço, não clona em tag fixada, não confere checksum, não calcula impressão digital
 * de payload, não planeja alvos, não detecta colisão, não pede aceite por runtime, não escreve
 * registro e não guarda ancestrais criados. Todas essas coisas existiam porque a instalação escrevia
 * dentro do projeto do humano — e uma escrita em arquivo compartilhado precisa saber de onde veio,
 * com o que colidiu e como voltar atrás.
 *
 * Uma pasta em `.tachyon/plugins/<nome>/` não precisa de nada disso. Ela não colide com nada, não se
 * mistura a nada de ninguém, e desfazer é `rm -rf`.
 *
 * ## A troca atômica, que é a única coisa cuidadosa aqui
 *
 * Reinstalar substitui, e a substituição passa por um diretório temporário ao lado: descompacta,
 * valida, e só então troca. Um `rm -rf` seguido de descompactar deixaria a janela em que o plugin
 * não existe — e é exatamente nessa janela que um agente subindo procuraria o payload que sua
 * concessão nomeia.
 */
import fs from "node:fs";
import path from "node:path";
import { extractZipContained } from "../files/extractZip.js";
import { loadPlugin, MANIFEST_FILE, type LoadedPlugin } from "./manifest.js";
import { pluginDir, pluginsRoot } from "./catalog.js";

export interface InstallResult {
  plugin?: LoadedPlugin;
  /** verdadeiro quando substituiu uma versão que já estava instalada. */
  replaced?: boolean;
  errors: string[];
}

/**
 * Instalar o zip em `zipPath`.
 *
 * O manifesto pode estar na raiz do arquivo ou dentro de UMA única pasta — que é o que todo "baixe
 * esta release" produz, e obrigar o humano a achatar isso seria passar a ele um detalhe do
 * empacotador. Duas pastas com manifesto é recusado pelos dois nomes, nunca adivinhado.
 */
export async function installFromZip(workspaceRoot: string, zipPath: string): Promise<InstallResult> {
  const root = pluginsRoot(workspaceRoot);
  fs.mkdirSync(root, { recursive: true });

  let staging: string;
  try {
    staging = fs.mkdtempSync(path.join(root, ".staging-"));
  } catch (error) {
    return { errors: [`could not stage the install: ${message(error)}`] };
  }

  try {
    try {
      await extractZipContained(zipPath, staging, "plugin");
    } catch (error) {
      return { errors: [`could not read '${path.basename(zipPath)}': ${message(error)}`] };
    }

    const payload = resolvePayloadRoot(staging);
    if (!payload.ok) return { errors: [payload.error] };

    const loaded = loadPlugin(payload.dir);
    if (!loaded.plugin) return { errors: loaded.errors };

    const name = loaded.plugin.manifest.name;
    const target = pluginDir(workspaceRoot, name);
    const replaced = fs.existsSync(target);

    // A troca: mover o novo para o lugar só depois que o antigo saiu, e o antigo sai para um nome
    // vizinho em vez de ser apagado — se o `rename` do novo falhar, o antigo ainda está ali para ser
    // devolvido, em vez de o plugin ter deixado de existir.
    // O nome do aposentado começa com ponto: o catálogo pula entradas assim, então nem uma leitura
    // concorrente durante a troca vê um "plugin quebrado" que é na verdade o antigo saindo de cena.
    const retired = replaced ? path.join(root, `.retired-${path.basename(staging)}`) : undefined;
    try {
      if (retired) fs.renameSync(target, retired);
      fs.renameSync(payload.dir, target);
    } catch (error) {
      if (retired && !fs.existsSync(target)) {
        try { fs.renameSync(retired, target); } catch { /* o erro original é o que importa */ }
      }
      return { errors: [`could not install '${name}': ${message(error)}`] };
    }
    if (retired) fs.rmSync(retired, { recursive: true, force: true });

    // Reler do lugar definitivo: o que o catálogo vai mostrar é este, não o do temporário.
    const installed = loadPlugin(target);
    if (!installed.plugin) return { errors: installed.errors };
    return { plugin: installed.plugin, ...(replaced ? { replaced: true } : {}), errors: [] };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export interface UninstallResult {
  /** verdadeiro quando havia algo para remover. Remover o que já não está é o estado desejado. */
  removed: boolean;
  errors: string[];
}

/** Desinstalar: apagar a pasta. Não há registro a consultar nem entrada a desfazer. */
export function uninstall(workspaceRoot: string, name: string): UninstallResult {
  const target = pluginDir(workspaceRoot, name);
  // `pluginDir` compõe com um nome que veio de fora; um `..` aqui apagaria fora da árvore.
  const expected = path.join(pluginsRoot(workspaceRoot), path.basename(target));
  if (path.resolve(target) !== path.resolve(expected)) {
    return { removed: false, errors: [`'${name}' is not a plugin name`] };
  }
  if (!fs.existsSync(target)) return { removed: false, errors: [] };
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    return { removed: false, errors: [`could not remove '${name}': ${message(error)}`] };
  }
  return { removed: true, errors: [] };
}

function resolvePayloadRoot(staging: string): { ok: true; dir: string } | { ok: false; error: string } {
  if (fs.existsSync(path.join(staging, MANIFEST_FILE))) return { ok: true, dir: staging };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(staging, { withFileTypes: true });
  } catch (error) {
    return { ok: false, error: `could not read the unpacked archive: ${message(error)}` };
  }
  const nested = entries
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(staging, entry.name, MANIFEST_FILE)))
    .map((entry) => entry.name);
  if (nested.length === 1) return { ok: true, dir: path.join(staging, nested[0]!) };
  if (nested.length > 1) {
    return { ok: false, error: `the archive carries ${nested.length} plugins (${nested.join(", ")}); it must carry exactly one` };
  }
  return { ok: false, error: `no ${MANIFEST_FILE} in the archive — a plugin zip carries it at the root, or inside a single folder` };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
