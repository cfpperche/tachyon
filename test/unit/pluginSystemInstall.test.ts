/**
 * 516 fatia 2 — instalar é descompactar, desinstalar é apagar.
 *
 * O que estes testes seguram é a fronteira que a spec inteira defende: depois de instalar, o projeto
 * do humano está exatamente como estava. E a parte cuidadosa do módulo, que é a única: reinstalar
 * substitui sem abrir uma janela em que o plugin não existe.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { installFromZip, uninstall } from "@tachyon/engine/plugins/install.js";
import { readCatalog, pluginDir } from "@tachyon/engine/plugins/catalog.js";
import { MANIFEST_FILE } from "@tachyon/engine/plugins/manifest.js";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const SKILL = "---\nname: thing\ndescription: does a thing\n---\nbody\n";

/** Empacotar um plugin. `prefix` põe tudo sob uma pasta, que é a forma de um zip de release. */
async function zipOf(manifest: Record<string, unknown>, files: Record<string, string>, prefix = ""): Promise<string> {
  const zip = new JSZip();
  const at = (rel: string) => (prefix ? `${prefix}/${rel}` : rel);
  zip.file(at(MANIFEST_FILE), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) zip.file(at(rel), content);
  const out = path.join(temp("tachyon-516-zip-"), "plugin.zip");
  fs.writeFileSync(out, await zip.generateAsync({ type: "nodebuffer" }));
  return out;
}

const DEMO = { name: "demo", version: "1.0.0", description: "a demo plugin" };
const PAYLOAD = { "skills/thing/SKILL.md": SKILL };

function workspace(): string {
  const ws = temp("tachyon-516-ws-");
  for (const rel of [".claude", ".codex", ".grok"]) fs.mkdirSync(path.join(ws, rel), { recursive: true });
  return ws;
}

describe("516 — instalar não toca no projeto", () => {
  it("põe o payload em .tachyon/plugins e não cria nenhum diretório de runtime", async () => {
    const ws = workspace();
    const result = await installFromZip(ws, await zipOf(DEMO, PAYLOAD));
    expect(result.errors).toEqual([]);
    expect(result.plugin!.manifest.name).toBe("demo");
    expect(fs.readFileSync(path.join(ws, ".tachyon/plugins/demo/skills/thing/SKILL.md"), "utf8")).toBe(SKILL);
    for (const rel of [".claude/skills", ".agents/skills", ".grok/skills"]) {
      expect(fs.existsSync(path.join(ws, rel)), `${rel} não pode existir`).toBe(false);
    }
    // e nenhum arquivo de registro nasceu ao lado
    expect(fs.readdirSync(path.join(ws, ".tachyon"))).toEqual(["plugins"]);
  });

  it("aceita o zip de release, com tudo dentro de uma única pasta", async () => {
    const ws = workspace();
    const result = await installFromZip(ws, await zipOf(DEMO, PAYLOAD, "demo-1.0.0"));
    expect(result.errors).toEqual([]);
    expect(readCatalog(ws).installed.map((p) => p.manifest.name)).toEqual(["demo"]);
  });

  it("recusa um arquivo com dois plugins em vez de escolher um", async () => {
    const ws = workspace();
    const zip = new JSZip();
    for (const name of ["um", "dois"]) {
      zip.file(`${name}/${MANIFEST_FILE}`, JSON.stringify({ ...DEMO, name }));
      zip.file(`${name}/skills/thing/SKILL.md`, SKILL);
    }
    const out = path.join(temp("tachyon-516-zip-"), "dois.zip");
    fs.writeFileSync(out, await zip.generateAsync({ type: "nodebuffer" }));
    const result = await installFromZip(ws, out);
    expect(result.errors.join(" ")).toMatch(/carries 2 plugins/);
  });

  it("recusa um manifesto do formato antigo pelo nome do campo, e não deixa resíduo", async () => {
    const ws = workspace();
    const result = await installFromZip(ws, await zipOf({ ...DEMO, tools: { x: {} } }, PAYLOAD));
    expect(result.plugin).toBeUndefined();
    expect(result.errors.join(" ")).toMatch(/'tools'/);
    expect(readCatalog(ws).installed).toEqual([]);
    expect(fs.readdirSync(path.join(ws, ".tachyon/plugins"))).toEqual([]);
  });

  it("não deixa resíduo quando o arquivo não é um zip", async () => {
    const ws = workspace();
    const bogus = path.join(temp("tachyon-516-zip-"), "nope.zip");
    fs.writeFileSync(bogus, "isto não é um arquivo");
    const result = await installFromZip(ws, bogus);
    expect(result.plugin).toBeUndefined();
    expect(fs.readdirSync(path.join(ws, ".tachyon/plugins"))).toEqual([]);
  });
});

