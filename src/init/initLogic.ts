/**
 * F5 `Tachyon: Init` — pure stack detection → a commented starter tachyon.yml.
 *
 * Everything here is pure (DetectedProject in → yaml string out) and unit-tested;
 * the command handler does the only I/O (reading which files exist, parsing them,
 * detecting installed CLIs, writing + opening the file).
 *
 * The output is a TEACHING artifact: heavily commented, valid by construction,
 * meant to be read and edited. Detected commands are best-effort guesses the
 * comments tell the user to adjust.
 */

export interface DetectedProject {
  /** manifest files present at the workspace root */
  files: string[];
  /** parsed package.json (when present) — only scripts/deps are consulted */
  packageJson?: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  /** raw composer.json text / Gemfile text — cheap substring checks for framework hints */
  composerJson?: string;
  gemfile?: string;
  /** AI CLIs found on this machine (from cliDetect) — first one becomes the agent */
  installedClis: string[];
}

interface TerminalRecipe {
  name: string;
  cmd: string;
  watch?: string;
  comment?: string;
}

interface StackResult {
  label: string;
  terminals: TerminalRecipe[];
}

/** Single-quotes a YAML scalar when it needs it (keeps simple values bare). */
function yamlScalar(v: string): string {
  return /^[A-Za-z0-9_./ -]+$/.test(v) ? v : `"${v.replace(/"/g, '\\"')}"`;
}

function has(files: string[], name: string): boolean {
  return files.includes(name);
}

/**
 * Decides the stack and its terminal recipes from what's present. Order matters
 * only for the label; a project could match more than one manifest (we take the
 * first that hits, the common case being one primary stack per folder).
 */
export function detectStack(p: DetectedProject): StackResult {
  if (has(p.files, "package.json")) {
    const scripts = p.packageJson?.scripts ?? {};
    const deps = { ...(p.packageJson?.dependencies ?? {}), ...(p.packageJson?.devDependencies ?? {}) };
    const framework =
      deps.next ? "Next.js" : deps.vite ? "Vite" : deps.react ? "React" : deps["@angular/core"] ? "Angular" : deps.svelte ? "Svelte" : undefined;
    const terminals: TerminalRecipe[] = [];
    const dev = scripts.dev ? "dev" : scripts.start ? "start" : undefined;
    if (dev) terminals.push({ name: "dev", cmd: `npm run ${dev}`, watch: "src/**", comment: "dev server — restarts when src changes" });
    if (scripts.test) terminals.push({ name: "test", cmd: "npm test", comment: "test runner" });
    return { label: framework ? `Node.js (${framework})` : "Node.js", terminals };
  }
  if (has(p.files, "composer.json")) {
    const laravel = (p.composerJson ?? "").includes("laravel/");
    return {
      label: laravel ? "PHP (Laravel)" : "PHP",
      terminals: laravel
        ? [{ name: "serve", cmd: "php artisan serve", comment: "Laravel dev server" }]
        : [{ name: "serve", cmd: "php -S localhost:8000", comment: "PHP built-in server — adjust the docroot" }],
    };
  }
  if (has(p.files, "Cargo.toml")) {
    return { label: "Rust", terminals: [{ name: "run", cmd: "cargo run", watch: "src/**", comment: "cargo run — restarts on src changes" }] };
  }
  if (has(p.files, "go.mod")) {
    return { label: "Go", terminals: [{ name: "run", cmd: "go run .", watch: "**/*.go", comment: "go run — restarts on .go changes" }] };
  }
  if (has(p.files, "pyproject.toml") || has(p.files, "requirements.txt")) {
    return { label: "Python", terminals: [{ name: "run", cmd: "python main.py", comment: "adjust to your entrypoint (e.g. uvicorn app:app, python -m yourpkg)" }] };
  }
  if (has(p.files, "Gemfile")) {
    const rails = (p.gemfile ?? "").includes("rails");
    return {
      label: rails ? "Ruby (Rails)" : "Ruby",
      terminals: rails
        ? [{ name: "serve", cmd: "bin/rails server", comment: "Rails dev server" }]
        : [{ name: "run", cmd: "ruby main.rb", comment: "adjust to your entrypoint" }],
    };
  }
  return { label: "generic", terminals: [] };
}

/** The AI agent line: a detected CLI (claude preferred), else claude with a note. */
function pickAgent(installed: string[]): { bin: string; detected: boolean } {
  if (installed.includes("claude")) return { bin: "claude", detected: true };
  if (installed.length > 0) return { bin: installed[0], detected: true };
  return { bin: "claude", detected: false };
}

