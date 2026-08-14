import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runI18nPtbrStagedGate } from "../../apps/vscode-extension/src/plugins/i18nPtbrGate.js";

const dirs: string[] = [];
const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function gitOk(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tach-i18n-gate-"));
  dirs.push(dir);
  execFileSync("git", ["init", "-q"], { cwd: dir, env: ENV });
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, "l10n"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src/seed.ts"), 'vscode.l10n.t("Existing");\n');
  fs.writeFileSync(path.join(dir, "l10n/bundle.l10n.pt-br.json"), `${JSON.stringify({ Existing: "Existente" }, null, 2)}\n`);
  execFileSync("git", ["add", "-A"], { cwd: dir, env: ENV });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir, env: ENV });
  return dir;
}

function runGate(root: string): { code: number; err: string } {
  let err = "";
  const code = runI18nPtbrStagedGate({ workspaceRoot: root, stderr: { write: (s: string | Uint8Array) => { err += String(s); return true; } } });
  return { code, err };
}

describe.skipIf(!gitOk())("i18n pt-BR staged pre-commit gate", () => {
  it("passes when staged TypeScript adds no untranslated l10n key", () => {
    const root = makeRepo();
    fs.writeFileSync(path.join(root, "src/clean.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "src/clean.ts"], { cwd: root, env: ENV });
    expect(runGate(root)).toEqual({ code: 0, err: "" });
  });

  it("blocks a staged l10n.t key missing from the staged pt-BR bundle", () => {
    const root = makeRepo();
    fs.writeFileSync(path.join(root, "src/missing.ts"), 'vscode.l10n.t("Needs translation");\n');
    execFileSync("git", ["add", "src/missing.ts"], { cwd: root, env: ENV });
    const r = runGate(root);
    expect(r.code).toBe(1);
    expect(r.err).toContain('"Needs translation"');
    expect(r.err).toContain("l10n/bundle.l10n.pt-br.json");
  });

  it("passes when the same staged commit adds the pt-BR translation", () => {
    const root = makeRepo();
    fs.writeFileSync(path.join(root, "src/translated.ts"), 'vscode.l10n.t("New translated");\n');
    fs.writeFileSync(path.join(root, "l10n/bundle.l10n.pt-br.json"), `${JSON.stringify({ Existing: "Existente", "New translated": "Novo traduzido" }, null, 2)}\n`);
    execFileSync("git", ["add", "src/translated.ts", "l10n/bundle.l10n.pt-br.json"], { cwd: root, env: ENV });
    expect(runGate(root)).toEqual({ code: 0, err: "" });
  });

  it("fails open on operational errors", () => {
    let err = "";
    const code = runI18nPtbrStagedGate({
      workspaceRoot: "/nope",
      git: () => ({ status: 128, stdout: "", stderr: "fatal" }),
      stderr: { write: (s: string | Uint8Array) => { err += String(s); return true; } },
    });
    expect(code).toBe(0);
    expect(err).toContain("skipping gate");
  });
});
