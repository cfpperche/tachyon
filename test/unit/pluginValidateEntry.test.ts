/**
 * t-d8e772 / 516 — o validador que um autor de plugin roda de fora do Tachyon.
 *
 * A garantia que estes casos seguram é uma só, e é a razão do arquivo existir: **o validador usa O
 * carregador de verdade**, não uma cópia do schema. Uma segunda cópia divergiria, e um validador que
 * diverge é pior que nenhum — ele reporta verde enquanto a instalação recusa. O `verify-gate` 1.0.0
 * subiu ininstalável exatamente por não haver essa checagem.
 *
 * 516 — validar passou a olhar o PAYLOAD além do manifesto, porque no formato novo a posição dos
 * arquivos é a declaração: um pacote que não traz nada não entrega a ninguém, e o autor tem de saber
 * disso antes de publicar.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validatePluginDir } from "../../apps/vscode-extension/src/pluginValidateEntry.js";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const SKILL = "---\nname: demo\ndescription: demo\n---\nbody\n";

function pkg(manifest: unknown, files: Record<string, string> = { "skills/demo/SKILL.md": SKILL }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-validate-"));
  made.push(dir);
  fs.writeFileSync(path.join(dir, "tachyon-plugin.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const OK = { name: "demo", version: "1.0.0", description: "a demo plugin" };

describe("t-d8e772 / 516 — validar um pacote com o carregador de verdade", () => {
  it("aceita um pacote que o carregador aceita, e diz o que ele traz", () => {
    const r = validatePluginDir(pkg(OK));
    expect(r.ok).toBe(true);
    expect(r.name).toBe("demo");
    expect(r.carries).toEqual(["skill:demo"]);
    expect(r.runtimes).toEqual(["claude", "codex", "grok", "pi"]);
  });

  it("RECUSA um manifesto do formato antigo pelo nome do campo", () => {
    const r = validatePluginDir(pkg({ ...OK, tools: { x: {} } }));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/'tools'/);
  });

  it("RECUSA um pacote que não traz nada — publicar isso seria publicar o silêncio", () => {
    const r = validatePluginDir(pkg(OK, {}));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/carries nothing/);
  });

  it("RECUSA JSON inválido em vez de tratá-lo como vazio", () => {
    const r = validatePluginDir(pkg("{ isto não é json"));
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/could not read/);
  });

  it("RECUSA um diretório sem manifesto — silêncio para um arquivo ausente não prova nada", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-validate-"));
    made.push(dir);
    const r = validatePluginDir(dir);
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/could not read/);
  });

  it("usa O carregador de verdade, não uma cópia do schema", async () => {
    // A garantia inteira do arquivo. Se um dia alguém reimplementar a validação aqui, este caso quebra
    // quando o carregador mudar e o validador não — que é exatamente a divergência a evitar.
    const source = fs.readFileSync(path.resolve(__dirname, "../../apps/vscode-extension/src/pluginValidateEntry.ts"), "utf8");
    expect(source).toMatch(/import \{ loadPlugin \} from "@tachyon\/engine\/plugins\/manifest\.js"/);
    const { loadPlugin } = await import("@tachyon/engine/plugins/manifest.js");
    const dir = pkg({ ...OK, runtimes: ["claude"] }, { "extensions/x/index.ts": "export {}" });
    // O mesmo pacote, os mesmos erros: o validador não tem vocabulário próprio.
    expect(validatePluginDir(dir).errors).toEqual(loadPlugin(dir).errors);
  });
});
