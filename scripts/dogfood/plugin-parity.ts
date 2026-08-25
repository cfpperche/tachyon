/**
 * t-0c2708 — paridade de capacidade entre os quatro runtimes, com plugins de exemplo como fixture.
 *
 * Quatro plugins de mentira, um por forma, e o quarto com as três juntas. Eles existem porque o repo
 * de plugins REAL não tem nenhum que traga hook ou MCP no formato novo — então até 2026-08-25 as duas
 * famílias eram código que ninguém tinha exercido. Foi assim que o hook do codex nasceu enterrado no
 * TOML e ninguém percebeu por meses, e que o grok ficou sendo o único runtime que o sistema oferecia
 * e não entregava.
 *
 * O que ele mede, por runtime, no que o PRODUTO escreve na home privada:
 *
 *   skill  → a árvore chega byte a byte
 *   hook   → o hook concedido aparece onde aquele runtime o lê
 *   mcp    → o servidor concedido aparece na configuração daquele runtime
 *
 * Uma linha em branco na matriz é uma capacidade não entregue, nunca uma omissão silenciosa.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { installFromZip } from "../../packages/engine/src/plugins/install.js";
import { grantableReferences } from "../../packages/engine/src/plugins/grantable.js";
import { readInstalled } from "../../packages/engine/src/plugins/catalog.js";
import { inspectCapabilitySourceAtRoot, captureCapabilitySourceAtRoot } from "../../packages/engine/src/config/agentCapabilitySource.js";
import { HarnessManager } from "../../packages/engine/src/harness/HarnessManager.js";
import { adapterForRuntime } from "@tachyon/shared/resume/adapters.js";

type Runtime = "claude" | "codex" | "grok" | "pi";
const RUNTIMES: Runtime[] = ["claude", "codex", "grok", "pi"];

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-paridade-"));
const homes = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-paridade-home-"));
const fail = (why: string): never => {
  console.error(`FAILED: ${why}`);
  process.exit(1);
};

/** Um plugin de exemplo, montado em memória e instalado de verdade. */
async function instalar(nome: string, arquivos: Record<string, string>): Promise<void> {
  const zip = new JSZip();
  zip.file(`${nome}-1.0.0/tachyon-plugin.json`, JSON.stringify({
    name: nome,
    version: "1.0.0",
    description: `fixture de paridade: ${nome}`,
  }, null, 2));
  for (const [rel, body] of Object.entries(arquivos)) zip.file(`${nome}-1.0.0/${rel}`, body);
  const zipPath = path.join(ws, `${nome}.zip`);
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));
  const result = await installFromZip(ws, zipPath);
  if (!result.plugin) fail(`${nome}: instalação recusada — ${result.errors.join("; ")}`);
}

const SKILL = "---\nname: marca\ndescription: fixture de paridade\n---\ncorpo\n";
const HOOK = JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "true" }] }] } }, null, 2);
const MCP = JSON.stringify({ mcpServers: { servidor_fixture: { command: "echo", args: ["oi"] } } }, null, 2);

await instalar("so-skill", { "skills/marca/SKILL.md": SKILL });
await instalar("so-hook", { "hooks/claude/h.json": HOOK, "hooks/codex/h.json": HOOK, "hooks/grok/h.json": HOOK });
await instalar("so-mcp", { "mcp.json": MCP });
await instalar("as-tres", {
  "skills/marca/SKILL.md": SKILL,
  "hooks/claude/h.json": HOOK,
  "hooks/codex/h.json": HOOK,
  "hooks/grok/h.json": HOOK,
  "mcp.json": MCP,
});
console.log("ok — quatro plugins de exemplo instalados: so-skill, so-hook, so-mcp, as-tres\n");

