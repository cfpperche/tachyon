/**
 * Isolated harness materialization (spec 226). Each opt-in agent gets a PRIVATE config home so its
 * MCP servers never leak to sibling agents. v1 = claude-only, mcp-only.
 *
 * Mechanism (verified live 2026-06-16, see docs/specs/226):
 *   - redirect the whole config home via `CLAUDE_CONFIG_DIR=<home>` (auth/settings/plugins/transcripts);
 *   - scope MCP with `--mcp-config <home>/mcp.json --strict-mcp-config` (ONLY that file's servers —
 *     ignores the project `.mcp.json` and global), so there is no sibling/project/global leak;
 *   - seed auth by SYMLINKING `.credentials.json` → the real home (a fresh home is unauthenticated;
 *     a symlink keeps an OAuth refresh valid where a copy would go stale);
 *   - secrets stay as `${VAR}` references in mcp.json (claude expands them from the process env at
 *     spawn) — never a literal secret on disk.
 *
 * Mirrors src/worktree/ and src/resume/: the PURE helpers (path/merge/wiring builders) live here as
 * standalone functions and unit-test with no fs; the side-effecting materialize/remove/list plug in
 * on top with real fs (covered by an integration test in a tmp dir).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HarnessDef } from "../config/loadConfig.js";
import type { ResumeAdapter } from "../resume/adapters.js";

/** What a materialized harness contributes to the spawn: the config home, the env that redirects to
 *  it, and the MCP args. Threaded into the spawn/restart/resume/fork command (H3). */
export interface MaterializedHarness {
  /** absolute config home (the `CLAUDE_CONFIG_DIR`) — also where transcripts now live (H2). */
  home: string;
  /** env additions, merged into the agent's spawn env (e.g. `{ CLAUDE_CONFIG_DIR: home }`). */
  env: Record<string, string>;
  /** arg additions appended to the spawn command (e.g. `--mcp-config <path> --strict-mcp-config`). */
  args: string[];
}

/** Root holding every per-agent harness home for a workspace: `<workspaceRoot>/.tachyon/harness`. */
export function harnessRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".tachyon", "harness");
}

/** The per-agent config home. Agent names are already fs-safe (NAME_RE). */
export function harnessHome(workspaceRoot: string, agent: string): string {
  return path.join(harnessRoot(workspaceRoot), agent);
}

/** The materialized MCP config file claude is pointed at via `--mcp-config`. */
export function harnessMcpPath(workspaceRoot: string, agent: string): string {
  return path.join(harnessHome(workspaceRoot, agent), "mcp.json");
}

/**
 * Merge the MCP servers claude will see. For `inherit: workspace` the workspace `.mcp.json` snapshot
 * is the base (COPIED at materialize time — `--strict-mcp-config` ignores the on-disk project file,
 * so it must be folded in here, H6); the agent's declared servers overlay it (declared wins on a name
 * collision). For `inherit: none` only the declared servers are returned.
 */
export function mergeServers(def: HarnessDef, workspaceServers: Record<string, unknown> | null): Record<string, unknown> {
  const base = def.inherit === "workspace" && workspaceServers ? { ...workspaceServers } : {};
  return { ...base, ...(def.mcp ?? {}) };
}

/** The `--mcp-config` file body: `{ mcpServers: {...} }` (claude's documented shape). */
export function buildMcpConfig(servers: Record<string, unknown>): { mcpServers: Record<string, unknown> } {
  return { mcpServers: servers };
}

/** The env+args a redirected home + scoped MCP contribute, from the adapter's pure harness shape. */
export function harnessWiring(adapter: ResumeAdapter, home: string, mcpPath: string): { env: Record<string, string>; args: string[] } {
  const h = adapter.harness;
  if (!h) return { env: {}, args: [] };
  return { env: { [h.configHomeEnv]: home }, args: h.mcpArgs(mcpPath) };
}

/** Every `${VAR}` env name referenced across the harness MCP server `env` blocks (deduped). The real
 *  values must be injected into the spawned process env so claude can expand the literal `${VAR}` it
 *  reads from `mcp.json` (H7 — verified live: claude expands from the process env, not the file). */
export function collectEnvRefs(def: HarnessDef): string[] {
  const names = new Set<string>();
  for (const server of Object.values(def.mcp ?? {})) {
    for (const value of Object.values(server.env ?? {})) {
      const m = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
      if (m) names.add(m[1]);
    }
  }
  return [...names];
}

