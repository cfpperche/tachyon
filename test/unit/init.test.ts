import { writeWorkspaceConfig } from "../helpers/writeWorkspaceConfig.js";
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectStack, buildStarterFiles, ensureTachyonGitignore, TACHYON_GITIGNORE_ENTRIES, type DetectedProject, type StarterFiles } from "../../apps/vscode-extension/src/init/initLogic.js";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** t-a65335 — the starter is files now; compose them into the document shape the loader validates. */
function composeStarter(starter: StarterFiles): string {
  return stringifyYaml({
    settings: parseYaml(starter.settingsYaml) ?? {},
    terminals: Object.fromEntries(starter.terminals.map((t) => [t.name, parseYaml(t.yaml)])),
  });
}
const buildStarterYaml = (p: DetectedProject): string => composeStarter(buildStarterFiles(p));
import { parseConfig } from "@tachyon/engine/config/loadConfig.js";
import { parseProfileAwareConfigSyntax } from "@tachyon/engine/config/agentProfileConfigLoader.js";

const base = (over: Partial<DetectedProject> = {}): DetectedProject => ({
  files: [],
  installedClis: ["claude"],
  ...over,
});

/**
 * Every generated starter must parse clean and carry a shell.
 *
 * SDD 478 M6 — it must also pass the CANONICAL door, which is what the old starter failed: it wrote
 * an inline `agents:` entry that `parseProfileAwareConfigSyntax` refuses, so Init handed a new
 * workspace a config the product would not load. Agents now come from Agent Studio.
 */
function expectValidStarter(yaml: string) {
  const { config, errors } = parseConfig(yaml);
  expect(errors).toEqual([]);
  expect(config).toBeDefined();
  expect(parseProfileAwareConfigSyntax(yaml).errors, yaml).toEqual([]);
  expect(config!.agents.shell?.kind).toBe("terminal");
  // Everything the starter declares is a terminal; agents are created in Agent Studio.
  expect(Object.values(config!.agents).filter((a) => a.kind === "agent")).toEqual([]);
  return config!;
}

describe("detectStack", () => {
  it("Node: scripts.dev/test become terminals; framework flavors the label", () => {
    const r = detectStack(base({
      files: ["package.json"],
      packageJson: { scripts: { dev: "vite", test: "vitest" }, dependencies: { vite: "^5" } },
    }));
    expect(r.label).toBe("Node.js (Vite)");
    expect(r.terminals.map((t) => t.cmd)).toEqual(["npm run dev", "npm test"]);
    expect(r.terminals[0].watch).toBe("src/**");
  });

  it("Node: falls back to scripts.start when no dev; no test when absent", () => {
    const r = detectStack(base({ files: ["package.json"], packageJson: { scripts: { start: "node ." } } }));
    expect(r.terminals.map((t) => t.cmd)).toEqual(["npm run start"]);
  });

  it("PHP: Laravel vs plain", () => {
    expect(detectStack(base({ files: ["composer.json"], composerJson: '{"require":{"laravel/framework":"^11"}}' })).terminals[0].cmd).toBe("php artisan serve");
    expect(detectStack(base({ files: ["composer.json"], composerJson: "{}" })).terminals[0].cmd).toContain("php -S");
  });

  it("Rust / Go / Python / Ruby recipes", () => {
    expect(detectStack(base({ files: ["Cargo.toml"] })).terminals[0].cmd).toBe("cargo run");
    expect(detectStack(base({ files: ["go.mod"] })).terminals[0].cmd).toBe("go run .");
    expect(detectStack(base({ files: ["pyproject.toml"] })).label).toBe("Python");
    expect(detectStack(base({ files: ["requirements.txt"] })).label).toBe("Python");
    expect(detectStack(base({ files: ["Gemfile"], gemfile: "gem 'rails'" })).terminals[0].cmd).toBe("bin/rails server");
    expect(detectStack(base({ files: ["Gemfile"], gemfile: "gem 'sinatra'" })).terminals[0].cmd).toBe("ruby main.rb");
  });

  it("no manifest → generic, no terminals", () => {
    const r = detectStack(base({ files: [] }));
    expect(r.label).toBe("generic");
    expect(r.terminals).toEqual([]);
  });
});

