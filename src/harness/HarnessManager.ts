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
import type { HarnessDef, HarnessMcpServer } from "../config/loadConfig.js";
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
  const declared: Record<string, HarnessMcpServer> = def.mcp;
  return { ...base, ...declared };
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
  for (const server of Object.values(def.mcp)) {
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

    // H6 — fold the workspace .mcp.json snapshot in (strict-mcp ignores the on-disk one); H7 — the
    // server env values are already validated as ${VAR} refs, written literally (no secret on disk).
    const workspaceServers = def.inherit === "workspace" ? readWorkspaceMcpServers(this.workspaceRoot) : null;
    const servers = mergeServers(def, workspaceServers);
    const mcpPath = harnessMcpPath(this.workspaceRoot, agent);
    fs.writeFileSync(mcpPath, `${JSON.stringify(buildMcpConfig(servers), null, 2)}\n`);

    // CLAUDE_CONFIG_DIR + strict-mcp args, PLUS the resolved secret vars — claude reads the literal
    // ${VAR} from mcp.json and expands it from this spawned-process env (H7).
    const wiring = harnessWiring(adapter, home, mcpPath);
    return { home, env: { ...wiring.env, ...secretEnv }, args: wiring.args };
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
