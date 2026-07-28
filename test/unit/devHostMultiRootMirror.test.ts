import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// Owned ESM CLI; Vitest loads it directly while the repo typecheck target is CommonJS — the same
// intentional shape `devHostPointer.test.ts` uses for this module.
// @ts-expect-error -- static ESM import is intentional for this executable module test.
import { detectMultiRootFixture, materializeMultiRootMirror, pathsOf } from "../../scripts/dev-host/pointer.mjs";

/**
 * t-f0efc5 — the Dev Host lane can dogfood a MULTI-ROOT window.
 *
 * Until now `point` materialized one mirror directory and F5 opened it as a single folder, so any bug
 * whose hypothesis is "resolves the wrong root in multi-root" had no click-path to reproduce. The
 * fixture already existed (`test/fixtures/multiroot/`) — what was missing was a lane that could
 * materialize a `.code-workspace` from it.
 *
 * What is asserted here is the property the mirror has to keep, not the file layout for its own sake:
 * **each root is mirrored under the same rules a single-root mirror uses**. `tachyon.yml` and
 * `.tachyon/` are real copies (the engine opens config no-follow, and a dogfood must never write back
 * into a tracked fixture), everything else is a symlink so Explorer still shows fixture files. A
 * second policy for multi-root is exactly the drift this test exists to prevent.
 */
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-multiroot-mirror-"));
  roots.push(dir);
  return dir;
}

/** A fixture shaped like `test/fixtures/multiroot/`: two folders and a workspace file naming them. */
function fixture(options: { folders?: string[]; workspace?: unknown; name?: string } = {}): string {
  const dir = tmp();
  for (const folder of options.folders ?? ["alpha", "beta"]) {
    const root = path.join(dir, folder);
    fs.mkdirSync(path.join(root, ".tachyon", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(root, "tachyon.yml"), `agents:\n  ${folder}:\n    cmd: sh\n`);
    fs.writeFileSync(path.join(root, ".tachyon", "tasks", "t-000001.json"), "{}\n");
    fs.writeFileSync(path.join(root, "README.md"), `# ${folder}\n`);
  }
  const declared = options.workspace ?? { folders: (options.folders ?? ["alpha", "beta"]).map((p) => ({ path: p })) };
  fs.writeFileSync(path.join(dir, options.name ?? "multi.code-workspace"), `${JSON.stringify(declared, null, 2)}\n`);
  return dir;
}

describe("detecting a multi-root fixture", () => {
  it("recognizes one by its own contents, not by a flag", () => {
    // `point --fixture multiroot` must do the right thing without the caller knowing which shape it is.
    const detected = detectMultiRootFixture(fixture());
    expect(detected?.folders).toEqual(["alpha", "beta"]);
    expect(detected?.name).toBe("multi.code-workspace");
  });

  it("says a plain fixture is not one", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "tachyon.yml"), "agents: {}\n");
    expect(detectMultiRootFixture(dir)).toBeNull();
  });

  it("refuses a fixture with two workspace files rather than guessing", () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, "second.code-workspace"), '{ "folders": [] }\n');
    expect(() => detectMultiRootFixture(dir)).toThrow(/keep exactly one/);
  });

  it("refuses a folder path that escapes the fixture", () => {
    // The same isolation rule that forbids opening the monorepo root: a mirror may only contain what
    // the lane isolated.
    expect(() => detectMultiRootFixture(fixture({ workspace: { folders: [{ path: "../elsewhere" }] } })))
      .toThrow(/must be a relative path inside the fixture/);
    expect(() => detectMultiRootFixture(fixture({ workspace: { folders: [{ path: "/etc" }] } })))
      .toThrow(/must be a relative path inside the fixture/);
  });

  it("refuses a workspace file that names a folder which is not there", () => {
    expect(() => detectMultiRootFixture(fixture({ workspace: { folders: [{ path: "ghost" }] } })))
      .toThrow(/not an existing directory/);
  });

  it("refuses an empty or malformed workspace file by name", () => {
    expect(() => detectMultiRootFixture(fixture({ workspace: { folders: [] } }))).toThrow(/declares no folders/);
    const dir = fixture();
    fs.writeFileSync(path.join(dir, "multi.code-workspace"), "{ not json\n");
    expect(() => detectMultiRootFixture(dir)).toThrow(/not readable JSON/);
  });
});

