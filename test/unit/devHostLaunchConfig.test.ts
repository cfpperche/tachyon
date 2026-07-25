import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// The dev-host launch spec is plain ESM and has no separate declaration surface.
// @ts-expect-error -- comparing against the SHARED source is the point of these cases.
import { devHostEnv, devHostArgs, DEV_HOST_ENV_KEYS } from "../../scripts/dev-host/launch-spec.mjs";

/**
 * spec 448 — `.vscode/launch.json` is a STATIC, COMMITTED file: the dev-host belongs to the checkout,
 * so the same entry is correct everywhere and nothing generates it.
 *
 * This test exists because of a real miss. The inversion landed while `launch.json` still pointed at
 * the removed `dev-host/active/…` indirection, so F5 handed VS Code a path that did not exist: the EDH
 * opened a phantom empty "workspace" and the Tachyon views rendered blank. **The headless harness did
 * not catch it and structurally cannot** — `headless-session.mjs` launches VS Code through the CLI with
 * its own computed paths and never reads `launch.json`. F5 and headless exercise different wiring, so
 * the F5 wiring needs its own assertion.
 */

const repoRoot = process.cwd();
const LAUNCH = path.join(repoRoot, ".vscode", "launch.json");
const DEV_HOST_CONFIG = "Tachyon: Dev Host";

function readLaunchConfigurations(): Array<Record<string, unknown>> {
  // launch.json is jsonc — VS Code allows comments; strip line comments before parsing.
  const raw = fs.readFileSync(LAUNCH, "utf8").replace(/^\s*\/\/.*$/gm, "");
  return JSON.parse(raw).configurations as Array<Record<string, unknown>>;
}

/** Every `${workspaceFolder}`-relative filesystem path the config points at. */
function referencedPaths(config: Record<string, unknown>): string[] {
  const out: string[] = [];
  const take = (value: unknown) => {
    if (typeof value !== "string" || !value.includes("${workspaceFolder}")) return;
    out.push(
      value
        .replace("--extensionDevelopmentPath=", "")
        .replace("${workspaceFolder}", repoRoot)
        .split("/**")[0],
    );
  };
  for (const arg of (config.args as unknown[]) ?? []) take(arg);
  for (const value of Object.values((config.env as Record<string, unknown>) ?? {})) take(value);
  for (const out_ of (config.outFiles as unknown[]) ?? []) take(out_);
  return out;
}

