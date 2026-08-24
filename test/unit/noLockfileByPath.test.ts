/**
 * 516 — nada lê o lockfile, e isso não é o compilador que garante.
 *
 * A fatia 4 apagou o módulo do lockfile e o `tsc` ficou verde. Mesmo assim o Agent Studio passou a
 * dizer "nenhum plugin instalado" com um plugin instalado na tela ao lado: `agentCapabilityCandidates`
 * lia `.tachyon/plugins.lock.json` por CAMINHO LITERAL e `JSON.parse`, sem importar nada — e um
 * caminho numa string é exatamente o que uma checagem de tipos não enxerga.
 *
 * O apagamento foi verificado por quem não conseguia ver a coisa que sobrou. Este teste é a checagem
 * que faltava, e ela é do tamanho do problema: uma busca por um nome de arquivo.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const ROOTS = ["packages/engine/src", "packages/bridge/src", "packages/shared/src", "packages/webview-ui/src", "apps/vscode-extension/src"];

function sources(dir: string): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(full);
    return /\.[cm]?tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe("516 — o lockfile de plugins não é lido por ninguém", () => {
  it("nenhum arquivo de produto menciona plugins.lock.json", () => {
    const offenders: string[] = [];
    for (const rel of ROOTS) {
      for (const file of sources(path.join(ROOT, rel))) {
        const text = fs.readFileSync(file, "utf8");
        if (!text.includes("plugins.lock.json")) continue;
        // Uma MENÇÃO em comentário é história e pode ficar; o que não pode é o nome dentro de uma
        // string de código, que é como um leitor se disfarça de nada para o compilador.
        const inCode = text
          .split("\n")
          .filter((line) => line.includes("plugins.lock.json"))
          .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
        if (inCode.length > 0) offenders.push(`${path.relative(ROOT, file)}: ${inCode[0]!.trim().slice(0, 100)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("o catálogo é a única porta para saber o que está instalado", () => {
    // Contrapartida positiva: apagar o leitor não pode passar neste arquivo apagando a leitura. Quem
    // responde "o que está instalado" tem de existir e vir do catálogo.
    const candidates = fs.readFileSync(path.join(ROOT, "packages/engine/src/config/agentCapabilityCandidates.ts"), "utf8");
    expect(candidates).toContain("readCatalog");
    expect(candidates).toContain("grantableReferences");
    // E o `.gitignore` que o produto escreve não abre exceção para um arquivo que não existe mais.
    const init = fs.readFileSync(path.join(ROOT, "apps/vscode-extension/src/init/initLogic.ts"), "utf8");
    expect(init).not.toMatch(/^\s*"!\.tachyon\/plugins\.lock\.json"/m);
  });
});
