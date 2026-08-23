/**
 * 515 fatia 2 — uma entrega, não duas.
 *
 * ## O que mudou, e por que é uma mudança de dono e não de mecanismo
 *
 * Instalar um plugin escrevia suas skills em `.claude/skills`, `.agents/skills` e `.grok/skills` para
 * todo mundo. Isso tornava a concessão por agente decorativa: quem tinha recebido a skill e quem não
 * tinha liam o mesmo diretório, e a tela dizia outra coisa. O payload continua indo para
 * `.tachyon/plugins/<nome>/`; quem escreve nos diretórios do projeto agora é um ato explícito.
 *
 * ## O que estes testes fixam, e o que deliberadamente NÃO fixam
 *
 * Fixam a fronteira: instalar não toca `.claude`/`.agents`/`.grok`, e o que a instalação ainda escreve
 * — hooks mesclados no settings do projeto, servidores MCP, git hooks — continua exatamente igual,
 * porque para essas coisas não existe outro lugar onde morar e desfazer precisa do registro.
 *
 * Não fixam como o codex recebe a skill: isso é o T9, e mora em `harness.test.ts` junto do launch que
 * o entrega. Duplicar aqui afirmaria um acoplamento entre instalação e entrega que esta spec existe
 * justamente para desfazer.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyContribution,
  applyInstall,
  detectRuntimes,
  loadPlugin,
  previewInstall,
  unapplyContribution,
} from "../../apps/vscode-extension/src/plugins/engine.js";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** A workspace with every runtime's config directory already present. */
function workspace(): string {
  const ws = temp("tachyon-515-ws-");
  for (const rel of [".claude", ".codex", ".grok"]) fs.mkdirSync(path.join(ws, rel), { recursive: true });
  return ws;
}

/** A skills-only plugin declaring `runtimes`, shipping one skill per name. */
function plugin(name: string, runtimes: string[], skills: string[]): string {
  const dir = temp(`tachyon-515-${name}-`);
  fs.writeFileSync(path.join(dir, "tachyon-plugin.json"), JSON.stringify({
    name, version: "1.0.0", description: `${name} ships ${skills.length} skill(s)`, runtimes,
  }));
  for (const skill of skills) {
    const sd = path.join(dir, "skills", skill);
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, "SKILL.md"), `---\nname: ${skill}\ndescription: ${skill}\n---\nbody of ${skill}\n`);
  }
  return dir;
}

async function install(dir: string, ws: string) {
  const loaded = loadPlugin(dir);
  expect(loaded.errors).toEqual([]);
  const target = detectRuntimes(ws);
  const preview = previewInstall(loaded.plugin!, ws, target);
  const result = await applyInstall(loaded.plugin!, preview, ws, target);
  return { preview, result };
}

const WORKSPACE_SKILL_DIRS = [".claude/skills", ".agents/skills", ".grok/skills"];

describe("515 — installing a plugin does not write into the project's skill directories", () => {
  it("lands the payload, records the plugin, and leaves all three runtime skill dirs untouched", async () => {
    const ws = workspace();
    const { preview, result } = await install(plugin("solo", ["claude", "codex", "grok"], ["alpha", "beta"]), ws);

    expect(result.installed).toBe(true);
    expect(preview.skillTargets).toEqual([]);
    expect(preview.payloadSkills).toEqual(["alpha", "beta"]);

    for (const rel of WORKSPACE_SKILL_DIRS) {
      expect(fs.existsSync(path.join(ws, rel)), `${rel} must not be created by an install`).toBe(false);
    }
    // What DID land: the payload, addressable, and a lockfile entry naming the consented runtimes.
    expect(fs.readFileSync(path.join(ws, ".tachyon/plugins/solo/skills/alpha/SKILL.md"), "utf8")).toContain("body of alpha");
    const lock = JSON.parse(fs.readFileSync(path.join(ws, ".tachyon/plugins.lock.json"), "utf8"));
    expect(lock.plugins.solo.runtimes.sort()).toEqual(["claude", "codex", "grok"]);
    expect(lock.plugins.solo.targets.filter((t: { kind: string }) => t.kind === "skill-dir")).toEqual([]);
  });

  it("a skills-only plugin installs at all — it was refused outright while 'installed' meant 'wrote to the workspace'", async () => {
    // The guard counted workspace writes as evidence that anything happened. With those gone it refused
    // every skills-only plugin, which is the common shape: `sdd` and `agent-browser` are both this.
    const ws = workspace();
    const { result } = await install(plugin("skills-only", ["claude"], ["one"]), ws);
    expect(result.errors).toEqual([]);
    expect(result.installed).toBe(true);
    expect(result.runtimes).toEqual(["claude"]);
  });
});