/**
 * Builds the commented starter tachyon.yml. Always valid: at minimum one agent
 * (under agents:) plus a shell (under terminals:). Stack terminals are appended
 * with adjust-me comments. The `terminals:` block (spec 215) merges into the same
 * kind-tagged set as agents: — it just reads more naturally for non-AI processes.
 */
/**
 * Machine-local Tachyon state that must never be committed. pins.json is
 * deliberately ABSENT — it's the shared checklist, meant to travel with the
 * repo. sessions.json carries a per-machine resume ledger (session ids +
 * absolute cwd), so it stays local.
 */
// spec 245 — the canonical .tachyon/HANDOFF.md is intentionally NOT ignored (it's the durable, committed
// project handoff); only the transient pending-notes lane is machine-local.
export const TACHYON_GITIGNORE_ENTRIES = [".tachyon/sessions.json", ".tachyon/harness/", ".tachyon/bridge-mcp/", ".tachyon/continuity/", ".tachyon/handoff-notes.jsonl"];

/**
 * Appends Tachyon's machine-local entries to an existing .gitignore, or returns
 * null when nothing is missing (idempotent — safe to call on every Init). A
 * user who already ignores the whole `.tachyon/` dir, or added the line by hand,
 * gets no churn. Returns the FULL new content to write (or null = leave as-is).
 */
export function ensureTachyonGitignore(existing: string | undefined): string | null {
  const lines = (existing ?? "").split("\n").map((l) => l.trim());
  if (lines.includes(".tachyon/") || lines.includes(".tachyon")) return null; // whole dir already ignored
  const missing = TACHYON_GITIGNORE_ENTRIES.filter((e) => !lines.includes(e));
  if (missing.length === 0) return null;
  const block = ["# Tachyon — machine-local state (pins.json stays shareable)", ...missing].join("\n") + "\n";
  if (!existing || existing.trim() === "") return block;
  return existing.endsWith("\n") ? `${existing}\n${block}` : `${existing}\n\n${block}`;
}

export function buildStarterYaml(p: DetectedProject): string {
  const stack = detectStack(p);
  const agent = pickAgent(p.installedClis);
  const L: string[] = [];
  L.push("# tachyon.yml — generated by Tachyon: Init.");
  L.push(`# Detected stack: ${stack.label}. Everything here is a starting point — edit freely.`);
  L.push("# Each agent/terminal becomes a tmux session shown as a native editor terminal.");
  L.push("# Docs & format reference: https://github.com/cfpperche/tachyon");
  L.push("");
  L.push("agents:");
  L.push(`  # Your AI coding agent (kind: agent is inferred from the command).`);
  if (!agent.detected) {
    L.push(`  # NOTE: '${agent.bin}' was not detected on this machine — install it or change cmd.`);
  }
  L.push(`  ${agent.bin}:`);
  L.push(`    cmd: ${agent.bin}`);
  L.push("    autostart: true   # starts when the workspace opens");
  L.push("    # worktree: true  # run in its own git worktree+branch so parallel agents don't clobber files");
  L.push("");

  // terminals: — servers, shells, builds. Same lifecycle as agents (session/tab/restart/watch/
  // worktree); 'kind: terminal' is implied here, and attention defaults off.
  L.push("terminals:   # non-AI processes — servers, shells, builds (attention off by default)");
  for (const t of stack.terminals) {
    if (t.comment) L.push(`  # ${t.comment}`);
    L.push(`  ${t.name}:`);
    L.push(`    cmd: ${yamlScalar(t.cmd)}`);
    if (t.watch) L.push(`    watch: ${yamlScalar(t.watch)}   # restarts when matching files change`);
    L.push("");
  }

  L.push("  # A scratch shell, always handy.");
  L.push("  shell:");
  L.push("    cmd: bash");
  L.push("");

  L.push("settings:");
  L.push("  # maxAgents: 8       # fork-bomb guardrail (default 8)");
  L.push("  # bridgePort: 41999  # override the derived MCP Bridge port");
  L.push("  auth: true           # require a Bearer token on the MCP Bridge (recommended)");
  L.push("  # tmux:              # tmux options for Tachyon's socket (your ~/.tmux.conf is NOT loaded)");
  L.push("  #   mouse: on          # defaults already on: mouse, focus-events, history-limit 10000");
  L.push("  #   history-limit: 50000  # override a default, or add any tmux option (applied as set -g)");
  L.push("  # worktree:           # git-worktree isolation for agents with worktree: true");
  L.push("  #   base: ~/.cache/tachyon/worktrees   # location root (default; XDG-aware)");
  L.push("  #   branch: \"tachyon/{agent}\"          # global branch template (must contain {agent})");
  L.push("");
  return L.join("\n");
}
