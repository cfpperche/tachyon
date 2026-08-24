/**
 * 516 fatia 1 — o disco como registro.
 *
 * A tese que estes testes seguram é a que apagou o lockfile: tudo o que precisa ser sabido sobre o
 * que está instalado está em `.tachyon/plugins/`, e um segundo registro só poderia divergir. O que
 * vale testar, então, não é "ele lê uma pasta" — é o que ele faz quando uma pasta está errada, que é
 * onde um catálogo mente com mais facilidade.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readCatalog, readInstalled, pluginDir } from "@tachyon/engine/plugins/catalog.js";
import { MANIFEST_FILE } from "@tachyon/engine/plugins/manifest.js";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function workspace(): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-516-ws-"));
  made.push(ws);
  return ws;
}

const SKILL = "---\nname: thing\ndescription: does a thing\n---\nbody\n";

/** Instalar à mão: é literalmente descompactar uma pasta, que é toda a instalação deste sistema. */
function install(ws: string, name: string, manifest: Record<string, unknown> = {}, payload: Record<string, string> = { "skills/thing/SKILL.md": SKILL }): string {
  const dir = pluginDir(ws, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ name, version: "1.0.0", description: `${name} does things`, ...manifest }));
  for (const [rel, content] of Object.entries(payload)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

describe("516 — o catálogo é o disco", () => {
  it("um workspace sem plugins responde vazio, não erro", () => {
    expect(readCatalog(workspace())).toEqual({ installed: [], broken: [] });
  });

  it("lê o que está lá, em ordem, sem consultar nenhum índice", () => {
    const ws = workspace();
    install(ws, "zeta");
    install(ws, "alfa");
    const catalog = readCatalog(ws);
    expect(catalog.installed.map((p) => p.manifest.name)).toEqual(["alfa", "zeta"]);
    expect(catalog.broken).toEqual([]);
    // e nenhum arquivo de registro foi criado ao lado
    expect(fs.readdirSync(path.join(ws, ".tachyon")).sort()).toEqual(["plugins"]);
  });

  it("desinstalar é apagar a pasta, e nada mais precisa saber disso", () => {
    const ws = workspace();
    install(ws, "some");
    fs.rmSync(pluginDir(ws, "some"), { recursive: true, force: true });
    expect(readCatalog(ws).installed).toEqual([]);
    expect(readInstalled(ws, "some")).toBeUndefined();
  });
});

describe("516 — uma pasta ruim aparece como quebrada, nunca como ausente", () => {
  it("mostra o motivo quando o manifesto não carrega", () => {
    const ws = workspace();
    install(ws, "bom");
    const ruim = pluginDir(ws, "ruim");
    fs.mkdirSync(ruim, { recursive: true });
    fs.writeFileSync(path.join(ruim, MANIFEST_FILE), "{ isto não é json");

    const catalog = readCatalog(ws);
    expect(catalog.installed.map((p) => p.manifest.name)).toEqual(["bom"]);
    expect(catalog.broken).toHaveLength(1);
    expect(catalog.broken[0]!.dirName).toBe("ruim");
    expect(catalog.broken[0]!.errors.join(" ")).toMatch(/could not read/);
  });

  it("uma pasta sem manifesto diz que não é um plugin, em vez de sumir", () => {
    const ws = workspace();
    fs.mkdirSync(path.join(ws, ".tachyon/plugins/sobra"), { recursive: true });
    const catalog = readCatalog(ws);
    expect(catalog.installed).toEqual([]);
    expect(catalog.broken[0]!.errors.join(" ")).toMatch(/not a plugin/);
  });

  it("recusa quando renomearam a pasta: o endereço e a identidade têm de ser o mesmo nome", () => {
    // A concessão aponta para `.tachyon/plugins/<nome>/…`. Se a pasta diz uma coisa e o manifesto
    // outra, escolher qualquer um dos dois faz o card falar de um plugin e a entrega ir a outro.
    const ws = workspace();
    install(ws, "original");
    fs.renameSync(pluginDir(ws, "original"), pluginDir(ws, "renomeado"));
    const catalog = readCatalog(ws);
    expect(catalog.installed).toEqual([]);
    expect(catalog.broken[0]!.errors.join(" ")).toMatch(/directory is 'renomeado' but the manifest says 'original'/);
    expect(readInstalled(ws, "renomeado")).toBeUndefined();
  });

  it("um plugin quebrado não derruba os outros", () => {
    const ws = workspace();
    install(ws, "um");
    install(ws, "dois");
    fs.writeFileSync(path.join(pluginDir(ws, "um"), MANIFEST_FILE), "{");
    const catalog = readCatalog(ws);
    expect(catalog.installed.map((p) => p.manifest.name)).toEqual(["dois"]);
    expect(catalog.broken.map((b) => b.dirName)).toEqual(["um"]);
  });
});
