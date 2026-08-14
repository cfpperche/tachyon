/**
 * t-36182f — headless dogfood for plugin tooling in a linked worktree.
 *
 * Proves the reported symptom against the REAL plugin, not a fixture: `agent-browser` is installed and
 * healthy in the primary checkout, and a linked worktree could not reach it, so its doctor reported
 * BROWSER_RUNTIME_MISSING and Visual QA of an isolated change was impossible.
 *
 * Run from inside a linked worktree. It measures BEFORE, projects, measures AFTER, and then checks the
 * properties that make the projection safe rather than merely convenient:
 *   - the launcher is a LINK, so the binary still exists exactly once on disk;
 *   - the launcher resolves the AUTHORITY workspace root (that is what keeps the checksum pin and the
 *     human-owned confirmation gate authoritative);
 *   - the lockfile and the plugin payloads are NOT projected.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PROJECTED_TOOLING_RELS,
  describeToolingProjection,
  projectPluginTooling,
  resolveAuthorityRoot,
} from "@tachyon/engine/plugins/worktreeProjection.js";
import { LOCKFILE_REL_PATH } from "@tachyon/engine/plugins/lockfile.js";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}\n        ${detail}`);
}

function git(args: string[], cwd: string): string {
  // stderr piped: the exit-handler cleanup re-runs `worktree remove` after the explicit one and would
  // otherwise print git's "not a working tree" onto a passing run.
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

/** The real doctor, run from `cwd`. Never throws — a non-zero exit is the measurement. */
function doctor(cwd: string): { code: number; out: string } {
  try {
    const out = execFileSync("sh", [".claude/skills/agent-browser/scripts/doctor.sh"], {
      cwd,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 120_000,
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string; message?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}${e.message ?? ""}` };
  }
}

const here = process.cwd();
const commonAbs = path.resolve(here, git(["rev-parse", "--git-common-dir"], here));
const authorityRoot = path.dirname(commonAbs);

// Self-contained and repeatable: create a THROWAWAY linked worktree so BEFORE is genuinely
// unprojected every run, and so creation AND cleanup are both exercised rather than assumed.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-projection-dogfood-"));
const worktreeRoot = path.join(scratch, "wt");
const branch = `tachyon/dogfood/plugin-projection-${process.pid}`;

console.log(`authority: ${authorityRoot}`);
console.log(`worktree : ${worktreeRoot} (throwaway)\n`);

git(["worktree", "add", "--detach", worktreeRoot, "HEAD"], authorityRoot);

function cleanup(): void {
  try { git(["worktree", "remove", "--force", worktreeRoot], authorityRoot); } catch { /* fall through */ }
  fs.rmSync(scratch, { recursive: true, force: true });
  try { git(["branch", "-D", branch], authorityRoot); } catch { /* never created */ }
}

process.on("exit", cleanup);

check(
  "the authority is derived from git, not configured",
  resolveAuthorityRoot(worktreeRoot, path.resolve(worktreeRoot, git(["rev-parse", "--git-common-dir"], worktreeRoot))) === authorityRoot,
  `--git-common-dir from the worktree resolves to ${authorityRoot}`,
);

// ---- BEFORE ---------------------------------------------------------------
const launcherRel = ".tachyon/bin/_tachyon-tool";
const skillRel = ".claude/skills/agent-browser/scripts/doctor.sh";
const beforeLauncher = fs.existsSync(path.join(worktreeRoot, launcherRel));
const beforeSkill = fs.existsSync(path.join(worktreeRoot, skillRel));
const authorityHasIt = fs.existsSync(path.join(authorityRoot, launcherRel))
  && fs.existsSync(path.join(authorityRoot, skillRel));

check(
  "the authority really does have agent-browser installed",
  authorityHasIt,
  `${authorityRoot}: launcher=${fs.existsSync(path.join(authorityRoot, launcherRel))} skill=${fs.existsSync(path.join(authorityRoot, skillRel))}`,
);

const before = beforeLauncher && beforeSkill ? doctor(worktreeRoot) : { code: -1, out: "(tooling absent — doctor cannot even be invoked)" };
check(
  "BEFORE: the worktree cannot reach the installed plugin",
  !(beforeLauncher && beforeSkill) || before.code !== 0,
  `launcher=${beforeLauncher} skill=${beforeSkill} doctorExit=${before.code}`,
);

// ---- PROJECT --------------------------------------------------------------
const result = projectPluginTooling({ worktreeRoot, authorityRoot });
console.log(`\nprojection: ${describeToolingProjection(result)}\n`);

// ---- AFTER ----------------------------------------------------------------
const after = doctor(worktreeRoot);
check(
  "AFTER: the real agent-browser doctor passes from inside the worktree",
  after.code === 0 && /agent-browser OK/.test(after.out),
  `exit=${after.code} · ${(after.out.trim().split("\n").pop() ?? "").slice(0, 120)}`,
);
check(
  "AFTER: no BROWSER_RUNTIME_MISSING",
  !/BROWSER_RUNTIME_MISSING/.test(after.out),
  "the reported symptom is absent from the doctor output",
);

// ---- SAFETY PROPERTIES ----------------------------------------------------
const binLink = path.join(worktreeRoot, ".tachyon/bin");
const isLink = fs.lstatSync(binLink).isSymbolicLink();
check(
  "the tooling is LINKED, not copied — the binary exists once",
  isLink && fs.realpathSync(binLink) === fs.realpathSync(path.join(authorityRoot, ".tachyon/bin")),
  `${binLink} -> ${isLink ? fs.readlinkSync(binLink) : "(not a symlink)"}`,
);

// The launcher shim resolves its own physical location, so a shim reached through the worktree link
// computes the AUTHORITY root — which is where the pins and the human-owned gates live.
const shimBody = fs.readFileSync(path.join(worktreeRoot, launcherRel), "utf8");
check(
  "the launcher resolves physically (pwd -P), so it reads the authority's pins",
  shimBody.includes("pwd -P"),
  "checksum + confirmation gates stay authoritative in the authority checkout",
);

// The strongest proof that the checksum gate survives projection: invoke a provisioned binary
// THROUGH the projected launcher. It re-validates the binary against the AUTHORITY's lockfile pin
// before exec, so a pass here means the pin was found, read and matched from the worktree.
let launched = { code: 1, out: "" };
try {
  launched = {
    code: 0,
    out: execFileSync("./.tachyon/bin/_tachyon-tool", ["agent-browser", "agent-browser", "--version"], {
      cwd: worktreeRoot,
      encoding: "utf8",
      timeout: 120_000,
    }),
  };
} catch (err) {
  const e = err as { status?: number; stdout?: string; stderr?: string };
  launched = { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
}
check(
  "a provisioned binary launches THROUGH the projected launcher (checksum pin verified)",
  launched.code === 0 && /agent-browser \d+\.\d+/.test(launched.out),
  `exit=${launched.code} · ${launched.out.trim().split("\n").pop() ?? ""}`,
);

const lockInWorktree = fs.existsSync(path.join(worktreeRoot, LOCKFILE_REL_PATH));
check(
  "the lockfile is NOT projected into the worktree",
  !lockInWorktree,
  `${LOCKFILE_REL_PATH} present in worktree: ${lockInWorktree} (must be false — one source of truth for pins)`,
);

const payloadInWorktree = fs.existsSync(path.join(worktreeRoot, ".tachyon/plugins"));
check(
  "plugin payloads and their human-owned confirmation config are NOT projected",
  !payloadInWorktree,
  `.tachyon/plugins present in worktree: ${payloadInWorktree} (must be false)`,
);

const ignored = PROJECTED_TOOLING_RELS.filter((rel) => {
  try {
    execFileSync("git", ["check-ignore", "-q", rel], { cwd: worktreeRoot });
    return true;
  } catch {
    return false;
  }
});
check(
  "every projected path is git-ignored — a projection can never be committed",
  ignored.length === PROJECTED_TOOLING_RELS.length,
  `ignored: ${ignored.join(", ")}`,
);

// ---- IDEMPOTENCE (the restart path) ---------------------------------------
const second = projectPluginTooling({ worktreeRoot, authorityRoot });
check(
  "re-projecting is idempotent (covers worktree restart)",
  second.entries.filter((e) => e.state === "linked").length === 0,
  describeToolingProjection(second),
);

// ---- CLEANUP --------------------------------------------------------------
git(["worktree", "remove", "--force", worktreeRoot], authorityRoot);
check(
  "removing the worktree removes the LINK, never the authority's tooling",
  !fs.existsSync(worktreeRoot)
    && fs.existsSync(path.join(authorityRoot, launcherRel))
    && fs.existsSync(path.join(authorityRoot, skillRel)),
  "git worktree remove deletes the symlink; the authority's binary and skills are untouched",
);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