describe("dev-host launch config (spec 448)", () => {
  it("resolves the dev-host through the checkout, with no `active` indirection and no slot entries", () => {
    const configs = readLaunchConfigurations();
    const devHost = configs.find((c) => c.name === DEV_HOST_CONFIG);
    expect(devHost, `${DEV_HOST_CONFIG} must exist in launch.json`).toBeDefined();

    const paths = referencedPaths(devHost!);
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) {
      expect(p, "dev-host paths are checkout-relative").toContain(path.join(repoRoot, ".tachyon", "dev-host"));
      expect(p, "the `active` symlink was removed by spec 448").not.toContain(`${path.sep}active${path.sep}`);
      expect(p, "slots were removed by spec 448").not.toContain(`${path.sep}slots${path.sep}`);
    }

    // Per-slot entries ("Tachyon: Dev Host · <id>") were generated into this tracked file by the old
    // pointer, which is what kept the primary checkout permanently dirty.
    const slotEntries = configs.filter((c) => String(c.name ?? "").startsWith(`${DEV_HOST_CONFIG} ·`));
    expect(slotEntries.map((c) => c.name), "launch.json must carry no generated per-slot entries").toEqual([]);
  });

  it("is machine-independent — no absolute paths that would force a WSL re-entry", () => {
    // docs/runbooks/dev-host.md warns that machine-local absolute paths drop the Remote-WSL session.
    const raw = fs.readFileSync(LAUNCH, "utf8");
    const devHostLines = raw.split("\n").filter((l) => l.includes(".tachyon/dev-host"));
    expect(devHostLines.length).toBeGreaterThan(0);
    for (const line of devHostLines) {
      expect(line, "dev-host paths must go through ${workspaceFolder}").toContain("${workspaceFolder}");
      expect(line, "no absolute home paths").not.toMatch(/["=]\/home\//);
    }
  });

  it("loads TMUX_TMPDIR from launch.env (short AF_UNIX path), not a deep workspaceFolder path", () => {
    // Deep worktree …/.tachyon/dev-host/tmux/tmux-<uid>/tachyon exceeds sun_path (~108) and
    // agent spawn fails with "File name too long". pointer writes a short runtime dir into launch.env.
    const configs = readLaunchConfigurations();
    const devHost = configs.find((c) => c.name === DEV_HOST_CONFIG)!;
    expect(devHost.envFile, "envFile carries the short TMUX_TMPDIR").toBe(
      "${workspaceFolder}/.tachyon/dev-host/launch.env",
    );
    const env = (devHost.env as Record<string, string>) ?? {};
    expect(env.TMUX_TMPDIR, "committed launch.json must not hardcode a deep TMUX_TMPDIR").toBeUndefined();
  });

  it("is not written by any script — it is committed, not generated", () => {
    const scriptsDir = path.join(repoRoot, "scripts");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(mjs|js|ts|sh)$/.test(entry.name)) continue;
        const source = fs.readFileSync(full, "utf8");
        // A script may *read* launch.json; writing it is what spec 448 removed.
        if (/writeFileSync\([^)]*launch\.json/.test(source) || /launchPath[^\n]*writeFileSync/.test(source)) {
          offenders.push(path.relative(repoRoot, full));
        }
      }
    };
    walk(scriptsDir);
    expect(offenders, "no script may write .vscode/launch.json").toEqual([]);
  });

  // ── t-6bc30d — F5 and headless must describe the same launch ────────────────
  // The note above says the headless harness "structurally cannot" catch an F5 break, and that was
  // true while the two assembled their command lines independently. They now share the half that
  // says WHAT is being run, and these cases keep them from drifting apart again.

  it("declares exactly the environment the shared spec defines", () => {
    const config = readLaunchConfigurations().find((c) => c.name === DEV_HOST_CONFIG)!;
    const declared = Object.keys((config.env as Record<string, unknown>) ?? {}).sort();
    // Missing a key means F5 runs with an environment headless never exercises. An EXTRA key is just
    // as bad in reverse: headless would go green without it and F5 would depend on it.
    expect(declared).toEqual([...DEV_HOST_ENV_KEYS].sort());
  });

  it("points every shared env var at the same slot-relative location as the harness", () => {
    const config = readLaunchConfigurations().find((c) => c.name === DEV_HOST_CONFIG)!;
    const env = config.env as Record<string, string>;
    // F5's slot is the checkout's own dev-host directory; substitute it and the two must agree.
    const expected = devHostEnv("${workspaceFolder}/.tachyon/dev-host") as Record<string, string>;
    expect(env).toEqual(expected);
  });

  it("passes the same defining arguments the harness passes", () => {
    const config = readLaunchConfigurations().find((c) => c.name === DEV_HOST_CONFIG)!;
    const expected = devHostArgs({
      workspaceDir: "${workspaceFolder}/.tachyon/dev-host/workspace",
      extensionPath: "${workspaceFolder}/.tachyon/dev-host/extension",
    }) as string[];
    expect(config.args).toEqual(expected);
  });

  it("carries none of the headless-only plumbing", () => {
    // Those flags exist because nobody is watching a headless run. Requiring them here would shape
    // the human path like the robot one, which is the wrong direction for this whole guard.
    const config = readLaunchConfigurations().find((c) => c.name === DEV_HOST_CONFIG)!;
    const args = (config.args as string[]).join(" ");
    for (const flag of ["--user-data-dir", "--remote-debugging-port", "--disable-gpu", "--new-window", "--skip-welcome"]) {
      expect(args, `${flag} is headless plumbing, not part of the F5 path`).not.toContain(flag);
    }
  });

  it("keeps the harness reading the shared spec rather than its own copy", () => {
    // The drift returns the moment headless-session.mjs re-inlines the list, and that would not fail
    // any assertion above — the two would simply be equal until someone edits one of them.
    const harness = fs.readFileSync(path.join(repoRoot, "scripts/dev-host/headless-session.mjs"), "utf8");
    expect(harness).toContain("devHostEnv(slotRoot)");
    expect(harness).toContain("devHostArgs({ workspaceDir, extensionPath })");
  });
});