describe("516 — reinstalar substitui sem abrir uma janela", () => {
  it("troca o payload e reporta que substituiu", async () => {
    const ws = workspace();
    await installFromZip(ws, await zipOf(DEMO, PAYLOAD));
    const result = await installFromZip(ws, await zipOf({ ...DEMO, version: "2.0.0" }, { "skills/thing/SKILL.md": "novo corpo\n" }));
    expect(result.replaced).toBe(true);
    expect(result.plugin!.manifest.version).toBe("2.0.0");
    expect(fs.readFileSync(path.join(ws, ".tachyon/plugins/demo/skills/thing/SKILL.md"), "utf8")).toBe("novo corpo\n");
  });

  it("uma skill que a nova versão não traz mais some junto com o payload antigo", async () => {
    // A troca é do diretório inteiro, então não existe "resíduo da versão anterior" para limpar.
    const ws = workspace();
    await installFromZip(ws, await zipOf(DEMO, { ...PAYLOAD, "skills/velha/SKILL.md": SKILL }));
    expect(fs.existsSync(path.join(ws, ".tachyon/plugins/demo/skills/velha"))).toBe(true);
    await installFromZip(ws, await zipOf({ ...DEMO, version: "2.0.0" }, PAYLOAD));
    expect(fs.existsSync(path.join(ws, ".tachyon/plugins/demo/skills/velha"))).toBe(false);
  });

  it("uma instalação recusada deixa a anterior de pé", async () => {
    const ws = workspace();
    await installFromZip(ws, await zipOf(DEMO, PAYLOAD));
    const result = await installFromZip(ws, await zipOf({ ...DEMO, version: "nao-e-semver" }, PAYLOAD));
    expect(result.plugin).toBeUndefined();
    const catalog = readCatalog(ws);
    expect(catalog.installed.map((p) => p.manifest.version)).toEqual(["1.0.0"]);
    expect(catalog.broken).toEqual([]);
  });

  it("não deixa temporário nem aposentado visíveis no catálogo", async () => {
    const ws = workspace();
    await installFromZip(ws, await zipOf(DEMO, PAYLOAD));
    await installFromZip(ws, await zipOf({ ...DEMO, version: "2.0.0" }, PAYLOAD));
    expect(fs.readdirSync(path.join(ws, ".tachyon/plugins"))).toEqual(["demo"]);
  });
});

describe("516 — desinstalar é apagar a pasta", () => {
  it("remove o payload e nada mais precisou ser consultado", async () => {
    const ws = workspace();
    await installFromZip(ws, await zipOf(DEMO, PAYLOAD));
    expect(uninstall(ws, "demo")).toEqual({ removed: true, errors: [] });
    expect(fs.existsSync(pluginDir(ws, "demo"))).toBe(false);
    expect(readCatalog(ws).installed).toEqual([]);
  });

  it("remover o que já não está é o estado desejado, não um erro", () => {
    expect(uninstall(workspace(), "ausente")).toEqual({ removed: false, errors: [] });
  });

  it("recusa um nome que escaparia da pasta de plugins", () => {
    const ws = workspace();
    const alvo = path.join(ws, ".tachyon", "agents");
    fs.mkdirSync(alvo, { recursive: true });
    for (const nome of ["../agents", "a/b", "..", "."]) {
      expect(uninstall(ws, nome).removed, nome).toBe(false);
    }
    expect(fs.existsSync(alvo)).toBe(true);
  });
});