describe("materializing the multi-root mirror", () => {
  function materialize(): { base: string; fixtureDir: string; workspaceFile: string; mirror: string } {
    const checkout = tmp();
    const fixtureDir = fixture();
    const p = pathsOf(checkout);
    fs.mkdirSync(p.base, { recursive: true });
    materializeMultiRootMirror(p.workspace, p.workspaceFile, fixtureDir);
    return { base: p.base, fixtureDir, workspaceFile: p.workspaceFile, mirror: p.workspace };
  }

  it("writes a workspace file whose folders point INSIDE the pointer, relatively", () => {
    const { workspaceFile } = materialize();
    const declared = JSON.parse(fs.readFileSync(workspaceFile, "utf8")) as { folders: Array<{ path: string }> };
    // Relative, and under the pointer: an absolute path re-enters WSL on F5 and disconnects the window
    // (the same reason the single-root mirror is a real directory under ${workspaceFolder}).
    expect(declared.folders).toEqual([{ path: "./workspace/alpha" }, { path: "./workspace/beta" }]);
    for (const folder of declared.folders) expect(path.isAbsolute(folder.path)).toBe(false);
  });

  it("mirrors EVERY declared root, each resolvable from the workspace file", () => {
    const { workspaceFile, base } = materialize();
    const declared = JSON.parse(fs.readFileSync(workspaceFile, "utf8")) as { folders: Array<{ path: string }> };
    for (const folder of declared.folders) {
      const resolved = path.resolve(path.dirname(workspaceFile), folder.path);
      expect(fs.existsSync(resolved), `${folder.path} is declared but not mirrored`).toBe(true);
      expect(resolved.startsWith(path.resolve(base))).toBe(true);
    }
  });

  it("applies the single-root rules PER ROOT: config copied, everything else symlinked", () => {
    const { mirror } = materialize();
    for (const folder of ["alpha", "beta"]) {
      const root = path.join(mirror, folder);
      // tachyon.yml: a real file. The engine opens authoritative config no-follow, so a symlink fails
      // closed with ELOOP during a real Studio save.
      expect(fs.lstatSync(path.join(root, "tachyon.yml")).isSymbolicLink()).toBe(false);
      // .tachyon: a real directory. AgentManager fails closed when it resolves outside the workspace.
      expect(fs.lstatSync(path.join(root, ".tachyon")).isSymbolicLink()).toBe(false);
      expect(fs.existsSync(path.join(root, ".tachyon", "tasks", "t-000001.json"))).toBe(true);
      // everything else stays a symlink so Explorer still shows the fixture's files
      expect(fs.lstatSync(path.join(root, "README.md")).isSymbolicLink()).toBe(true);
    }
  });

  it("keeps a dogfood mutation inside the mirror, never in the tracked fixture", () => {
    // The whole reason config is copied rather than linked: this is what a dogfooder does.
    const { mirror, fixtureDir } = materialize();
    fs.writeFileSync(path.join(mirror, "alpha", "tachyon.yml"), "agents:\n  mutated:\n    cmd: sh\n");
    expect(fs.readFileSync(path.join(fixtureDir, "alpha", "tachyon.yml"), "utf8")).toContain("alpha:");
    expect(fs.readFileSync(path.join(fixtureDir, "alpha", "tachyon.yml"), "utf8")).not.toContain("mutated");
  });

  it("records provenance for the whole mirror AND for each root", () => {
    const { mirror, fixtureDir } = materialize();
    expect(fs.readFileSync(path.join(mirror, ".dev-host-source"), "utf8").trim()).toBe(fixtureDir);
    for (const folder of ["alpha", "beta"]) {
      expect(fs.readFileSync(path.join(mirror, folder, ".dev-host-source"), "utf8").trim())
        .toBe(path.join(fixtureDir, folder));
    }
  });

  it("does not copy the fixture's own workspace file into the mirror", () => {
    // The lane writes its own, with paths rewritten to the mirrored folders; keeping the fixture's
    // would leave a second file naming the ORIGINAL folders, one click away from opening them.
    const { mirror } = materialize();
    expect(fs.readdirSync(mirror).filter((n) => n.endsWith(".code-workspace"))).toEqual([]);
  });

  it("re-materializing replaces the previous mirror rather than merging into it", () => {
    const checkout = tmp();
    const p = pathsOf(checkout);
    fs.mkdirSync(path.dirname(p.workspace), { recursive: true });
    materializeMultiRootMirror(p.workspace, p.workspaceFile, fixture({ folders: ["alpha", "beta"] }));
    materializeMultiRootMirror(p.workspace, p.workspaceFile, fixture({ folders: ["gamma"] }));
    expect(fs.existsSync(path.join(p.workspace, "gamma"))).toBe(true);
    // a leftover root would open as a stale extra folder in the EDH, reading as a product bug
    expect(fs.existsSync(path.join(p.workspace, "alpha"))).toBe(false);
  });
});
