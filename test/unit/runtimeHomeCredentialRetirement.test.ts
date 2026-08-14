import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HarnessManager,
  bridgeGrokHome,
  bridgeHermesHome,
  bridgeMcpPath,
  bridgeOpencodeMcpPath,
  bridgeMcpRoot,
  bridgeRuntimeHome,
  listBridgeRuntimeHomes,
  measureDirUsage,
} from "@tachyon/engine/harness/HarnessManager.js";
import { RESUME_RUNTIMES, adapterForRuntime } from "@tachyon/shared/resume/adapters.js";
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

/**
 * t-7bc276 — the BYTES around the credential. `retireCredentials` above removes authority and leaves
 * the directory; measured 2026-08-07, that directory costs ~12.9 MB the moment a grok agent takes its
 * first turn (`bundled/` alone is 12.84 MB and identical in every home), and 35 dismissed ones had
 * reached 2.2 GB. Nothing reads any of it once the agent is gone: the two survivors that still touch
 * the path read the dirent NAME (`detectRuntimes`) and an `auth.json` that retirement already deleted.
 *
 * The removal was never missing — `removeBridgeMcp` has always deleted exactly these two directories.
 * What was missing is any enumerator that could NAME one: `list()` reads `.tachyon/harness/` and
 * `listBridgeMcp()` filters `isFile() && .json`, and a non-harness grok/hermes agent creates neither.
 */
