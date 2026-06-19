import { describe, it, expect } from "vitest";
import { detectStack, buildStarterYaml, ensureTachyonGitignore, type DetectedProject } from "../../src/init/initLogic.js";
import { parseConfig } from "../../src/config/loadConfig.js";

const base = (over: Partial<DetectedProject> = {}): DetectedProject => ({
  files: [],
  installedClis: ["claude"],
  ...over,
});

/** Every generated starter must parse clean and carry an agent + a shell. */
function expectValidStarter(yaml: string) {
  const { config, errors } = parseConfig(yaml);
  expect(errors).toEqual([]);
  expect(config).toBeDefined();
  expect(config!.agents.shell?.kind).toBe("terminal");
  // exactly one AI agent (kind agent) — the rest are terminals
  const aiAgents = Object.values(config!.agents).filter((a) => a.kind === "agent");
  expect(aiAgents.length).toBe(1);
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
  it("Node starter parses clean: agent + dev/test terminals + shell", () => {
    const yaml = buildStarterYaml(base({
      files: ["package.json"],
      packageJson: { scripts: { dev: "next dev", test: "jest" }, dependencies: { next: "^14" } },
    }));
    const config = expectValidStarter(yaml);
    expect(config.agents.claude.autostart).toBe(true);
    expect(config.agents.dev.cmd).toBe("npm run dev");
    expect(config.agents.dev.kind).toBe("terminal");
    expect(config.agents.test.cmd).toBe("npm test");
    expect(yaml).toContain("Detected stack: Node.js (Next.js)");
  });

  it("no-manifest starter is minimal but valid (agent + shell only)", () => {
    const config = expectValidStarter(buildStarterYaml(base({ files: [] })));
    expect(Object.keys(config.agents).sort()).toEqual(["claude", "shell"]);
  });

  it("uses the first detected CLI; warns in a comment when none detected", () => {
    expect(buildStarterYaml(base({ files: [], installedClis: ["codex"] }))).toContain("codex:");
    const none = buildStarterYaml(base({ files: [], installedClis: [] }));
    expect(none).toContain("claude:"); // default
    expect(none).toContain("not detected"); // honest comment
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
    expect(out).toContain(".tachyon/sessions.json");
    expect(out).toContain("# Tachyon");
    expect(out).not.toMatch(/^\n/); // no ugly leading blank line
  });

  it("appends to an existing .gitignore, preserving prior content + separating", () => {
    const out = ensureTachyonGitignore("node_modules\ndist\n");
    expect(out).toContain("node_modules");
    expect(out).toContain("dist");
    expect(out).toContain(".tachyon/sessions.json");
    expect(out).toContain(".tachyon/harness/"); // spec 226 — harness homes (auth symlink + transcripts) stay local
    expect(out).toContain(".tachyon/bridge-mcp/"); // spec 236 — per-agent Bridge --mcp-config files stay local
    expect(out).toBe("node_modules\ndist\n\n# Tachyon — machine-local state (notes.md / pins.json stay shareable)\n.tachyon/sessions.json\n.tachyon/harness/\n.tachyon/bridge-mcp/\n");
  });

  it("handles a file with no trailing newline", () => {
    const out = ensureTachyonGitignore("dist");
    expect(out).toBe("dist\n\n# Tachyon — machine-local state (notes.md / pins.json stay shareable)\n.tachyon/sessions.json\n.tachyon/harness/\n.tachyon/bridge-mcp/\n");
  });

  it("is idempotent — returns null when all entries are already present", () => {
    expect(ensureTachyonGitignore("dist\n.tachyon/sessions.json\n.tachyon/harness/\n.tachyon/bridge-mcp/\n")).toBeNull();
  });

  it("appends only the missing entry when one is already present", () => {
    const out = ensureTachyonGitignore("dist\n.tachyon/sessions.json\n");
    expect(out).toContain(".tachyon/harness/");
    expect(out).not.toMatch(/sessions\.json[\s\S]*sessions\.json/); // sessions.json not duplicated
  });

  it("respects a whole-dir ignore (.tachyon/) — no churn", () => {
    expect(ensureTachyonGitignore(".tachyon/\n")).toBeNull();
    expect(ensureTachyonGitignore(".tachyon\n")).toBeNull();
  });

  it("does NOT ignore notes.md or pins.json (they stay shareable)", () => {
    const entries = (ensureTachyonGitignore(undefined) ?? "").split("\n").filter((l) => l && !l.startsWith("#"));
    expect(entries).not.toContain(".tachyon/notes.md");
    expect(entries).not.toContain(".tachyon/pins.json");
    expect(entries).toContain(".tachyon/sessions.json");
  });
});