describe("buildStarterYaml", () => {
  it("Node starter parses clean: dev/test terminals + shell, agents via Agent Studio", () => {
    const yaml = buildStarterYaml(base({
      files: ["package.json"],
      packageJson: { scripts: { dev: "next dev", test: "jest" }, dependencies: { next: "^14" } },
    }));
    const config = expectValidStarter(yaml);
    expect(config.agents.dev.cmd).toBe("npm run dev");
    expect(config.agents.dev.kind).toBe("terminal");
    expect(config.agents.test.cmd).toBe("npm test");
    expect(buildStarterFiles(base({
      files: ["package.json"],
      packageJson: { scripts: { dev: "next dev", test: "jest" }, dependencies: { next: "^14" } },
    })).settingsYaml).toContain("Detected stack: Node.js (Next.js)");
    expect(buildStarterFiles(base({ files: [] })).settingsYaml).toContain("Agent Studio");
  });

  it("no-manifest starter is minimal but valid (shell only)", () => {
    const config = expectValidStarter(buildStarterYaml(base({ files: [] })));
    expect(Object.keys(config.agents).sort()).toEqual(["shell"]);
  });

  it("names the detected CLI in the Agent Studio pointer; says so honestly when none is detected", () => {
    expect(buildStarterFiles(base({ files: [], installedClis: ["codex"] })).settingsYaml).toContain("codex was detected");
    const none = buildStarterFiles(base({ files: [], installedClis: [] })).settingsYaml;
    expect(none).toContain("no supported AI CLI was detected"); // honest comment
    expect(none).not.toContain("was detected on this machine)"); // and no false claim of detection
  });

  it("every stack produces a config that round-trips through parseConfig", () => {
    const cases: DetectedProject[] = [
      base({ files: ["package.json"], packageJson: { scripts: { dev: "vite" } } }),
      base({ files: ["composer.json"], composerJson: '{"require":{"laravel/framework":"^11"}}' }),
      base({ files: ["Cargo.toml"] }),
      base({ files: ["go.mod"] }),
      base({ files: ["pyproject.toml"] }),
      base({ files: ["Gemfile"], gemfile: "gem 'rails'" }),
      base({ files: [] }),
    ];
    for (const c of cases) expectValidStarter(buildStarterYaml(c));
  });
});

describe("ensureTachyonGitignore", () => {
  it("creates the block on a fresh repo (no .gitignore yet)", () => {
    const out = ensureTachyonGitignore(undefined);
    expect(out).toContain(".tachyon/*");
    expect(out).not.toContain(".tachyon/git-deliveries/");
    expect(out).toContain("!.tachyon/HANDOFF.md");
    expect(out).toContain("!.tachyon/plugins.lock.json");
    expect(out).toContain("# Tachyon");
    expect(out).not.toMatch(/^\n/); // no ugly leading blank line
  });

  it("appends to an existing .gitignore, preserving prior content + separating", () => {
    const out = ensureTachyonGitignore("node_modules\ndist\n");
    expect(out).toContain("node_modules");
    expect(out).toContain("dist");
    expect(out).toContain(".tachyon/*");
    expect(out).toBe("node_modules\ndist\n\n# Tachyon — machine-local state (HANDOFF.md and plugins.lock.json stay shareable)\n" + TACHYON_GITIGNORE_ENTRIES.join("\n") + "\n");
  });

  it("handles a file with no trailing newline", () => {
    const out = ensureTachyonGitignore("dist");
    expect(out).toBe("dist\n\n# Tachyon — machine-local state (HANDOFF.md and plugins.lock.json stay shareable)\n" + TACHYON_GITIGNORE_ENTRIES.join("\n") + "\n");
  });

  it("is idempotent — returns null when all entries are already present", () => {
    expect(ensureTachyonGitignore(`dist\n${TACHYON_GITIGNORE_ENTRIES.join("\n")}\n`)).toBeNull();
  });

  it("appends only missing entries when the wildcard is already present", () => {
    const out = ensureTachyonGitignore("dist\n.tachyon/*\n");
    expect(out).toContain("!.tachyon/HANDOFF.md");
    expect(out).not.toMatch(/\.tachyon\/\*[\s\S]*\.tachyon\/\*/); // wildcard not duplicated
  });

  it("respects a whole-dir ignore (.tachyon/) — no churn", () => {
    expect(ensureTachyonGitignore(".tachyon/\n")).toBeNull();
    expect(ensureTachyonGitignore(".tachyon\n")).toBeNull();
  });

  it("reopens only the two committed Tachyon files", () => {
    const entries = (ensureTachyonGitignore(undefined) ?? "").split("\n").filter((l) => l && !l.startsWith("#"));
    expect(entries).toEqual([".tachyon/*", "!.tachyon/HANDOFF.md", "!.tachyon/plugins.lock.json"]);
  });
});

