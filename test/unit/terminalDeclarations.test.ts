import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProfileAwareConfig } from "../../src/config/agentProfileConfigLoader.js";
import {
  cloneTerminalDeclaration,
  deleteTerminalDeclaration,
  renameTerminalDeclaration,
  upsertTerminalDeclaration,
} from "../../src/config/terminalDeclarations.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function root(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-terminals-")); roots.push(value); return value; }
function load(workspaceRoot: string, yamlText = "settings: {}\n") {
  return loadProfileAwareConfig({ yamlText, workspaceRoot, authorities: new Map() });
}

describe("terminal declaration actor × trigger doors", () => {
  it("Terminal Studio create", () => {
    const workspaceRoot = root();
    upsertTerminalDeclaration(workspaceRoot, "dev", { cmd: "npm run dev", kind: "terminal" });
    expect(fs.readFileSync(path.join(workspaceRoot, ".tachyon/terminals/dev.yml"), "utf8")).toContain("cmd: npm run dev");
    expect(load(workspaceRoot).config?.agents.dev?.kind).toBe("terminal");
  });

  it("Terminal Studio edit", () => {
    const workspaceRoot = root();
    upsertTerminalDeclaration(workspaceRoot, "dev", { cmd: "old", kind: "terminal" });
    upsertTerminalDeclaration(workspaceRoot, "dev", { cmd: "new", kind: "terminal" }, "dev");
    expect(load(workspaceRoot).config?.agents.dev?.cmd).toBe("new");
  });

  it("Terminal Studio edit preserves fields its form does not author", () => {
    const workspaceRoot = root();
    upsertTerminalDeclaration(workspaceRoot, "dev", {
      cmd: "old", kind: "terminal", env: { API: "http://localhost" },
      attention: { enabled: true, silenceSec: 30, patterns: ["approval"] },
    });
    upsertTerminalDeclaration(workspaceRoot, "dev", { cmd: "new", kind: "terminal", attention: false }, "dev");
    expect(load(workspaceRoot).config?.agents.dev).toMatchObject({
      cmd: "new", environment: { values: { API: "http://localhost" } },
      attention: { enabled: false, silenceSec: 30, patterns: ["approval"] },
    });
  });

  it("promote instance to yml", () => {
    const workspaceRoot = root();
    upsertTerminalDeclaration(workspaceRoot, "promoted", { cmd: "bash", kind: "terminal" });
    expect(load(workspaceRoot).config?.agents.promoted?.cmd).toBe("bash");
  });

  it("bloco legado editado à mão", () => {
    const result = load(root(), "terminals:\n  legacy:\n    cmd: bash\n");
    expect(result.config?.agents.legacy?.kind).toBe("terminal");
    expect(result.warnings.join("\n")).toContain(".tachyon/terminals/<name>.yml");
  });

  it("clone", () => {
    const workspaceRoot = root();
    upsertTerminalDeclaration(workspaceRoot, "dev", { cmd: "bash", kind: "terminal" });
    cloneTerminalDeclaration(workspaceRoot, "dev", "dev-copy");
    expect(load(workspaceRoot).config?.agents["dev-copy"]?.cmd).toBe("bash");
  });

  it("rename", () => {
    const workspaceRoot = root();
    upsertTerminalDeclaration(workspaceRoot, "dev", { cmd: "bash", kind: "terminal" });
    renameTerminalDeclaration(workspaceRoot, "dev", "server");
    expect(load(workspaceRoot).config?.agents.server?.cmd).toBe("bash");
    expect(load(workspaceRoot).config?.agents.dev).toBeUndefined();
  });

  it("delete", () => {
    const workspaceRoot = root();
    upsertTerminalDeclaration(workspaceRoot, "dev", { cmd: "bash", kind: "terminal" });
    deleteTerminalDeclaration(workspaceRoot, "dev");
    expect(load(workspaceRoot).config?.agents.dev).toBeUndefined();
  });
});

it("fail-before: legacy and directory declarations produce the same roster", () => {
  const workspaceRoot = root();
  upsertTerminalDeclaration(workspaceRoot, "dev", { cmd: "npm run dev", cwd: "app", kind: "terminal" });
  const modern = load(workspaceRoot).config?.agents.dev;
  fs.rmSync(path.join(workspaceRoot, ".tachyon"), { recursive: true });
  const legacy = load(workspaceRoot, "terminals:\n  dev:\n    cmd: npm run dev\n    cwd: app\n").config?.agents.dev;
  expect(modern).toEqual(legacy);
});
