/**
 * 516 fatia 1 — o manifesto encolhido e o payload como declaração.
 *
 * O que vale testar aqui é o que este formato DECIDE, e são três coisas: que a posição no payload
 * substitui um campo; que um manifesto do formato antigo é recusado pelo nome do campo em vez de
 * lido pela metade; e que "quem serve quem" é derivado das famílias presentes, porque isso é
 * propriedade medida dos runtimes e não uma tabela nossa.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPlugin, parseManifest, MANIFEST_FILE } from "@tachyon/engine/plugins/manifest.js";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const BASE = { name: "demo", version: "1.0.0", description: "a demo plugin" };

/** Um plugin no disco: manifesto + as famílias que `payload` nomear. */
function plugin(manifest: Record<string, unknown>, payload: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-516-"));
  made.push(dir);
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(payload)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

const SKILL = "---\nname: thing\ndescription: does a thing\n---\nbody\n";

describe("516 — o manifesto tem seis campos", () => {
  it("aceita os três obrigatórios e mais nada", () => {
    const parsed = parseManifest(BASE);
    expect(parsed.errors).toEqual([]);
    expect(parsed.manifest).toEqual(BASE);
  });

  it("recusa um campo que não existe neste formato, listando os que existem", () => {
    const parsed = parseManifest({ ...BASE, marketplace: "x" });
    expect(parsed.errors.join(" ")).toMatch(/unknown field\(s\) marketplace/);
  });

  it("recusa uma descrição vazia, porque é a única coisa que o humano lê antes de instalar", () => {
    expect(parseManifest({ ...BASE, description: "   " }).errors.join(" ")).toMatch(/description/);
  });

  it("recusa docs que não seja https", () => {
    expect(parseManifest({ ...BASE, docs: "http://x.dev" }).errors.join(" ")).toMatch(/https/);
  });
});

describe("516 — o formato antigo é recusado pelo nome do campo, com o que fazer no lugar", () => {
  const CASES: Array<[string, unknown, RegExp]> = [
    ["tools", { "agent-browser": {} }, /não baixa mais binário|does not|requires/i],
    ["data", { model: {} }, /requires|payload/i],
    ["externalTools", { ffmpeg: {} }, /requires/],
    ["blocks", { claude: "claude/" }, /hooks\/<runtime>\//],
    ["gitHooks", { "pre-commit": "x" }, /v1/],
    ["dependencies", ["outro"], /description/],
    ["docsUrl", "https://x.dev", /docs/],
    ["config", { file: "c.json" }, /config\//],
  ];
  for (const [field, value, expected] of CASES) {
    it(`recusa '${field}' e diz o que fazer`, () => {
      const parsed = parseManifest({ ...BASE, [field]: value });
      expect(parsed.manifest).toBeUndefined();
      const named = parsed.errors.find((e) => e.startsWith(`'${field}'`));
      expect(named, `nenhum erro nomeia '${field}': ${parsed.errors.join(" | ")}`).toBeDefined();
      expect(named!).toMatch(expected);
    });
  }

  it("recusa TODOS os campos antigos de uma vez, não o primeiro", () => {
    // Um autor migrando quer a lista inteira numa passada, não um erro por rodada.
    const parsed = parseManifest({ ...BASE, tools: {}, data: {}, blocks: {}, docsUrl: "https://x.dev" });
    expect(parsed.errors.filter((e) => /^'/.test(e)).length).toBeGreaterThanOrEqual(4);
  });
});

describe("516 — a posição no payload é a declaração", () => {
  it("encontra as capacidades pelas pastas, sem nenhum campo dizendo onde estão", () => {
    const dir = plugin(BASE, {
      "skills/thing/SKILL.md": SKILL,
      "prompts/planejar/prompt.md": "planeje",
      "themes/escuro/theme.json": "{}",
      "extensions/medir/index.ts": "export {}",
    });
    const loaded = loadPlugin(dir);
    expect(loaded.errors).toEqual([]);
    expect(loaded.plugin!.capabilities.map((c) => `${c.kind}:${c.name}`).sort()).toEqual([
      "extension:medir", "prompt:planejar", "skill:thing", "theme:escuro",
    ]);
  });

  it("encontra hooks nativos e mcp.json pela posição", () => {
    const dir = plugin(BASE, { "hooks/claude/hooks.json": "{}", "mcp.json": "{}" });
    const loaded = loadPlugin(dir);
    expect(loaded.plugin!.hooks).toEqual({ claude: "hooks/claude" });
    expect(loaded.plugin!.mcp).toBe(true);
  });

  it("recusa um plugin que não traz nada, dizendo o que ele podia trazer", () => {
    const loaded = loadPlugin(plugin(BASE));
    expect(loaded.plugin).toBeUndefined();
    expect(loaded.errors.join(" ")).toMatch(/carries nothing.*skills\/.*mcp\.json/s);
  });

  it("recusa um nome de capacidade fora da convenção em vez de aceitá-lo torto", () => {
    const loaded = loadPlugin(plugin(BASE, { "skills/Minha Skill/SKILL.md": SKILL }));
    expect(loaded.errors.join(" ")).toMatch(/lowercase words joined by hyphens/);
  });
});

describe("516 — quem serve quem é derivado, porque é propriedade dos runtimes", () => {
  it("um plugin só de skills serve os quatro, sem declarar nada", () => {
    const loaded = loadPlugin(plugin(BASE, { "skills/thing/SKILL.md": SKILL }));
    expect(loaded.plugin!.runtimes).toEqual(["claude", "codex", "grok", "pi"]);
  });

  it("um plugin de prompts serve só o pi — é vocabulário dele", () => {
    const loaded = loadPlugin(plugin(BASE, { "prompts/planejar/prompt.md": "x" }));
    expect(loaded.plugin!.runtimes).toEqual(["pi"]);
  });

  it("declarar estreita, nunca amplia", () => {
    const loaded = loadPlugin(plugin({ ...BASE, runtimes: ["codex"] }, { "skills/thing/SKILL.md": SKILL }));
    expect(loaded.plugin!.runtimes).toEqual(["codex"]);
  });

  it("recusa quando o declarado e o payload não se encontram — instalar seria instalar o silêncio", () => {
    const loaded = loadPlugin(plugin({ ...BASE, runtimes: ["claude"] }, { "extensions/medir/index.ts": "export {}" }));
    expect(loaded.plugin).toBeUndefined();
    expect(loaded.errors.join(" ")).toMatch(/declares runtimes claude but its payload only feeds pi/);
  });

  it("mcp.json e hooks alcançam claude, codex e grok — o pi não materializa nenhum dos dois", () => {
    const loaded = loadPlugin(plugin(BASE, { "mcp.json": "{}" }));
    expect(loaded.plugin!.runtimes).toEqual(["claude", "codex", "grok"]);
  });
});
