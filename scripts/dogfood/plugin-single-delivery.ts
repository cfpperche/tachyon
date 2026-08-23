/**
 * 515 — dogfood da fatia 2: instalar não escreve no projeto; entregar escreve.
 *
 * Usa o `sdd` instalado neste workspace como payload real, num workspace temporário — nada é escrito
 * no repositório do autor e nenhum agente vivo é tocado. O que prova, em ordem:
 *
 *   1. instalar deixa `.claude/skills`, `.agents/skills` e `.grok/skills` INTACTOS;
 *   2. a entrega ao codex materializa o dest a partir da CONCESSÃO, sem nenhum `skill-dir` no lockfile
 *      (o T9, que é o portão da fatia);
 *   3. exportar coloca a skill nos diretórios do projeto, e desexportar a tira.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyContribution,
  applyInstall,
  detectRuntimes,
  loadPlugin,
  previewInstall,
  unapplyContribution,
} from "../../apps/vscode-extension/src/plugins/engine.js";
import { restoreWorkspaceSkillDest } from "../../packages/engine/src/plugins/agentDest.js";

const source = path.resolve(".tachyon/plugins/sdd");
if (!fs.existsSync(path.join(source, "tachyon-plugin.json"))) {
  console.error(`dogfood needs an installed plugin to use as payload; ${source} is not one`);
  process.exit(1);
}

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-515-dogfood-"));
const fail = (why: string): never => { console.error(`FAILED: ${why}`); fs.rmSync(ws, { recursive: true, force: true }); process.exit(1); };

try {
  for (const rel of [".claude", ".codex", ".grok"]) fs.mkdirSync(path.join(ws, rel), { recursive: true });

  const loaded = loadPlugin(source);
  if (!loaded.plugin) fail(`could not load ${source}: ${loaded.errors.join("; ")}`);
  const target = detectRuntimes(ws);
  const preview = previewInstall(loaded.plugin!, ws, target);
  const installed = await applyInstall(loaded.plugin!, preview, ws, target);
  if (!installed.installed) fail(`install refused: ${installed.errors.join("; ")}`);

  const WORKSPACE_DIRS = [".claude/skills", ".agents/skills", ".grok/skills"];
  const touched = WORKSPACE_DIRS.filter((rel) => fs.existsSync(path.join(ws, rel)));
  if (touched.length > 0) fail(`install wrote into the project: ${touched.join(", ")}`);
  const lock = JSON.parse(fs.readFileSync(path.join(ws, ".tachyon/plugins.lock.json"), "utf8"));
  const declared = lock.plugins.sdd.targets.filter((t: { kind: string }) => t.kind === "skill-dir");
  if (declared.length > 0) fail(`install declared ${declared.length} skill-dir target(s) in the lockfile`);
  console.log(`ok — installed ${loaded.plugin!.manifest.name} ${loaded.plugin!.manifest.version} for [${installed.runtimes}] without touching the project`);
  console.log(`     payload: .tachyon/plugins/sdd/skills/sdd/SKILL.md`);

  // T9 — the gate. Delivery materializes the dest from the payload the GRANT names, with the lockfile
  // declaring nothing. This is what a codex launch does for each granted skill it cannot find.
  const codexRoot = path.join(ws, ".agents", "skills");
  const payload = path.join(ws, ".tachyon", "plugins", "sdd", "skills", "sdd");
  if (!restoreWorkspaceSkillDest(codexRoot, "sdd", payload)) fail("delivery did not materialize the granted skill");
  if (!fs.existsSync(path.join(codexRoot, "sdd", "SKILL.md"))) fail("the delivered dest has no SKILL.md");
  if (fs.realpathSync(path.join(codexRoot, "sdd")) !== fs.realpathSync(payload)) fail("the delivered dest does not point at the payload");
  console.log(`ok — the grant delivered to codex on its own: ${path.join(".agents/skills", "sdd")} -> the payload`);

  // And delivery never replaces what is already there.
  if (restoreWorkspaceSkillDest(codexRoot, "sdd", payload)) fail("delivery replaced a dest that was already present");
  console.log(`ok — a second delivery is a no-op: what is present is never replaced`);

  // The export door: the human's explicit act, and its reverse.
  fs.rmSync(path.join(codexRoot, "sdd"), { recursive: true, force: true });
  const exported = applyContribution("sdd", { kind: "skill", name: "sdd" }, ws);
  if (!exported.applied) fail(`export refused: ${exported.errors.join("; ")}`);
  const written = WORKSPACE_DIRS.filter((rel) => fs.existsSync(path.join(ws, rel, "sdd", "SKILL.md")));
  if (written.length !== 3) fail(`export reached ${written.length} of 3 runtimes: ${written.join(", ")}`);
  console.log(`ok — exporting put it in all three: ${written.join(", ")}`);

  const undone = unapplyContribution("sdd", { kind: "skill", name: "sdd" }, ws);
  if (!undone.unapplied) fail(`un-export refused: ${undone.errors.join("; ")}`);
  const left = WORKSPACE_DIRS.filter((rel) => fs.existsSync(path.join(ws, rel, "sdd")));
  if (left.length > 0) fail(`un-export left ${left.join(", ")} behind`);
  if (!fs.existsSync(path.join(payload, "SKILL.md"))) fail("un-export deleted the payload — that is uninstall, not un-export");
  console.log(`ok — un-exporting took all three back out and left the payload alone`);
} finally {
  fs.rmSync(ws, { recursive: true, force: true });
}
