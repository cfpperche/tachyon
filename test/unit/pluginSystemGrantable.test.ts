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
import { grantableReferences, digestOf } from "@tachyon/engine/plugins/grantable.js";
import { loadPlugin, MANIFEST_FILE } from "@tachyon/engine/plugins/manifest.js";
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
      "prompts/planejar.md": "x",
      "themes/escuro.json": "{}",
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
    const { plugin } = installed("demo", {}, { "skills/uma/SKILL.md": SKILL, "prompts/p.md": "x" });
    const refs = grantableReferences(plugin);
    expect(refs.find((r) => r.kind === "skill")!.runtimes).toEqual(["claude", "codex", "grok", "pi"]);
    expect(refs.find((r) => r.kind === "pi-prompt")!.runtimes).toEqual(["pi"]);
  });

  it("o estreitamento do autor corta os runtimes da reference também", () => {
    const { plugin } = installed("demo", { runtimes: ["codex"] }, { "skills/uma/SKILL.md": SKILL });
    expect(grantableReferences(plugin)[0]!.runtimes).toEqual(["codex"]);
  });

  it("MCP não é oferecido nem ao pi nem ao grok, que não têm porta de perfil para ele", () => {
    // O grok saiu desta lista em 2026-08-24. Ele estava aqui por simetria com os outros dois, não
    // por medição: o `agentProfileResolver` sempre reteve MCP e hook num perfil grok, então a oferta
    // prometia o que o launch nunca entregava. O pi nunca esteve — ele não materializa MCP.
    const { plugin } = installed("demo", {}, { "mcp.json": "{}", "skills/uma/SKILL.md": SKILL });
    expect(grantableReferences(plugin).find((r) => r.kind === "mcp")!.runtimes).toEqual(["claude", "codex"]);
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

/**
 * A OFERTA NÃO PODE PROMETER O QUE O LAUNCH SEMPRE RETÉM.
 *
 * `agentProfileResolver` recusa pelo nome todo grant de MCP ou hook num perfil grok — *"Grok profile
 * projection supports exact captured skills only; MCP, hooks and Pi resources have separate runtime
 * doors"*. Este mapa oferecia os dois assim mesmo, então o Agent Studio mostrava ao humano uma
 * concessão que nunca ia chegar. A retenção tem diagnóstico visível, então não era falha silenciosa;
 * era uma promessa que a outra camada não cumpre.
 *
 * O caso trava o ACORDO entre as duas camadas, não uma constante: quando a porta de perfil do grok
 * aprender MCP e hook, este caso falha e obriga a mexer nos dois lados juntos.
 */
describe("516 — o que se oferece é o que a porta de perfil aceita", () => {
  it("não oferece hook nem MCP a um perfil grok, que só tem porta de skills", () => {
    const { plugin } = installed("portao", { runtimes: ["claude", "codex", "grok"] }, {
      "skills/uma/SKILL.md": SKILL,
      "hooks/claude/h.json": "{}",
      "hooks/codex/h.json": "{}",
      "hooks/grok/h.json": "{}",
      "mcp.json": "{}",
    });
    const paraGrok = grantableReferences(plugin).filter((r) => r.runtimes.includes("grok"));
    expect(paraGrok.map((r) => r.kind).sort()).toEqual(["skill"]);
  });

  it("continua oferecendo hook e MCP a claude e codex, onde a entrega foi medida", () => {
    const { plugin } = installed("portao2", { runtimes: ["claude", "codex", "grok"] }, {
      "hooks/claude/h.json": "{}",
      "hooks/codex/h.json": "{}",
      "hooks/grok/h.json": "{}",
      "mcp.json": "{}",
    });
    const refs = grantableReferences(plugin);
    expect(refs.map((r) => `${r.kind}:${r.id}`).sort()).toEqual([
      "hook:portao2-hooks-claude",
      "hook:portao2-hooks-codex",
      "mcp:portao2-mcp",
    ]);
    expect(refs.find((r) => r.kind === "mcp")!.runtimes).toEqual(["claude", "codex"]);
  });
});
