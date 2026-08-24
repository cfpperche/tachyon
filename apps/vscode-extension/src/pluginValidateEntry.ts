/**
 * t-d8e772 / 516 — validar um pacote de plugin com O parser que vai carregá-lo, de fora do Tachyon.
 *
 * A lacuna que isto fecha: um autor podia commitar, marcar e publicar um `tachyon-plugin.json` que o
 * Tachyon recusa carregar, e nada dizia isso até um humano tentar instalar. O `verify-gate` 1.0.0 subiu
 * assim e era ininstalável em todo ambiente.
 *
 * O repositório de plugins não tem toolchain de Node e o Tachyon não está no npm, então o lado do autor
 * não consegue importar o parser. Este entry é empacotado num `dist/plugin-validate.cjs` autônomo, para
 * que qualquer checkout o rode com `node` puro.
 *
 * Ele deliberadamente não reimplementa NADA: chama `loadPlugin`, a mesma função que a instalação chama.
 * Uma segunda cópia do schema iria divergir, e um validador que diverge é pior que nenhum — ele
 * reportaria verde enquanto o carregador de verdade recusa.
 *
 *   node dist/plugin-validate.cjs <plugin-dir> [mais-dirs...]
 *
 * Saída 0 = todo pacote carrega. Saída 1 = pelo menos um não, com os erros do próprio parser.
 *
 * 516 — validar passou a incluir o PAYLOAD, e não só o manifesto, porque no formato novo a posição dos
 * arquivos É a declaração: um pacote sem `skills/`, `prompts/`, `hooks/<runtime>/` nem `mcp.json` não
 * entrega nada a ninguém, e o autor tem de saber disso antes de publicar, não depois.
 */

import path from "node:path";
import { loadPlugin } from "@tachyon/engine/plugins/manifest.js";

interface Report {
  dir: string;
  ok: boolean;
  name?: string;
  version?: string;
  carries?: string[];
  runtimes?: string[];
  errors: string[];
}

export function validatePluginDir(dir: string): Report {
  const loaded = loadPlugin(path.resolve(dir));
  if (!loaded.plugin) return { dir, ok: false, errors: loaded.errors };
  const { manifest, capabilities, hooks, mcp, runtimes } = loaded.plugin;
  const carries = [
    ...capabilities.map((c) => `${c.kind}:${c.name}`),
    ...Object.keys(hooks).map((runtime) => `hooks:${runtime}`),
    ...(mcp ? ["mcp"] : []),
  ];
  return { dir, ok: true, name: manifest.name, version: manifest.version, carries, runtimes, errors: [] };
}

function main(argv: string[]): number {
  const dirs = argv.filter((a) => !a.startsWith("-"));
  if (dirs.length === 0) {
    process.stderr.write("usage: plugin-validate <plugin-dir> [more-dirs...]\n");
    return 2;
  }
  let bad = 0;
  for (const dir of dirs) {
    const r = validatePluginDir(dir);
    if (r.ok) {
      process.stdout.write(`ok    ${r.name}@${r.version}  serves [${r.runtimes?.join(", ")}]  carries ${r.carries?.join(", ")}  (${r.dir})\n`);
    } else {
      bad += 1;
      process.stderr.write(`FAIL  ${r.dir}\n`);
      for (const e of r.errors) process.stderr.write(`        ${e}\n`);
    }
  }
  if (bad > 0) {
    process.stderr.write(`\n${bad} of ${dirs.length} plugin package(s) would be REFUSED by Tachyon.\n`);
    return 1;
  }
  process.stdout.write(`${dirs.length} plugin package(s) load through Tachyon's own parser.\n`);
  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
