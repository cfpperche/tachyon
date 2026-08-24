/**
 * 516 fatia 3 — o que um plugin torna concedível.
 *
 * Este é o ponto onde o sistema novo encosta na entrega que já existe, e por isso o que vale testar
 * é o MAPA, não a entrega: que cada família do payload vira o `kind` de reference que o resolvedor de
 * perfil entende, que o dono é nomeado como plugin, e que o digest é o do sistema — porque um número
 * nosso produziria uma concessão recusada no launch por `digest-mismatch`, ou seja, um plugin
 * instalado e nunca entregue.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { grantableReferences, digestOf } from "@tachyon/engine/plugins2/grantable.js";
import { loadPlugin, MANIFEST_FILE } from "@tachyon/engine/plugins2/manifest.js";
import { inspectCapabilitySourceAtRoot } from "@tachyon/engine/config/agentCapabilitySource.js";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

const SKILL = "---\nname: x\ndescription: x\n---\nbody\n";

/** Um plugin instalado de verdade, sob `.tachyon/plugins/<nome>/` de um workspace. */
function installed(name: string, manifest: Record<string, unknown>, files: Record<string, string>) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-516-gr-"));
  made.push(ws);
  const dir = path.join(ws, ".tachyon/plugins", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), JSON.stringify({ name, version: "1.0.0", description: "x", ...manifest }));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return { ws, plugin: loadPlugin(dir).plugin! };
}

describe("516 — cada família vira o kind que o perfil entende", () => {
  it("mapeia as cinco famílias, os hooks e o MCP", () => {
    const { plugin } = installed("demo", {}, {
      "skills/uma/SKILL.md": SKILL,
      "extensions/medir/index.ts": "export {}",
      "prompts/planejar/p.md": "x",
      "themes/escuro/t.json": "{}",
      "packages/pacote/package.json": "{}",
      "hooks/claude/h.json": "{}",
      "mcp.json": "{}",
    });
    expect(grantableReferences(plugin).map((r) => `${r.kind}:${r.id}`)).toEqual([
      "skill:uma",
      "pi-extension:medir",
      "pi-prompt:planejar",
      "pi-theme:escuro",
      "pi-package:pacote",
      "hook:demo-hooks-claude",
      "mcp:demo-mcp",
    ]);
  });

  it("nomeia o dono como plugin, que é como a tela sabe de onde a concessão veio", () => {
    const { plugin } = installed("sdd", {}, { "skills/sdd/SKILL.md": SKILL });
    const [ref] = grantableReferences(plugin);
    expect(ref!.owner).toBe("plugin:sdd");
    expect(ref!.path).toBe(".tachyon/plugins/sdd/skills/sdd");
  });

  it("uma skill alcança os quatro runtimes; um prompt, só o pi", () => {
    const { plugin } = installed("demo", {}, { "skills/uma/SKILL.md": SKILL, "prompts/p/p.md": "x" });
    const refs = grantableReferences(plugin);
    expect(refs.find((r) => r.kind === "skill")!.runtimes).toEqual(["claude", "codex", "grok", "pi"]);
    expect(refs.find((r) => r.kind === "pi-prompt")!.runtimes).toEqual(["pi"]);
  });

  it("o estreitamento do autor corta os runtimes da reference também", () => {
    const { plugin } = installed("demo", { runtimes: ["codex"] }, { "skills/uma/SKILL.md": SKILL });
    expect(grantableReferences(plugin)[0]!.runtimes).toEqual(["codex"]);
  });

  it("MCP não é oferecido ao pi, que não o materializa", () => {
    const { plugin } = installed("demo", {}, { "mcp.json": "{}", "skills/uma/SKILL.md": SKILL });
    expect(grantableReferences(plugin).find((r) => r.kind === "mcp")!.runtimes).toEqual(["claude", "codex", "grok"]);
  });
});

describe("516 — o digest é o do sistema, não um número nosso", () => {
  it("bate exatamente com o que a custódia calcula, que é o que o launch recalcula", () => {
    // Um hash próprio aqui produziria uma concessão recusada no launch por digest-mismatch: plugin
    // instalado, concedido, e nunca entregue — com a mensagem apontando para o lugar errado.
    const { ws, plugin } = installed("sdd", {}, { "skills/sdd/SKILL.md": SKILL });
    const [ref] = grantableReferences(plugin);
    expect(digestOf(ws, ref!.path)).toBe(inspectCapabilitySourceAtRoot(ws, ref!.path).sha256);
  });

  it("muda quando o payload muda — é isso que fixar significa", () => {
    const { ws, plugin } = installed("sdd", {}, { "skills/sdd/SKILL.md": SKILL });
    const [ref] = grantableReferences(plugin);
    const antes = digestOf(ws, ref!.path);
    fs.writeFileSync(path.join(ws, ref!.path, "SKILL.md"), SKILL.replace("body", "outro corpo"));
    expect(digestOf(ws, ref!.path)).not.toBe(antes);
  });
});
