import { describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/tempDir.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * t-ef3c1f — the premises the Codex skill projection depends on, RE-MEASURED against the codex on
 * this machine instead of quoted from a comment.
 *
 * A measurement of an external runtime has a shelf life. On 2026-08-22 the product carried two
 * facts measured on codex-cli 0.146.1 — "no discovery root but `<cwd>` exists" and "suppression is
 * keyed by NAME" — and had turned them into a permanent property of Codex. Both were false on
 * 0.149.0, and the cost was a Codex agent on the shared checkout that could hold no grant at all
 * and, once granted, could not launch or resume.
 *
 * So the facts live here, executable. If a future codex changes them back, this fails and names
 * which premise moved — rather than the projection silently delivering the wrong skill set.
 *
 * Skipped, never failed, when codex is absent: a machine without the runtime cannot measure it, and
 * a red suite would say "the premise broke" when it means "nothing was asked".
 */

function codexAvailable(): boolean {
  try {
    execFileSync("codex", ["--version"], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

const available = codexAvailable();
const skill = (dir: string, name: string, marker: string): void => {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${marker}\n---\nbody\n`);
};

function promptInput(cwd: string, codexHome: string, home?: string): string {
  return execFileSync("codex", ["debug", "prompt-input"], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, CODEX_HOME: codexHome, ...(home ? { HOME: home } : {}) },
  });
}

describe.skipIf(!available)("t-ef3c1f — what the Codex skill projection is allowed to assume", () => {
  // t-25a908 — registered for removal by construction; a probe that leaks temp dirs is the exact
  // fixture class that once filled a shared tmpfs and made every suite fail before it ran.
  const workspace = (): string => makeTempDir("codex-premise-");

  it("PREMISE 1 — suppression is keyed by PATH, per entry, inside one directory", () => {
    // This is what lets a launch be exact WITHOUT owning the directory: the workspace's own
    // .agents/skills belongs to the plugin installer, and the projection must not replace it.
    const root = workspace();
    const skills = path.join(root, "ws", ".agents", "skills");
    fs.mkdirSync(skills, { recursive: true });
    for (const name of ["granted-one", "ambient-two", "ambient-three"]) skill(skills, name, `MARKER-${name}`);
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      ["ambient-two", "ambient-three"]
        .map((name) => `[[skills.config]]\npath = ${JSON.stringify(path.join(skills, name, "SKILL.md"))}\nenabled = false\n`)
        .join("\n"),
    );

    const out = promptInput(path.join(root, "ws"), codexHome);

    expect(out, "a skill left enabled must still be delivered").toContain("MARKER-granted-one");
    expect(out, "a skill disabled by path must not be delivered").not.toContain("MARKER-ambient-two");
    expect(out, "and disabling one must not disable its neighbours by accident").not.toContain("MARKER-ambient-three");
  }, 180_000);

  it("PREMISE 2 — a name collision is resolved by path, not lost to the name", () => {
    // The original refusal existed because a granted skill and a plugin skill share a NAME. If
    // suppression were name-keyed, disabling the ambient copy would disable the granted one too.
    const root = workspace();
    const wsSkills = path.join(root, "ws", ".agents", "skills");
    const homeSkills = path.join(root, "home", ".agents", "skills");
    fs.mkdirSync(wsSkills, { recursive: true });
    fs.mkdirSync(homeSkills, { recursive: true });
    skill(wsSkills, "agent-browser", "MARKER-workspace-copy");
    skill(homeSkills, "agent-browser", "MARKER-granted-copy");
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(
      path.join(codexHome, "config.toml"),
      `[[skills.config]]\npath = ${JSON.stringify(path.join(wsSkills, "agent-browser", "SKILL.md"))}\nenabled = false\n`,
    );

    const out = promptInput(path.join(root, "ws"), codexHome, path.join(root, "home"));

    expect(out, "the suppressed copy must be gone").not.toContain("MARKER-workspace-copy");
    expect(out, "its same-named neighbour must survive").toContain("MARKER-granted-copy");
  }, 180_000);

  it("PREMISE 3 — the user home is a discovery root, so a launch must account for it", () => {
    // `replaceCapturedSkillTree` never covered $HOME/.agents/skills: a hand-written skill in the
    // human's home reached a Codex agent granted none of it. The projection now disables it by path.
    const root = workspace();
    fs.mkdirSync(path.join(root, "ws"), { recursive: true });
    const homeSkills = path.join(root, "home", ".agents", "skills");
    fs.mkdirSync(homeSkills, { recursive: true });
    skill(homeSkills, "ambient-home", "MARKER-home-root");
    const codexHome = path.join(root, "codex-home");
    fs.mkdirSync(codexHome, { recursive: true });

    const out = promptInput(path.join(root, "ws"), codexHome, path.join(root, "home"));

    expect(out, "if this stops holding, the projection is disabling a root that no longer exists")
      .toContain("MARKER-home-root");
  }, 180_000);
});