/** A projeção que o launch receberia se um humano concedesse TUDO o que o plugin oferece a este runtime. */
function projecaoDe(plugin: string, runtime: Runtime) {
  const loaded = readInstalled(ws, plugin);
  if (!loaded) return fail(`${plugin} não está instalado`);
  const skills: Array<{ name: string; source: ReturnType<typeof inspectCapabilitySourceAtRoot> }> = [];
  const hooks: Record<string, unknown> = {};
  const mcp: Record<string, unknown> = {};
  for (const ref of grantableReferences(loaded)) {
    if (!ref.runtimes.includes(runtime)) continue;
    const digest = inspectCapabilitySourceAtRoot(ws, ref.path).sha256;
    const source = captureCapabilitySourceAtRoot(ws, ref.path, digest);
    if (ref.kind === "skill") skills.push({ name: ref.id, source });
    if (ref.kind === "hook") {
      const arquivo = source.entries.find((e) => e.type === "file");
      const bloco = JSON.parse(Buffer.from(arquivo!.bytes).toString("utf8")) as { hooks: Record<string, unknown> };
      Object.assign(hooks, bloco.hooks);
    }
    if (ref.kind === "mcp") {
      const bloco = JSON.parse(Buffer.from(source.entries[0]!.bytes).toString("utf8")) as { mcpServers: Record<string, unknown> };
      Object.assign(mcp, bloco.mcpServers);
    }
  }
  return {
    schemaVersion: 1, adapter: runtime, sha256: "a".repeat(64), effectiveProfileSha256: "b".repeat(64),
    sources: [], skills, mcp, hooks,
    pi: { extensions: [], prompts: [], themes: [], packages: [] },
  };
}

/** O que a home privada REALMENTE recebeu, lido do disco. */
function entregue(home: string, runtime: Runtime): { skill: boolean; hook: boolean; mcp: boolean } {
  let skill = false, hook = false, mcp = false;
  const anda = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { anda(full); continue; }
      if (full.includes("profile-capabilities")) continue; // o manifesto ATESTA; não é entrega
      if (entry.name === "SKILL.md" && full.includes("marca")) skill = true;
      const texto = fs.readFileSync(full, "utf8");
      if (texto.includes("PreToolUse")) hook = true;
      if (texto.includes("servidor_fixture")) mcp = true;
    }
  };
  try { anda(home); } catch { /* home vazia conta como nada entregue */ }
  return { skill, hook, mcp };
}

const realHome = path.join(homes, "claude-real");
fs.mkdirSync(realHome, { recursive: true });
fs.writeFileSync(path.join(realHome, ".credentials.json"), "{}");

const matriz: string[] = [];
let faltas = 0;
for (const runtime of RUNTIMES) {
  const oferecido = grantableReferences(readInstalled(ws, "as-tres")!)
    .filter((ref) => ref.runtimes.includes(runtime))
    .map((ref) => ref.kind);
  const codexHome = path.join(homes, `codex-${runtime}`);
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "auth.json"), "{}");
  const grokHome = path.join(homes, `grok-${runtime}`);
  fs.mkdirSync(grokHome, { recursive: true });
  fs.writeFileSync(path.join(grokHome, "auth.json"), '{"token":"X"}');
  const piHome = path.join(homes, `pi-${runtime}`);
  fs.mkdirSync(piHome, { recursive: true });

  const mgr = new HarnessManager(
    ws, realHome, { env: {} } as never, path.join(realHome, ".claude.json"),
    codexHome, undefined, grokHome, undefined, undefined, piHome,
  );
  let recebido = { skill: false, hook: false, mcp: false };
  try {
    const r = mgr.materializeProfileCapabilities(`par-${runtime}`, projecaoDe("as-tres", runtime) as never, adapterForRuntime(runtime)!, ws);
    recebido = entregue(r.home, runtime);
  } catch (error) {
    console.error(`  ${runtime}: materialização falhou — ${(error as Error).message.slice(0, 120)}`);
  }
  const celula = (nome: "skill" | "hook" | "mcp"): string => {
    const oferece = oferecido.includes(nome === "mcp" ? "mcp" : nome === "hook" ? "hook" : "skill");
    if (!oferece) return "  —   ";
    if (recebido[nome]) return "  ok  ";
    faltas += 1;
    return " FALTA";
  };
  matriz.push(`  ${runtime.padEnd(7)}${celula("skill")}${celula("hook")}${celula("mcp")}`);
}

console.log("  runtime  skill  hook   mcp");
console.log(matriz.join("\n"));
console.log(`\n${faltas === 0 ? "ok — o que cada runtime aceita, ele recebe" : `${faltas} capacidade(s) oferecida(s) e NÃO entregue(s)`}`);
fs.rmSync(ws, { recursive: true, force: true });
fs.rmSync(homes, { recursive: true, force: true });
if (faltas > 0) process.exit(1);
