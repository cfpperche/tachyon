import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HarnessManager, bridgeGrokHome } from "../../src/harness/HarnessManager.js";
import { RESUME_RUNTIMES, adapterForRuntime } from "../../src/resume/adapters.js";
import { makeTempDir } from "../helpers/tempDir.js";

function fixture() {
  const workspace = makeTempDir("tachyon-runtime-retire-");
  const home = bridgeGrokHome(workspace, "ghost");
  fs.mkdirSync(path.join(home, "cache"), { recursive: true });
  fs.writeFileSync(path.join(home, "auth.json"), '{"token":"secret"}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(home, "cache", "model.bin"), "cache");
  return { workspace, home, manager: new HarnessManager(workspace) };
}

describe("t-14cf7c runtime-home credential retirement", () => {
  it("covers every supported runtime that declares credential-bearing private homes", () => {
    const credentialRuntimes = RESUME_RUNTIMES.filter((runtime) => (adapterForRuntime(runtime)?.harness?.authFiles.length ?? 0) > 0);
    expect(credentialRuntimes.sort()).toEqual(["claude", "codex", "grok", "hermes", "opencode"].sort());
  });
  it("removes authority but deliberately retains reinstall cache", () => {
    const f = fixture();
    f.manager.retireCredentials("ghost", { procRoot: path.join(f.workspace, "no-proc") });
    expect(fs.existsSync(path.join(f.home, "auth.json"))).toBe(false);
    expect(fs.readFileSync(path.join(f.home, "cache", "model.bin"), "utf8")).toBe("cache");
  });

  it("refuses an occupied runtime home", () => {
    const f = fixture();
    const proc = path.join(f.workspace, "proc");
    fs.mkdirSync(path.join(proc, "4242"), { recursive: true });
    fs.symlinkSync(f.home, path.join(proc, "4242", "cwd"));
    expect(() => f.manager.retireCredentials("ghost", { procRoot: proc })).toThrow(/occupied/);
    expect(fs.existsSync(path.join(f.home, "auth.json"))).toBe(true);
  });

  it("refuses a dirty credential changed after measurement", () => {
    const f = fixture();
    expect(() => f.manager.retireCredentials("ghost", {
      procRoot: path.join(f.workspace, "no-proc"),
      beforeDelete: (credential) => fs.appendFileSync(credential, "changed"),
    })).toThrow(/dirty/);
    expect(fs.existsSync(path.join(f.home, "auth.json"))).toBe(true);
  });

  it("discovers credential-bearing orphan candidates without deleting them", () => {
    const f = fixture();
    expect(f.manager.credentialHomeNames()).toEqual(["ghost"]);
    expect(fs.existsSync(path.join(f.home, "auth.json"))).toBe(true);
  });
});