/**
 * spec 227 — parse a `.env` file into a flat map. Dependency-light (matches the hand-rolled YAML
 * validator): `KEY=value`, optional `export ` prefix, surrounding single/double quotes stripped, `#`
 * comment + blank lines ignored, malformed lines skipped. No `${OTHER}` interpolation (plain values).
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice(7).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    if (val.length >= 2 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Raised when a harness can't be materialized (no auth, or a referenced secret isn't in the env). */
export class HarnessUnavailableError extends Error {
  constructor(readonly agent: string, reason: string) {
    super(`isolated harness for '${agent}': ${reason}`);
    this.name = "HarnessUnavailableError";
  }
}

/** Read a workspace `.mcp.json`'s `mcpServers` map, or null if absent/unreadable/malformed. */
export function readWorkspaceMcpServers(workspaceRoot: string): Record<string, unknown> | null {
  const p = path.join(workspaceRoot, ".mcp.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    const servers = parsed?.mcpServers;
    return servers && typeof servers === "object" && !Array.isArray(servers) ? (servers as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The real (authenticated) config home Tachyon's own process uses — the symlink target for auth. */
export function realConfigHome(env: NodeJS.ProcessEnv = process.env, homeDir: string = os.homedir()): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  return override && override.length > 0 ? override : path.join(homeDir, ".claude");
}

export class HarnessManager {
  constructor(
    private readonly workspaceRoot: string,
    private readonly realHome: string = realConfigHome(),
    /** Source for resolving `${VAR}` secret refs into the spawned env (default the host process env). */
    private readonly procEnv: NodeJS.ProcessEnv = process.env,
  ) {}

  home(agent: string): string {
    return harnessHome(this.workspaceRoot, agent);
  }

  /** spec 227 — the project `.env` (gitignored), parsed; `{}` if absent/unreadable. A secondary
   *  source for `${VAR}` secrets so the common case needs no shell export (process.env still wins). */
  private readEnvFile(): Record<string, string> {
    try {
      return parseEnvFile(fs.readFileSync(path.join(this.workspaceRoot, ".env"), "utf8"));
    } catch {
      return {};
    }
  }

  /**
   * Build (or rebuild) the agent's config home and return its spawn wiring. Idempotent —
   * rematerialize on every spawn/restart/resume so config edits propagate (H6). Throws if the
   * adapter has no harness support (a non-harnessable runtime should never reach here — validation
   * already rejects `harness:` on it, H9).
   */
  materialize(agent: string, def: HarnessDef, adapter: ResumeAdapter): MaterializedHarness {
    const h = adapter.harness;
    if (!h) throw new Error(`runtime '${adapter.runtime}' does not support an isolated harness`);

    // H7 — resolve the ${VAR} secret refs BEFORE any fs side effect, and fail closed if one is missing:
    // claude expands ${VAR} from the spawned PROCESS env (not the mcp.json file), so the real value must
    // be injected there. spec 227 — source = the ambient process env OR a project `.env` (gitignored),
    // process.env taking precedence (dotenv semantics) so the common case needs no shell export.
    const envFile = this.readEnvFile();
    const secretEnv: Record<string, string> = {};
    const missing: string[] = [];
    for (const name of collectEnvRefs(def)) {
      const v = this.procEnv[name] ?? envFile[name];
      if (v === undefined || v === "") missing.push(name);
      else secretEnv[name] = v;
    }
    if (missing.length > 0) {
      throw new HarnessUnavailableError(agent, `set these env var(s) before starting it: ${missing.join(", ")} — in the project .env or your shell (referenced by an MCP server)`);
    }

    const home = this.home(agent);
    fs.mkdirSync(home, { recursive: true });

    // H1 — seed auth by symlinking the credential file to the real home (never a copy → no stale token).
    // Fail closed if the real credential is absent (claude not logged in) — else a fresh home spawns
    // unauthenticated (codex impl-review M3): a dangling symlink "succeeds" but the agent can't start.
    const authLink = path.join(home, h.authFile);
    const authTarget = path.join(this.realHome, h.authFile);
    if (!fs.existsSync(authTarget)) {
      throw new HarnessUnavailableError(agent, `no credentials at ${authTarget} — run claude /login first (a redirected config home starts logged out)`);
    }
    // unlinkSync (NOT rmSync) — it removes the symlink ITSELF without following it; rmSync({force})
    // follows a broken link, hits ENOENT on the missing target, silently no-ops, and leaves the stale
    // link → EEXIST on re-symlink. Ignore ENOENT (nothing to remove on first materialize).
    try {
      fs.unlinkSync(authLink);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    fs.symlinkSync(authTarget, authLink);

    // mcp — ALWAYS scope a harness agent (codex 228-review M2): write the materialized config + pass
    // --strict-mcp-config so it NEVER picks up the project/global MCP except via `inherit`. inherit:none
    // → empty servers (no project MCP); inherit:workspace → the project .mcp.json snapshot. Declared
    // servers overlay. H7: ${VAR} stays literal (no secret on disk).
    const workspaceServers = def.inherit === "workspace" ? readWorkspaceMcpServers(this.workspaceRoot) : null;
    const mcpPath = harnessMcpPath(this.workspaceRoot, agent);
    fs.writeFileSync(mcpPath, `${JSON.stringify(buildMcpConfig(mergeServers(def, workspaceServers)), null, 2)}\n`);
    const args = h.mcpArgs(mcpPath);

    // spec 228 — rules → <home>/CLAUDE.md. Tachyon-OWNED (M3): written when declared, REMOVED when not,
    // so a rule the user deleted from the config doesn't linger in a reused home. Paths must stay under
    // the workspace (M4). Fail closed on a missing file.
    const claudeMd = path.join(home, "CLAUDE.md");
    if (def.rules && def.rules.length > 0) {
      const sections = def.rules.map((rel) => {
        const abs = this.resolveInWorkspace(agent, rel, "rules file");
        let body: string;
        try {
          body = fs.readFileSync(abs, "utf8");
        } catch {
          throw new HarnessUnavailableError(agent, `rules file not found: ${rel}`);
        }
        return `# === ${rel} ===\n${body.trimEnd()}\n`;
      });
      fs.writeFileSync(claudeMd, sections.join("\n"));
    } else {
      fs.rmSync(claudeMd, { force: true });
    }

    // spec 228 — skills → <home>/skills/<basename>/ (resolves via /<name>). Tachyon-OWNED (M3): the dir
    // is rebuilt clean EVERY materialize (even when none declared), so a removed skill disappears. Each
    // source must be a dir with SKILL.md, under the workspace (M4), with a unique basename.
    const skillsRoot = path.join(home, "skills");
    fs.rmSync(skillsRoot, { recursive: true, force: true });
    if (def.skills && def.skills.length > 0) {
      fs.mkdirSync(skillsRoot, { recursive: true });
      const seen = new Set<string>();
      for (const rel of def.skills) {
        const src = this.resolveInWorkspace(agent, rel, "skill dir");
        if (!fs.existsSync(path.join(src, "SKILL.md"))) throw new HarnessUnavailableError(agent, `skill dir must contain a SKILL.md: ${rel}`);
        const base = path.basename(src);
        if (seen.has(base)) throw new HarnessUnavailableError(agent, `duplicate skill name '${base}' (${rel})`);
        seen.add(base);
        fs.cpSync(src, path.join(skillsRoot, base), { recursive: true });
      }
    }

    // spec 228 — hooks → <home>/settings.json `hooks` key (claude reads it; verified fires). Tachyon-OWNED
    // (M3): SET when declared, DELETED when not — preserving any OTHER settings keys — so a removed hook
    // stops firing. Drop the file if it ends up empty.
    const settingsPath = path.join(home, "settings.json");
    let settings: Record<string, unknown> = {};
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch {
      /* no settings yet */
    }
    if (def.hooks) settings.hooks = def.hooks;
    else delete settings.hooks;
    if (Object.keys(settings).length > 0) fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
    else fs.rmSync(settingsPath, { force: true });

    // CLAUDE_CONFIG_DIR (always) + the strict-mcp args (always, for a harness) + the resolved secrets (H7).
    return { home, env: { [h.configHomeEnv]: home, ...secretEnv }, args };
  }

  /**
   * spec 228 (codex M4) — resolve a harness path UNDER the workspace; reject an absolute path or one
   * whose real path escapes the workspace (traversal / a symlink pointing outside). A committed
   * tachyon.yml must not be able to read `/etc/passwd` or `../../secret` into the agent's private home.
   */
  private resolveInWorkspace(agent: string, rel: string, label: string): string {
    if (path.isAbsolute(rel)) throw new HarnessUnavailableError(agent, `${label} must be a workspace-relative path: ${rel}`);
    const abs = path.resolve(this.workspaceRoot, rel);
    let root: string;
    try {
      root = fs.realpathSync(this.workspaceRoot);
    } catch {
      root = path.resolve(this.workspaceRoot);
    }
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      return abs; // doesn't exist yet — the caller's existence check reports it
    }
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new HarnessUnavailableError(agent, `${label} escapes the workspace: ${rel}`);
    }
    return abs;
  }

  /** Remove the agent's config home (GC — caller gates on ledger state, H8). */
  remove(agent: string): void {
    fs.rmSync(this.home(agent), { recursive: true, force: true });
  }

  /** Existing per-agent harness home names (for the ownerless-dir GC sweep, H8). */
  list(): string[] {
    try {
      return fs.readdirSync(harnessRoot(this.workspaceRoot), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  }
}
