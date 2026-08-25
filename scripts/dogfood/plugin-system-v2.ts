/**
 * 516 — dogfood: o `sdd` real, no formato novo, do zip até a concessão.
 *
 * Monta o payload a partir do fonte INTOCADO em `~/tachyon-plugins/sdd` — o repositório de plugins é
 * non-goal desta spec e não é modificado. O que se prova, em ordem:
 *
 *   1. o manifesto novo carrega um plugin real, com as skills que ele já tinha;
 *   2. instalar não cria nenhum diretório de runtime no projeto;
 *   3. o catálogo é o disco: sem lockfile, sem índice;
 *   4. as capacidades viram references concedíveis, com o digest que o LAUNCH vai recalcular;
 *   5. `prompts/` chega ao pi — o caminho que nunca teve um plugin;
 *   6. desinstalar é apagar a pasta.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { installFromZip, uninstall } from "../../packages/engine/src/plugins/install.js";
import { readCatalog } from "../../packages/engine/src/plugins/catalog.js";
import { grantableReferences, digestOf } from "../../packages/engine/src/plugins/grantable.js";
import { buildPluginsViewModel } from "../../packages/engine/src/plugins/viewModel.js";
import { inspectCapabilitySourceAtRoot } from "../../packages/engine/src/config/agentCapabilitySource.js";

const SOURCE = "/home/goat/tachyon-plugins/sdd";
const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-516-dogfood-"));
const fail = (why: string): never => { console.error(`FAILED: ${why}`); fs.rmSync(ws, { recursive: true, force: true }); process.exit(1); };

try {
  if (!fs.existsSync(path.join(SOURCE, "skills", "sdd", "SKILL.md"))) fail(`${SOURCE} não tem o payload do sdd`);
  for (const rel of [".claude", ".codex", ".grok"]) fs.mkdirSync(path.join(ws, rel), { recursive: true });

  // 1. empacotar no formato novo: seis campos, e o payload dizendo o resto.
  const zip = new JSZip();
  zip.file("sdd-2.0.0/tachyon-plugin.json", JSON.stringify({
    name: "sdd",
    version: "2.0.0",
    description: "spec-driven development: intent before code, in living documents",
    docs: "https://github.com/cfpperche/tachyon-plugins",
  }, null, 2));
  const add = (from: string, to: string): void => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dest = `${to}/${entry.name}`;
      if (entry.isDirectory()) add(src, dest);
      else if (entry.isFile()) zip.file(dest, fs.readFileSync(src));
    }
  };
  add(path.join(SOURCE, "skills", "sdd"), "sdd-2.0.0/skills/sdd");
  // E um prompt, para exercitar o caminho do pi que nunca teve um plugin.
  zip.file("sdd-2.0.0/prompts/nova-spec.md", "Rascunhe a intenção antes do código: problema, critérios de aceite, não-objetivos.\n");

  const zipPath = path.join(ws, "sdd.zip");
  fs.writeFileSync(zipPath, await zip.generateAsync({ type: "nodebuffer" }));

  // 2. instalar
  const result = await installFromZip(ws, zipPath);
  if (!result.plugin) fail(`instalação recusada: ${result.errors.join("; ")}`);
  const plugin = result.plugin!;
  console.log(`ok — ${plugin.manifest.name} ${plugin.manifest.version} instalado, servindo [${plugin.runtimes}]`);

  const RUNTIME_DIRS = [".claude/skills", ".agents/skills", ".grok/skills"];
  const tocados = RUNTIME_DIRS.filter((rel) => fs.existsSync(path.join(ws, rel)));
  if (tocados.length > 0) fail(`instalar tocou no projeto: ${tocados.join(", ")}`);
  console.log(`ok — nenhum dos três diretórios de runtime foi criado`);

  // 3. o catálogo é o disco
  const dentroDeTachyon = fs.readdirSync(path.join(ws, ".tachyon"));
  if (dentroDeTachyon.length !== 1 || dentroDeTachyon[0] !== "plugins") {
    fail(`algo além do payload foi escrito em .tachyon: ${dentroDeTachyon.join(", ")}`);
  }
  const catalog = readCatalog(ws);
  if (catalog.installed.length !== 1 || catalog.broken.length !== 0) fail("o catálogo não leu o que está no disco");
  const vm = buildPluginsViewModel({ catalog });
  console.log(`ok — sem lockfile: .tachyon contém só [${dentroDeTachyon}]`);
  console.log(`     o card diz: ${vm.installed[0]!.capabilities.map((c) => c.label).join(", ")}`);

  // 4. as capacidades viram references concedíveis, com o digest do sistema
  const refs = grantableReferences(plugin);
  for (const ref of refs) {
    const digest = digestOf(ws, ref.path);
    const recalculado = inspectCapabilitySourceAtRoot(ws, ref.path).sha256;
    if (digest !== recalculado) fail(`digest de ${ref.id} não é o que o launch recalcula`);
  }
  console.log(`ok — ${refs.length} capacidade(s) concedível(is), digest conferido contra a custódia:`);
  for (const ref of refs) console.log(`     ${ref.kind} '${ref.id}' → ${ref.path}  [${ref.runtimes}]`);

  // 5. o prompt alcança o pi, e só ele
  const prompt = refs.find((r) => r.kind === "pi-prompt");
  if (!prompt) fail("o prompt não virou uma reference");
  if (prompt!.runtimes.join() !== "pi") fail(`prompt oferecido a [${prompt!.runtimes}] em vez de só ao pi`);
  const skill = refs.find((r) => r.kind === "skill");
  if (!skill || skill.runtimes.length !== 4) fail("a skill devia alcançar os quatro runtimes");
  console.log(`ok — prompts/ chega ao pi e a mais ninguém; skills/ chega aos quatro`);

  // 6. desinstalar é apagar a pasta
  if (!uninstall(ws, "sdd").removed) fail("desinstalar não removeu");
  if (readCatalog(ws).installed.length !== 0) fail("o catálogo ainda mostra o plugin");
  if (fs.readdirSync(path.join(ws, ".tachyon", "plugins")).length !== 0) fail("sobrou resíduo em .tachyon/plugins");
  console.log(`ok — desinstalar apagou a pasta e nada mais precisou ser consultado`);
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}