describe("t-7bc276 private bridge-mcp runtime home retirement", () => {
  const seed = (workspace: string, agent: string, runtime: "grok" | "hermes", bytes: number): string => {
    const home = bridgeRuntimeHome(workspace, agent, runtime);
    fs.mkdirSync(path.join(home, "sessions", "s1"), { recursive: true });
    fs.writeFileSync(path.join(home, "sessions", "s1", "chat_history.jsonl"), "x".repeat(bytes), "utf8");
    return home;
  };
  const noProc = (workspace: string) => path.join(workspace, "no-proc");
  const procHolding = (workspace: string, cwd: string): string => {
    const proc = path.join(workspace, "proc");
    fs.mkdirSync(path.join(proc, "4242"), { recursive: true });
    fs.symlinkSync(cwd, path.join(proc, "4242", "cwd"));
    return proc;
  };

  it("decodes every private home back to its (agent, runtime) and claims nothing else in the root", () => {
    const workspace = makeTempDir("tachyon-runtime-scan-");
    seed(workspace, "alpha", "grok", 10);
    seed(workspace, "beta", "hermes", 10);
    // The two artifacts that share this root and are NOT private homes: claude's and opencode's bridge
    // FILES. They are why the original sweep filtered `isFile()`, and they must stay unclaimed here.
    fs.writeFileSync(path.join(bridgeMcpRoot(workspace), "alpha.json"), "{}\n", "utf8");
    fs.writeFileSync(path.join(bridgeMcpRoot(workspace), "alpha.opencode.json"), "{}\n", "utf8");
    // A suffix-only directory decodes to an EMPTY agent name that no keep-set can match — left alone.
    fs.mkdirSync(path.join(bridgeMcpRoot(workspace), ".grok"), { recursive: true });

    expect(listBridgeRuntimeHomes(workspace).map((home) => `${home.agent}:${home.runtime}`)).toEqual(["alpha:grok", "beta:hermes"]);
  });

  it("claims every path the product can materialize a private home at", () => {
    const workspace = makeTempDir("tachyon-runtime-cover-");
    // Derived from the MATERIALIZERS, not from the scan's own constant. That direction is the whole
    // point: `bridgeGrokHome` shipped with t-843576 and joined no enumeration, and a test written from
    // the scan's side would have agreed with itself while 2.2 GB accumulated.
    const materialized = [bridgeGrokHome(workspace, "solo"), bridgeHermesHome(workspace, "solo")];
    for (const home of materialized) fs.mkdirSync(home, { recursive: true });
    expect(listBridgeRuntimeHomes(workspace).map((home) => home.path).sort()).toEqual([...materialized].sort());
  });

  it("removes both private homes and reports what left the disk", () => {
    const workspace = makeTempDir("tachyon-runtime-retire-homes-");
    seed(workspace, "solo", "grok", 4096);
    seed(workspace, "solo", "hermes", 2048);
    const manager = new HarnessManager(workspace);

    const seen: string[] = [];
    const outcomes = manager.retireBridgeRuntimeHomes("solo", {
      procRoot: noProc(workspace),
      onOutcome: (o) => seen.push(`${o.runtime}:${o.bytes}:${o.files}:${o.removed}`),
    });

    // The receipt is the point: silence is what let this reach 2.2 GB unnoticed.
    expect(seen).toEqual(["grok:4096:1:true", "hermes:2048:1:true"]);
    expect(outcomes.every((outcome) => outcome.removed)).toBe(true);
    expect(fs.existsSync(bridgeGrokHome(workspace, "solo"))).toBe(false);
    expect(fs.existsSync(bridgeHermesHome(workspace, "solo"))).toBe(false);
  });

  it("removes the file-shaped Bridge configs used by non-harness runtimes at the same end-of-life door", () => {
    const workspace = makeTempDir("tachyon-runtime-retire-files-");
    const manager = new HarnessManager(workspace);
    const claudeConfig = bridgeMcpPath(workspace, "solo");
    const opencodeConfig = bridgeOpencodeMcpPath(workspace, "solo");
    fs.mkdirSync(path.dirname(claudeConfig), { recursive: true });
    fs.writeFileSync(claudeConfig, "{}\n");
    fs.writeFileSync(opencodeConfig, "{}\n");

    manager.retireBridgeRuntimeHomes("solo", { procRoot: noProc(workspace) });

    expect(fs.existsSync(claudeConfig)).toBe(false);
    expect(fs.existsSync(opencodeConfig)).toBe(false);
  });

  it("names a home a live process still sits in and leaves it standing", () => {
    const workspace = makeTempDir("tachyon-runtime-retire-busy-");
    const home = seed(workspace, "busy", "grok", 512);
    const manager = new HarnessManager(workspace);

    const outcomes = manager.retireBridgeRuntimeHomes("busy", { procRoot: procHolding(workspace, path.join(home, "sessions")) });

    // Measured and named, but never pulled out from under the process — and never thrown over either:
    // a dismissal that fails because garbage collection failed is worse than the garbage.
    expect(outcomes.map((o) => [o.runtime, o.removed, o.bytes])).toEqual([["grok", false, 512]]);
    expect(outcomes[0].heldBy).toBe(path.join(home, "sessions"));
    expect(fs.existsSync(home)).toBe(true);
  });

  it("answers with a floor rather than a stat storm when a home is larger than the walk budget", () => {
    const workspace = makeTempDir("tachyon-runtime-measure-cap-");
    const home = bridgeRuntimeHome(workspace, "huge", "grok");
    fs.mkdirSync(path.join(home, "bundled"), { recursive: true });
    for (let i = 0; i < 12; i += 1) fs.writeFileSync(path.join(home, "bundled", `asset-${i}.bin`), "xxxx", "utf8");

    // Unbounded: the exact answer.
    expect(measureDirUsage(home)).toEqual({ bytes: 48, files: 12, truncated: false });
    // Bounded: a FLOOR, flagged as one. The report on the startup path takes this shape because the
    // measured tree held 41,948 files and no notification is worth that many stat calls before start.
    const capped = measureDirUsage(home, 5);
    expect(capped.truncated).toBe(true);
    expect(capped.files).toBe(5);
    expect(capped.bytes).toBeLessThan(48);
  });

  it("says nothing about a runtime whose private home was never materialized, and is idempotent", () => {
    const workspace = makeTempDir("tachyon-runtime-retire-partial-");
    seed(workspace, "grok-only", "grok", 8);
    const manager = new HarnessManager(workspace);
    expect(manager.retireBridgeRuntimeHomes("grok-only", { procRoot: noProc(workspace) }).map((o) => o.runtime)).toEqual(["grok"]);
    expect(manager.retireBridgeRuntimeHomes("grok-only", { procRoot: noProc(workspace) })).toEqual([]);
  });
});
