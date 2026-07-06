import { spawnSync } from "node:child_process";
import path from "node:path";

const BUNDLE_REL = "l10n/bundle.l10n.pt-br.json";
const L10N_KEY_RE = /\bl10n\.t\(\s*"((?:[^"\\]|\\.)*)"/g;

export interface I18nPtbrGateDeps {
  workspaceRoot: string;
  git?: (args: string[]) => { status: number | null; stdout: string; stderr: string };
  stderr?: Pick<NodeJS.WriteStream, "write">;
}

function defaultGit(workspaceRoot: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: workspaceRoot, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function warn(stderr: Pick<NodeJS.WriteStream, "write">, msg: string): void {
  stderr.write(`tachyon i18n gate: ${msg} (skipping gate)\n`);
}

function decodeKey(raw: string): string {
  return raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

export function extractL10nKeys(text: string): Set<string> {
  const keys = new Set<string>();
  for (const m of text.matchAll(L10N_KEY_RE)) keys.add(decodeKey(m[1]));
  return keys;
}

export function missingPtbrTranslations(keys: Iterable<string>, bundle: Record<string, unknown>): string[] {
  return [...keys].filter((k) => !(k in bundle)).sort();
}

/** Pre-commit leaf: check only staged .ts files against the pt-BR bundle as staged in the index. */
export function runI18nPtbrStagedGate(deps: I18nPtbrGateDeps): number {
  const stderr = deps.stderr ?? process.stderr;
  const git = deps.git ?? ((args: string[]) => defaultGit(deps.workspaceRoot, args));
  const inside = git(["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0 || inside.stdout.trim() !== "true") {
    warn(stderr, "not inside a git worktree");
    return 0;
  }

  const listed = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z", "--"]);
  if (listed.status !== 0) {
    warn(stderr, `could not list staged files: ${listed.stderr.trim() || `git exited ${listed.status ?? "unknown"}`}`);
    return 0;
  }
  const files = listed.stdout.split("\0").filter((f) => f.startsWith("src/") && f.endsWith(".ts"));
  if (files.length === 0) return 0;

  const bundleRead = git(["show", `:${BUNDLE_REL}`]);
  if (bundleRead.status !== 0) {
    warn(stderr, `could not read staged ${BUNDLE_REL}: ${bundleRead.stderr.trim() || `git exited ${bundleRead.status ?? "unknown"}`}`);
    return 0;
  }

  let bundle: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bundleRead.stdout) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
    bundle = parsed as Record<string, unknown>;
  } catch (e) {
    warn(stderr, `could not parse staged ${BUNDLE_REL}: ${e instanceof Error ? e.message : String(e)}`);
    return 0;
  }

  const keys = new Set<string>();
  for (const file of files) {
    const rel = file.split(path.sep).join(path.posix.sep);
    const content = git(["show", `:${rel}`]);
    if (content.status !== 0) {
      warn(stderr, `could not read staged ${rel}: ${content.stderr.trim() || `git exited ${content.status ?? "unknown"}`}`);
      return 0;
    }
    for (const key of extractL10nKeys(content.stdout)) keys.add(key);
  }

  const missing = missingPtbrTranslations(keys, bundle);
  if (missing.length === 0) return 0;

  stderr.write(`tachyon i18n gate: staged l10n string${missing.length === 1 ? "" : "s"} missing pt-BR translation in ${BUNDLE_REL}:\n`);
  for (const key of missing) stderr.write(`  - ${JSON.stringify(key)}\n`);
  stderr.write(`Add the key${missing.length === 1 ? "" : "s"} to ${BUNDLE_REL} before committing.\n`);
  return 1;
}