/**
 * t-4290d0 — the junction test the product never had. This repository's own .gitignore ignores
 * `.tachyon/` wholesale, so dogfooding here exercises OUR rule and never the one Init writes —
 * "two configurations, one tested" is why the hole survived. So these tests run the REAL Init path
 * (the same `buildStarterYaml` + `ensureTachyonGitignore` calls extension.ts makes) inside a
 * throwaway git repo OUTSIDE this checkout and ask real git. The paths are the nine credential-class
 * ones the investigation measured uncovered (t-508c85); names only, never contents.
 */
describe("Init gitignore vs credential-class paths in a fresh workspace (t-4290d0)", () => {
  const MUST_BE_IGNORED = [
    ".tachyon/secrets.env", // paid API key (spec 337)
    ".tachyon/browser-state/Cookies", // browser profile: cookies + tokens
    ".tachyon/state/bridge-service/control.sock",
    ".tachyon/plugins/acme/plugin.yml", // materialized payload incl. human-owned confirmation config
    ".tachyon/config.lkg.json", // machine state — configLkg.ts claims it is "gitignored"
    ".tachyon/bin/_tachyon-tool", // projected launcher shim — a worktree's symlink must never be committed
  ];

  function isIgnored(repo: string, rel: string): boolean {
    return spawnSync("git", ["check-ignore", "-q", "--", rel], { cwd: repo }).status === 0;
  }

  /** A fresh workspace outside this checkout, holding what Tachyon materializes once it runs there. */
  function initWorkspace(): string {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "t4290d0-init-ws-"));
    execFileSync("git", ["init", "-q"], { cwd: repo, stdio: "ignore" });
    for (const rel of [...MUST_BE_IGNORED, ".tachyon/sessions.json", ".tachyon/plugins.lock.json", ".tachyon/HANDOFF.md"]) {
      fs.mkdirSync(path.join(repo, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(repo, rel), "");
    }
    writeWorkspaceConfig(repo, buildStarterYaml(base()));
    const gitignore = ensureTachyonGitignore(undefined);
    expect(gitignore).not.toBeNull();
    fs.writeFileSync(path.join(repo, ".gitignore"), gitignore!);
    return repo;
  }

  it("leaves every measured credential-class path ignored, secrets.env by the derived glob", () => {
    const repo = initWorkspace();
    try {
      expect(isIgnored(repo, ".tachyon/sessions.json")).toBe(true); // positive control
      const uncovered = MUST_BE_IGNORED.filter((rel) => !isIgnored(repo, rel));
      expect(uncovered, `${uncovered.length} of ${MUST_BE_IGNORED.length} credential-class paths NOT ignored`).toEqual([]);
      // Assert WHICH entry covers it: the closed default, rather than another enumerated exception.
      const verdict = execFileSync("git", ["check-ignore", "-v", "--", ".tachyon/secrets.env"], { cwd: repo, encoding: "utf8" });
      expect(verdict.split("\t")[0]?.endsWith(".tachyon/*"), `unexpected covering entry: ${verdict}`).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("keeps the lockfile and HANDOFF.md unignored because both are committed by design", () => {
    const repo = initWorkspace();
    try {
      // The two untracked Tachyon files are committed BY DESIGN; -uall enumerates them instead of
      // letting git collapse the directory in its default display.
      const status = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: repo, encoding: "utf8" }).trim().split("\n").sort();
      expect(status).toEqual(["?? .gitignore", "?? .tachyon/HANDOFF.md", "?? .tachyon/plugins.lock.json"]);
      expect(isIgnored(repo, ".tachyon/plugins.lock.json")).toBe(false);
      expect(isIgnored(repo, ".tachyon/HANDOFF.md")).toBe(false);
      // t-a65335 — the workspace settings file is personal, machine-local configuration BY DESIGN:
      // it must stay out of git, unlike the two committed-by-design files above.
      expect(isIgnored(repo, ".tachyon/settings.yml")).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
