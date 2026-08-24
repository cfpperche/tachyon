/**
 * 516 fatia 2 — o que a aba mostra.
 *
 * O card antigo tinha seis estados de frescor e um par instalado/aplicado. Nenhum dos dois sobrevive
 * a "não há origem remota" e "instalar não escreve", então o que vale testar aqui é o que ficou: o
 * card diz o que o plugin TRAZ, e uma pasta quebrada aparece com o motivo em vez de sumir.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildPluginsViewModel } from "@tachyon/engine/plugins2/viewModel.js";
import { readCatalog } from "@tachyon/engine/plugins2/catalog.js";
import { MANIFEST_FILE } from "@tachyon/engine/plugins2/manifest.js";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const SKILL = "---\nname: x\ndescription: x\n---\nbody\n";

function workspace(plugins: Record<string, { manifest?: Record<string, unknown>; files: Record<string, string> }>): string {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-516-vm-"));
  made.push(ws);
  for (const [name, { manifest, files }] of Object.entries(plugins)) {
    const dir = path.join(ws, ".tachyon/plugins", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ name, version: "1.0.0", description: `${name} does things`, ...manifest }));
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }
  return ws;
}

const vmOf = (ws: string, toolPresence?: Record<string, boolean>) =>
  buildPluginsViewModel({ catalog: readCatalog(ws), ...(toolPresence ? { toolPresence } : {}) });

describe("516 — o card diz o que o plugin traz", () => {
  it("resume cada família com o plural certo e nomeia as capacidades", () => {
    const ws = workspace({ demo: { files: {
      "skills/uma/SKILL.md": SKILL,
      "skills/outra/SKILL.md": SKILL,
      "prompts/planejar/p.md": "x",
    } } });
    const card = vmOf(ws).installed[0]!;
    expect(card.capabilities.map((c) => c.label)).toEqual(["2 skills", "1 prompt"]);
    expect(card.capabilities[0]!.names).toEqual(["outra", "uma"]);
    expect(card.runtimes).toEqual(["claude", "codex", "grok", "pi"]);
  });

  it("hooks e MCP aparecem sem nome, porque não são nomeados", () => {
    const ws = workspace({ demo: { files: { "hooks/claude/h.json": "{}", "hooks/codex/h.json": "{}", "mcp.json": "{}" } } });
    const card = vmOf(ws).installed[0]!;
    expect(card.capabilities.map((c) => c.label)).toEqual(["hooks for claude, codex", "an MCP server"]);
  });

  it("não afirma presença de uma ferramenta que ninguém mediu", () => {
    // Um `present: false` por omissão diria "não está instalado" sobre uma pergunta que não foi feita.
    const ws = workspace({ demo: { manifest: { requires: ["ffmpeg", "chrome"] }, files: { "skills/x/SKILL.md": SKILL } } });
    expect(vmOf(ws).installed[0]!.requires).toEqual([{ name: "chrome" }, { name: "ffmpeg" }]);
    expect(vmOf(ws, { ffmpeg: true }).installed[0]!.requires).toEqual([{ name: "chrome" }, { name: "ffmpeg", present: true }]);
  });
});

describe("516 — uma pasta quebrada aparece, com o motivo", () => {
  it("não some da lista em silêncio", () => {
    const ws = workspace({ bom: { files: { "skills/x/SKILL.md": SKILL } } });
    fs.writeFileSync(path.join(ws, ".tachyon/plugins/bom/../ruim.json"), "x");
    fs.mkdirSync(path.join(ws, ".tachyon/plugins/ruim"), { recursive: true });
    const vm = vmOf(ws);
    expect(vm.installed.map((p) => p.name)).toEqual(["bom"]);
    expect(vm.broken).toEqual([{ dirName: "ruim", errors: [`no ${MANIFEST_FILE} — this directory is not a plugin`] }]);
  });
});