describe("515 — exporting is the act that writes, and it is reversible", () => {
  it("puts the skill in every runtime the install consented to, and takes it back out", async () => {
    const ws = workspace();
    await install(plugin("exp", ["claude", "codex"], ["shared"]), ws);

    expect(applyContribution("exp", { kind: "skill", name: "shared" }, ws).applied).toBe(true);
    expect(fs.readFileSync(path.join(ws, ".claude/skills/shared/SKILL.md"), "utf8")).toContain("body of shared");
    expect(fs.readFileSync(path.join(ws, ".agents/skills/shared/SKILL.md"), "utf8")).toContain("body of shared");
    // grok was not part of this install, so exporting must not invent a destination for it.
    expect(fs.existsSync(path.join(ws, ".grok/skills/shared"))).toBe(false);

    const lock = () => JSON.parse(fs.readFileSync(path.join(ws, ".tachyon/plugins.lock.json"), "utf8"));
    expect(lock().plugins.exp.targets.filter((t: { kind: string }) => t.kind === "skill-dir").map((t: { file: string }) => t.file).sort())
      .toEqual([".agents/skills/shared", ".claude/skills/shared"]);

    expect(unapplyContribution("exp", { kind: "skill", name: "shared" }, ws)).toMatchObject({ unapplied: true });
    expect(fs.existsSync(path.join(ws, ".claude/skills/shared"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".agents/skills/shared"))).toBe(false);
    // The record goes with the directory: leaving it would promise a removal nothing owns any more.
    expect(lock().plugins.exp.targets.filter((t: { kind: string }) => t.kind === "skill-dir")).toEqual([]);
    // And the payload is untouched — un-exporting is not uninstalling.
    expect(fs.existsSync(path.join(ws, ".tachyon/plugins/exp/skills/shared/SKILL.md"))).toBe(true);
  });

  it("refuses to write over a directory it did not put there, and says where", async () => {
    const ws = workspace();
    await install(plugin("clash", ["claude"], ["mine"]), ws);
    fs.mkdirSync(path.join(ws, ".claude/skills/mine"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".claude/skills/mine/SKILL.md"), "HUMAN WROTE THIS");

    const refused = applyContribution("clash", { kind: "skill", name: "mine" }, ws);
    expect(refused.applied).toBe(false);
    expect(refused.errors[0]).toMatch(/collides with an existing skill at \.claude\/skills\/mine/);
    expect(fs.readFileSync(path.join(ws, ".claude/skills/mine/SKILL.md"), "utf8")).toBe("HUMAN WROTE THIS");

    // With consent, it overwrites — the same Keep/Replace decision as before, asked by the door that writes.
    expect(applyContribution("clash", { kind: "skill", name: "mine" }, ws, { replace: true }).applied).toBe(true);
    expect(fs.readFileSync(path.join(ws, ".claude/skills/mine/SKILL.md"), "utf8")).toContain("body of mine");
  });

  it("re-exporting over OUR OWN previous export is not a collision", async () => {
    // Otherwise updating a plugin, or repairing an edited export, would demand consent to overwrite
    // something Tachyon itself put there one call earlier.
    const ws = workspace();
    await install(plugin("again", ["claude"], ["twice"]), ws);
    expect(applyContribution("again", { kind: "skill", name: "twice" }, ws).applied).toBe(true);
    expect(applyContribution("again", { kind: "skill", name: "twice" }, ws).applied).toBe(true);
  });

  it("refuses a skill the payload does not carry, naming the plugin", async () => {
    const ws = workspace();
    await install(plugin("thin", ["claude"], ["real"]), ws);
    const missing = applyContribution("thin", { kind: "skill", name: "imaginary" }, ws);
    expect(missing.applied).toBe(false);
    expect(missing.errors[0]).toMatch(/plugin 'thin' has no skill named 'imaginary'/);
  });
});

describe("515 — a re-install neither forgets nor destroys an export", () => {
  it("keeps the exported directory and its record when the new payload still ships the skill", async () => {
    const ws = workspace();
    const dir = plugin("stable", ["claude"], ["kept"]);
    await install(dir, ws);
    expect(applyContribution("stable", { kind: "skill", name: "kept" }, ws).applied).toBe(true);

    await install(dir, ws); // re-install, unchanged payload
    expect(fs.existsSync(path.join(ws, ".claude/skills/kept/SKILL.md"))).toBe(true);
    const lock = JSON.parse(fs.readFileSync(path.join(ws, ".tachyon/plugins.lock.json"), "utf8"));
    expect(lock.plugins.stable.targets.filter((t: { kind: string }) => t.kind === "skill-dir").map((t: { file: string }) => t.file))
      .toEqual([".claude/skills/kept"]);
  });

  it("removes an export the new payload no longer ships, and forgets it", async () => {
    const ws = workspace();
    await install(plugin("shrink", ["claude"], ["dropped", "kept"]), ws);
    expect(applyContribution("shrink", { kind: "skill", name: "dropped" }, ws).applied).toBe(true);
    expect(applyContribution("shrink", { kind: "skill", name: "kept" }, ws).applied).toBe(true);

    await install(plugin("shrink", ["claude"], ["kept"]), ws); // the new version drops one
    expect(fs.existsSync(path.join(ws, ".claude/skills/dropped"))).toBe(false);
    expect(fs.existsSync(path.join(ws, ".claude/skills/kept/SKILL.md"))).toBe(true);
    const lock = JSON.parse(fs.readFileSync(path.join(ws, ".tachyon/plugins.lock.json"), "utf8"));
    expect(lock.plugins.shrink.targets.filter((t: { kind: string }) => t.kind === "skill-dir").map((t: { file: string }) => t.file))
      .toEqual([".claude/skills/kept"]);
  });
});
