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
 * t-b0b8ef — machine-local Tachyon state is closed by default. The `*` is essential:
 * ignoring `.tachyon/` itself would prevent git from re-including either committed file.
 */
export const TACHYON_GITIGNORE_ENTRIES = [
  ".tachyon/*",
  "!.tachyon/HANDOFF.md", // spec 245 — durable, committed project handoff
  // 516 — a exceção do lockfile de plugins saiu: não existe mais um lockfile. Ela era a "receita de
  // re-hidratação de um clone" — o arquivo que um clone novo lia para reinstalar o que a máquina
  // original tinha. O sistema novo não tem receita porque não tem transação: um plugin é uma pasta,
  // e um clone que quer o plugin instala o zip.
];

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
  const block = ["# Tachyon — machine-local state (HANDOFF.md stays shareable)", ...missing].join("\n") + "\n";
  if (!existing || existing.trim() === "") return block;
  return existing.endsWith("\n") ? `${existing}\n${block}` : `${existing}\n\n${block}`;
}

/**
 * t-a65335 — Init writes the NEW homes: `.tachyon/settings.yml` (top level IS the settings mapping)
 * plus one `.tachyon/terminals/<name>.yml` per detected process. There is no tachyon.yml anymore:
 * agents come from Agent Studio (`.tachyon/agents/<name>/`), declarations are per-file, and the
 * settings file carries only configuration.
 */
export interface StarterFiles {
  /** content of `.tachyon/settings.yml` */
  settingsYaml: string;
  /** one `.tachyon/terminals/<name>.yml` per entry */
  terminals: { name: string; yaml: string }[];
  /** the human-facing "what happened" line pieces (stack label, agent hint) */
  stackLabel: string;
  agentHint: string;
}

export function buildStarterFiles(p: DetectedProject): StarterFiles {
  const stack = detectStack(p);
  const agent = pickAgent(p.installedClis);

  const S: string[] = [];
  S.push("# .tachyon/settings.yml — generated by Tachyon: Init. Workspace configuration only.");
  S.push(`# Detected stack: ${stack.label}. Everything here is a starting point — edit freely.`);
  S.push("# Docs & format reference: https://github.com/cfpperche/tachyon");
  S.push("#");
  S.push("# Agents are NOT declared here: an agent IS the directory .tachyon/agents/<name>/,");
  S.push('# created for you by Agent Studio. Terminals live in .tachyon/terminals/<name>.yml,');
  S.push("# schedules in .tachyon/schedules/<name>.yml — one declaration, one file.");
  S.push(`# Run "Tachyon: Agent Studio" to create your first agent${agent.detected ? ` (${agent.bin} was detected on this machine)` : ""}.`);
  if (!agent.detected) {
    S.push(`# NOTE: no supported AI CLI was detected on this machine — install one (e.g. '${agent.bin}') first.`);
  }
  S.push("");
  S.push("# maxAgents: 8       # fork-bomb guardrail (default 8)");
  S.push("# bridgePort: 41999  # override the derived MCP Bridge port");
  S.push("auth: true           # require a Bearer token on the MCP Bridge (recommended)");
  S.push("# tmux:              # tmux options for Tachyon's socket (your ~/.tmux.conf is NOT loaded)");
  S.push("#   mouse: on          # defaults already on: mouse, focus-events, history-limit 10000");
  S.push("# worktree:           # separate git checkout + branch for agents with worktree: true");
  S.push("#   base: ~/.cache/tachyon/worktrees   # location root (default; XDG-aware)");
  S.push('#   branch: "tachyon/{agent}"          # global branch template (must contain {agent})');
  S.push("");

  const terminals: { name: string; yaml: string }[] = [];
  for (const t of stack.terminals) {
    const T: string[] = [];
    if (t.comment) T.push(`# ${t.comment}`);
    T.push(`cmd: ${yamlScalar(t.cmd)}`);
    if (t.watch) T.push(`watch: ${yamlScalar(t.watch)}   # restarts when matching files change`);
    T.push("");
    terminals.push({ name: t.name, yaml: T.join("\n") });
  }
  terminals.push({ name: "shell", yaml: "# A scratch shell, always handy.\ncmd: bash\n" });

  return {
    settingsYaml: S.join("\n"),
    terminals,
    stackLabel: stack.label,
    agentHint: agent.detected ? agent.bin : "",
  };
}
