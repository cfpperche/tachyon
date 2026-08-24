/**
 * 516 — entregar uma capacidade concedida onde o runtime realmente a lê.
 *
 * ## Por que este arquivo tem uma função só
 *
 * Ele tinha vinte, e dezenove serviam ao instalador antigo: planejar destinos de workspace por runtime,
 * validar caminhos de destino, resolver escopo de instalação, sobrepor destinos que um lockfile
 * declarava. Nada disso existe: instalar deixa o payload em `.tachyon/plugins/<nome>/` e não escreve
 * em mais lugar nenhum, e o que um agente recebe é decidido pela concessão dele, a cada launch.
 *
 * O que sobra é o caso em que a concessão precisa de ajuda para chegar — e é um só, medido.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Materializar um destino de skill como um link para o payload.
 *
 * Link, e não cópia: o payload é a única cópia dos bytes, e um agente que recebe a skill lê os mesmos
 * bytes que a concessão atesta. Uma cópia criaria uma segunda verdade que o digest do launch teria de
 * perseguir.
 */
function materializeSkillDest(srcAbs: string, destAbs: string): void {
  fs.rmSync(destAbs, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destAbs), { recursive: true, mode: 0o700 });
  fs.symlinkSync(srcAbs, destAbs);
}

/**
 * t-318d7d / 515 — materialize the ONE skill dest a grant names, when the disk does not have it.
 *
 * ## Why anything has to be written at launch at all
 *
 * Measured on codex 0.149.0 (t-ef3c1f): codex discovers skills from `<cwd>/.agents/skills` and from
 * `~/.agents/skills`, and from nowhere else — not from its own `CODEX_HOME`. So for a Codex agent, a
 * grant that exists only as a record delivers nothing: something must put the skill where the runtime
 * looks. That gap had no teeth while such an agent could hold no grant at all; it grew them in 0.93.39,
 * when the launch stopped writing the tree and started DELIVERING WHAT THE INSTALLER LEFT. Measured on
 * this workspace: three skill dests recorded as materialized, none of the three on disk, and a Codex
 * agent granted `agent-browser` refused at resume by the fail-closed digest check.
 *
 * ## Why it no longer asks the lockfile
 *
 * The first version looked the dest up in the lockfile — the installer's record of what it wrote. That
 * worked only because the installer wrote workspace dests for everyone, which is exactly what spec 515
 * removes: once install stops declaring `skill-dir`, a lookup finds nothing and the Codex agent is
 * refused again. The dependency was never necessary, only convenient. **The grant already carries the
 * payload it attests** (`path: .tachyon/plugins/<name>/skills/<skill>`, resolved to `sourcePath`), and
 * that is the whole of what materializing needs. Deriving from the grant also makes the delivery say
 * something true that the lockfile route could not: what is on disk is what THIS agent was granted,
 * rather than what some install once left for everybody.
 *
 * ## What it will not do
 *
 * Repair, not ownership: only the entry the caller names, only when it is ABSENT, and only from a
 * payload that exists. An entry already present — the human's, another plugin's, anything — is never
 * touched, which is the whole difference between this and the tree replacement that must not run at a
 * workspace root. A missing payload returns false rather than creating a dangling link, and the
 * caller's own digest check then refuses by name.
 */
export function restoreWorkspaceSkillDest(destRoot: string, skill: string, payloadDir: string): boolean {
  const destAbs = path.join(destRoot, skill);
  if (fs.existsSync(destAbs)) return false; // already there: never replace what is present
  let payload: fs.Stats;
  try {
    payload = fs.statSync(payloadDir);
  } catch {
    return false; // the grant names a payload that is gone — nothing honest to restore from
  }
  if (!payload.isDirectory()) return false;
  materializeSkillDest(payloadDir, destAbs);
  return true;
}
