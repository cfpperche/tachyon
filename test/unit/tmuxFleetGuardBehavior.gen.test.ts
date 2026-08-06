import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { DEFAULT_SOCKET_NAME, TmuxService, isolatedArgs, type ExecResult } from "../../src/tmux/TmuxService.js";
import { tmuxChildEnv } from "../helpers/tmuxEnv.js";

/**
 * t-6ef951 — nothing stopped a script from killing the tmux server that hosts the fleet, and the
 * repository already had the precedent written down in a comment.
 *
 * THE MECHANISM, measured (t-9713ff): tmux resolves the server from `$TMUX` BEFORE it looks at
 * `$TMUX_TMPDIR`. A script running inside a fleet pane inherits `TMUX=/tmp/tmux-1000/tachyon,<pid>,<n>`,
 * so `spawnSync("tmux", ["kill-server"], { env: { ...process.env, TMUX_TMPDIR: private } })` kills every
 * live agent. Setting `TMUX_TMPDIR` and believing you isolated IS the defect — it is what a careful
 * author writes. That line took the fleet down three times in three hours on 2026-08-06, and
 * `test/helpers/tmuxEnv.ts:6` had recorded the SAME failure ("a single missed `-L` killed every"
 * session) long before. A warning comment did not prevent the second occurrence; hence a guard.
 *
 * WHAT MAKES AN INVOCATION SAFE. Four forms, all measured against tmux 3.6 from inside a fleet pane:
 *   1. `-L <own socket>` first — `tmux -L nonexistent list-sessions` errors on the private path.
 *   2. `-S <own path>` first — same precedence; this is the form production ships
 *      (`src/presentation/Terminals.ts`, `src/presentation/TmuxAttachClient.ts`), and the task's
 *      "-L or clear TMUX" rule omits it.
 *   3. an env with `TMUX` REMOVED (`tmuxChildEnv(...)`, or `{ ...process.env, TMUX: undefined }`).
 *   4. an invocation that never opens a socket at all (`tmux -V`).
 *
 * TWO TRAPS THIS GUARD EXISTS TO SURVIVE, both measured rather than assumed:
 *   - POSITION IS THE PROOF, not presence. `tmux list-sessions -L x` answers
 *     "command list-sessions: unknown flag -L" — a socket flag after the command word pins nothing.
 *     And `-S` is ALSO a per-command flag: `capture-pane -p -S -40` (a real line in
 *     `scripts/dogfood/pi-interaction-profile.mjs`) contains `-S` and pins no socket whatsoever. So
 *     the socket flag must appear in the LEADING GLOBAL-FLAG section, before the first command word.
 *   - A PINNED SOCKET CAN BE THE FLEET'S. `["-L", "tachyon", "kill-server"]` satisfies "it passes -L"
 *     and is the single most destructive line in the repository. `test/unit/gateSocketIsolation.test.ts`
 *     already bans that literal in the three gate files; the second assertion below extends the ban to
 *     `src/` and `scripts/`, but only for commands that DESTROY, so the product may still attach to and
 *     drive its own fleet (`src/extension.ts`, `scripts/screenshots/runner.js`).
 *
 * WHY THE SYNTAX TREE AND NOT A REGEX. The mold for this guard —
 * `test/unit/cxWedgeBehavior.gen.test.ts` — matches its identifiers in ANY text, including comments,
 * and that trap broke `main` twice on 2026-08-06: describing the forbidden thing tripped the guard
 * that forbade it. A guard about tmux has to be written about, so it is parsed instead of grepped.
 * Prose, JSDoc and `@example` blocks cannot fail this test; only a real call expression can. That is
 * also what makes the refusal message safe to quote back at the author.
 *
 * PROHIBITION WITHOUT A SUBSTITUTE LOSES TO A PERMANENT CONVENTION, so the two seams the repository
 * already ships count as compliance by name: `isolatedArgs(...)` and `tmuxChildEnv(...)`. Neither is
 * taken on faith — `isolatedArgs` by itself only prepends `-f /dev/null`, and the `-L` that actually
 * saves the fleet is added one layer up at `TmuxService`'s exec seam, so the third assertion below
 * pins BOTH seams. If someone drops the `-L` prefix from that seam, this file goes red rather than
 * quietly keeping a promise it no longer measures.
 *
 * KNOWN RESIDUAL DOOR, reported rather than guarded: `new TmuxService()` defaults to the fleet socket
 * and never spells "tmux" at the call site (e.g. `scripts/dogfood/persistent-engine-runner.ts:643`
 * calls `killSession` through it). It cannot reach the INHERITED server — the seam pinned below always
 * passes `-L <socket>` — so it is outside this guard's rule, but it is a second door onto the same
 * server and belongs in any future widening.
 */

const repoRoot = path.resolve(__dirname, "../..");
const SCANNED_ROOTS = ["src", "scripts"];
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

/**
 * Sites that reach tmux through an argv this file cannot resolve statically. Each needs a reason
 * naming what makes it safe, and the reason is asserted non-empty so an entry can never be a bare
 * silencer.
 */
const UNRESOLVABLE_ARGV_ALLOWLIST: Record<string, string> = {
  // `serverScopeArgv(tmuxArgs)` splices its caller's argv after `systemd-run … --`. The only caller is
  // `createTmuxExecutor`, which passes `isolatedArgs(args)` where `args` already begins `-L <socket>`
  // (asserted by "the two compliance seams are real", below).
  "src/tmux/TmuxService.ts": "systemd-run wrapper splices the executor's already -L-pinned argv",
};

/** tmux 3.6 global flags: `tmux [-2CDlNuVv] [-c cmd] [-f file] [-L name] [-S path] [-T features]`. */
const GLOBAL_VALUE_FLAGS = new Set(["-c", "-f", "-L", "-S", "-T"]);
const SOCKET_FLAGS = new Set(["-L", "-S"]);
const GLOBAL_BOOLEAN_FLAG = /^-[2CDlNuqv]+$/;
/** Invocations that print and exit without ever opening a socket. */
const NON_CONNECTING = new Set(["-V", "-h", "--version", "--help"]);
/** Commands that end sessions or the server. Everything else may legitimately drive the live fleet. */
const DESTRUCTIVE_COMMANDS = new Set(["kill-server", "kill-session", "kill-window", "kill-pane"]);
/** Callees whose first argument is a SHELL COMMAND LINE rather than an executable path. */
const SHELL_STRING_CALLEES = new Set(["exec", "execSync"]);
/**
 * APIs that run their first argument as a program. Naming one is enough to make a call a door, even
 * with no argv at all (bare `tmux` starts a session on the inherited server). For ANY OTHER callee —
 * a local `tmux()`/`have()` wrapper, a pty spawner — the second argument must be a literal argv before
 * this file calls it an invocation, or `l10n.t("tmux")` and `refresh("tmux")` would be tmux commands.
 * The cost of that line is stated rather than hidden: a wrapper this guard does not know, called with
 * a non-literal argv, is not covered.
 */
const PROCESS_LAUNCHERS = new Set(["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"]);
/** Property pairs that describe "run this file with these arguments" without naming a child_process API. */
const ARGV_OBJECT_KEYS: Array<[fileKey: string, argvKey: string]> = [
  ["shellPath", "shellArgs"],
  ["file", "args"],
  ["file", "argv"],
  ["command", "args"],
  ["cmd", "args"],
];

interface Token {
  /** The literal word, or null when the source cannot say what it will be at runtime. */
  readonly text: string | null;
}
const OPAQUE: Token = { text: null };

export interface TmuxInvocationFinding {
  readonly at: string;
  readonly code: string;
  readonly problem: string;
}

function calleeName(call: ts.CallExpression): string {
  const expr = call.expression;
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return "";
}

function firstConstInitializer(sf: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name && node.initializer) {
      found = node.initializer;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

/**
 * Flatten an argv expression into words. An element the source cannot resolve becomes OPAQUE, which
 * ENDS the global-flag section — unknown content is never assumed to be a flag.
 */
function argvTokens(expr: ts.Expression | undefined, sf: ts.SourceFile, depth = 0): { tokens: Token[]; isolated: boolean } {
  if (!expr || depth > 3) return { tokens: [OPAQUE], isolated: false };
  if (ts.isArrayLiteralExpression(expr)) {
    const tokens: Token[] = [];
    let isolated = false;
    for (const element of expr.elements) {
      if (ts.isStringLiteralLike(element)) {
        tokens.push({ text: element.text });
      } else if (ts.isSpreadElement(element)) {
        const inner = argvTokens(element.expression, sf, depth + 1);
        isolated = isolated || inner.isolated;
        tokens.push(...inner.tokens);
      } else {
        tokens.push(OPAQUE);
      }
    }
    return { tokens, isolated };
  }
  if (ts.isCallExpression(expr)) {
    if (calleeName(expr) === "isolatedArgs") {
      const inner = argvTokens(expr.arguments[0], sf, depth + 1);
      // `isolatedArgs` prepends `-f /dev/null`, so the runtime argv really does start with a global flag.
      return { tokens: [{ text: "-f" }, { text: "/dev/null" }, ...inner.tokens], isolated: true };
    }
    return { tokens: [OPAQUE], isolated: false };
  }
  if (ts.isIdentifier(expr)) {
    const init = firstConstInitializer(sf, expr.text);
    return init ? argvTokens(init, sf, depth + 1) : { tokens: [OPAQUE], isolated: false };
  }
  return { tokens: [OPAQUE], isolated: false };
}

/** Walks the leading global-flag section only. Returns the socket flag if it takes effect there. */
function socketPin(tokens: readonly Token[]): { pinned: boolean; flag?: string; value: string | null } {
  for (let i = 0; i < tokens.length; ) {
    const word = tokens[i]!.text;
    if (word === null) break;
    if (SOCKET_FLAGS.has(word)) return { pinned: true, flag: word, value: tokens[i + 1]?.text ?? null };
    if (GLOBAL_VALUE_FLAGS.has(word)) {
      i += 2;
      continue;
    }
    if (GLOBAL_BOOLEAN_FLAG.test(word)) {
      i += 1;
      continue;
    }
    break; // the first command word (or an unknown flag) ends the global section
  }
  return { pinned: false, value: null };
}

function isNonConnecting(tokens: readonly Token[]): boolean {
  return tokens.length > 0 && tokens.every((t) => t.text !== null && NON_CONNECTING.has(t.text));
}

function isUndefinedLiteral(node: ts.Expression): boolean {
  return ts.isIdentifier(node) && node.text === "undefined";
}

/**
 * Does this options object hand the child an env with no `TMUX`? A `TMUX: undefined` written BEFORE a
 * spread is not compliance — the spread puts the fleet's value back.
 */
function envDropsTmux(expr: ts.Expression | undefined, sf: ts.SourceFile, fileText: string, depth = 0): boolean {
  if (!expr || depth > 3) return false;
  if (ts.isCallExpression(expr)) return calleeName(expr) === "tmuxChildEnv";
  if (ts.isIdentifier(expr)) {
    if (new RegExp(`delete\\s+${expr.text}(?:\\.[A-Za-z_$][\\w$]*)*\\.TMUX\\b`).test(fileText)) return true;
    const init = firstConstInitializer(sf, expr.text);
    return init ? envDropsTmux(init, sf, fileText, depth + 1) : false;
  }
  if (!ts.isObjectLiteralExpression(expr)) return false;
  let lastSpread = -1;
  let tmuxCleared = -1;
  expr.properties.forEach((prop, index) => {
    if (ts.isSpreadAssignment(prop)) lastSpread = index;
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name) && prop.name.text === "TMUX" && isUndefinedLiteral(prop.initializer)) {
      tmuxCleared = index;
    }
  });
  if (tmuxCleared >= 0) return tmuxCleared > lastSpread;
  // An env built from scratch never carried TMUX in the first place.
  return lastSpread === -1;
}

/**
 * The `env` an options object hands the child. An options object with NO `env` is the defect's default:
 * the child inherits `process.env`, `TMUX` and all. (Reading the options object itself as the env is a
 * mistake this guard made first — `{ env: …, timeout: … }` has no spread and no TMUX key, so it looked
 * like an env built from scratch and passed the very line that killed the fleet.)
 */
function envOfOptions(expr: ts.Expression | undefined, sf: ts.SourceFile, depth = 0): ts.Expression | undefined {
  if (!expr || depth > 3) return undefined;
  if (ts.isIdentifier(expr)) {
    const init = firstConstInitializer(sf, expr.text);
    return init ? envOfOptions(init, sf, depth + 1) : undefined;
  }
  if (!ts.isObjectLiteralExpression(expr)) return undefined;
  const property = expr.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === "env");
  if (!property) return undefined;
  return ts.isPropertyAssignment(property) ? property.initializer : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
}

/** The options object of a child_process call — the first object literal or identifier after the argv. */
function optionsArgument(call: ts.CallExpression): ts.Expression | undefined {
  return call.arguments.slice(2).find((arg) => ts.isObjectLiteralExpression(arg) || ts.isIdentifier(arg));
}

/** Raw text of a string or template literal, with `${…}` holes replaced by an opaque sentinel. */
const HOLE = " ";
function literalCommandText(node: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.getText().slice(1, -1).replace(/\$\{[^}]*\}/g, HOLE);
  return undefined;
}

/** tmux invocations inside a shell command line, with the words that precede them on the same segment. */
function shellTmuxSegments(command: string): Array<{ prefix: string[]; tokens: Token[] }> {
  const found: Array<{ prefix: string[]; tokens: Token[] }> = [];
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    const at = words.indexOf("tmux");
    if (at === -1) continue;
    found.push({
      prefix: words.slice(0, at),
      tokens: words.slice(at + 1).map((word) => (word.includes(HOLE) ? OPAQUE : { text: word })),
    });
  }
  return found;
}

/** `env -u TMUX tmux …` and `env -i tmux …` both hand tmux an env with no TMUX. */
function shellPrefixDropsTmux(prefix: readonly string[]): boolean {
  if (!prefix.includes("env")) return false;
  if (prefix.includes("-i")) return true;
  return prefix.some((word, index) => word === "-u" && prefix[index + 1] === "TMUX");
}

const AMBIENT_SERVER =
  "reaches the INHERITED tmux server. Inside a fleet pane $TMUX names the fleet socket, and tmux reads " +
  "$TMUX before $TMUX_TMPDIR — so this kills or drives every live agent. Setting TMUX_TMPDIR does NOT " +
  "isolate. Fix it by pinning the server (`-L <own socket>` or `-S <own path>` BEFORE the command word, " +
  "or `isolatedArgs(...)`) or by handing the child an env with TMUX removed (`tmuxChildEnv(...)`, or " +
  "`{ ...process.env, TMUX: undefined }` written AFTER the spread).";

const FLEET_DESTRUCTION =
  `names the fleet socket "${DEFAULT_SOCKET_NAME}" by literal AND runs a command that destroys sessions. ` +
  "Pinning a socket proves the server is CHOSEN, not that it is yours. Read the socket from the run's env " +
  `(TACHYON_TMUX_SOCKET) or use a private name; a literal "${DEFAULT_SOCKET_NAME}" plus a kill is the exact ` +
  "line that took the fleet down.";

/**
 * Every door onto the tmux binary in one file's syntax tree. `text` is a parameter so a test can feed a
 * fixture without writing it to disk.
 */
export function tmuxInvocationFindings(relPath: string, text: string): TmuxInvocationFinding[] {
  const findings: TmuxInvocationFinding[] = [];
  const extension = path.extname(relPath);
  const sf = ts.createSourceFile(
    relPath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    extension === ".tsx" ? ts.ScriptKind.TSX : /^\.[mc]?ts$/.test(extension) ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const allowReason = UNRESOLVABLE_ARGV_ALLOWLIST[relPath];

  const judge = (node: ts.Node, tokens: Token[], isolated: boolean, envOk: boolean): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    const at = `${relPath}:${line}`;
    const code = node.getText(sf).replace(/\s+/g, " ").slice(0, 160);
    const pin = socketPin(tokens);
    if (pin.pinned) {
      const literalFleet =
        (pin.flag === "-L" && pin.value === DEFAULT_SOCKET_NAME) ||
        (pin.flag === "-S" && pin.value !== null && pin.value.endsWith(`/${DEFAULT_SOCKET_NAME}`));
      const destroys = tokens.some((t) => t.text !== null && DESTRUCTIVE_COMMANDS.has(t.text));
      if (literalFleet && destroys) findings.push({ at, code, problem: FLEET_DESTRUCTION });
      return;
    }
    if (isolated || envOk || isNonConnecting(tokens)) return;
    if (tokens.some((t) => t.text === null) && allowReason) return;
    findings.push({ at, code, problem: AMBIENT_SERVER });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const first = node.arguments[0];
      const argv = node.arguments[1];
      const looksLikeArgv = argv !== undefined && (ts.isArrayLiteralExpression(argv) || (ts.isCallExpression(argv) && calleeName(argv) === "isolatedArgs"));
      if (first && ts.isStringLiteralLike(first) && first.text === "tmux" && (PROCESS_LAUNCHERS.has(calleeName(node)) || looksLikeArgv)) {
        const { tokens, isolated } = argvTokens(argv, sf);
        judge(node, tokens, isolated, envDropsTmux(envOfOptions(optionsArgument(node), sf), sf, text));
      } else if (first && SHELL_STRING_CALLEES.has(calleeName(node))) {
        const command = literalCommandText(first);
        for (const segment of command === undefined ? [] : shellTmuxSegments(command)) {
          const envOk = shellPrefixDropsTmux(segment.prefix) || envDropsTmux(envOfOptions(node.arguments[1], sf), sf, text);
          judge(node, segment.tokens, false, envOk);
        }
      }
    }
    if (ts.isArrayLiteralExpression(node)) {
      // `systemd-run … -- tmux <argv>` and friends: the executable is an ELEMENT, not the callee's first argument.
      const at = node.elements.findIndex(
        (el, i) =>
          ts.isStringLiteralLike(el) &&
          el.text === "tmux" &&
          i > 0 &&
          ts.isStringLiteralLike(node.elements[i - 1]!) &&
          (node.elements[i - 1] as ts.StringLiteralLike).text === "--",
      );
      if (at >= 0) {
        const { tokens, isolated } = argvTokens(
          ts.factory.createArrayLiteralExpression(node.elements.slice(at + 1)),
          sf,
        );
        // A synthesized node has no position; judge against the real array so the report points at source.
        judge(node, tokens, isolated, false);
      }
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const [fileKey, argvKey] of ARGV_OBJECT_KEYS) {
        const filePropertyIsTmux = node.properties.some(
          (p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === fileKey && ts.isStringLiteralLike(p.initializer) && p.initializer.text === "tmux",
        );
        if (!filePropertyIsTmux) continue;
        const argvProperty = node.properties.find((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name) && p.name.text === argvKey);
        const argvExpr = argvProperty && ts.isPropertyAssignment(argvProperty)
          ? argvProperty.initializer
          : argvProperty && ts.isShorthandPropertyAssignment(argvProperty)
            ? argvProperty.name
            : undefined;
        const { tokens, isolated } = argvTokens(argvExpr, sf);
        const envProperty = node.properties.find((p) => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "env");
        judge(node, tokens, isolated, envDropsTmux(envProperty && ts.isPropertyAssignment(envProperty) ? envProperty.initializer : undefined, sf, text));
        break;
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return findings;
}

function scannedFiles(): string[] {
  const walk = (relative: string): string[] => {
    const absolute = path.join(repoRoot, relative);
    if (!fs.existsSync(absolute)) return [];
    return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : walk(child);
      return SOURCE_EXTENSIONS.includes(path.extname(entry.name)) ? [child] : [];
    });
  };
  return SCANNED_ROOTS.flatMap(walk);
}

function scanRepository(textOverrides: Record<string, string> = {}): TmuxInvocationFinding[] {
  const files = new Set([...scannedFiles(), ...Object.keys(textOverrides)]);
  return [...files].flatMap((relative) => {
    const text = textOverrides[relative] ?? fs.readFileSync(path.join(repoRoot, relative), "utf8");
    return text.includes("tmux") ? tmuxInvocationFindings(relative, text) : [];
  });
}

/**
 * STUNT DOUBLE for `scripts/dogfood/runtime-remeasure.ts:309` as it was written on 2026-08-06, the line
 * that killed the fleet at 17:31, 19:54 and 20:17. The real file does not exist on `main` (its fix,
 * commit 8bfb8ff4, is still on an unmerged branch), so the shape is reproduced here rather than
 * referenced: a private TMUX_TMPDIR, `process.env` spread whole, and no `-L`.
 */
const REMEASURE_BEFORE = `
import { spawnSync } from "node:child_process";
export function cleanup(tmuxTmpdir: string): void {
  spawnSync("tmux", ["kill-server"], { env: { ...process.env, TMUX_TMPDIR: tmuxTmpdir }, timeout: 20_000 });
}
`;
/** The same stunt double after commit 8bfb8ff4's shape: `TMUX`/`TMUX_PANE` dropped after the spread. */
const REMEASURE_AFTER = `
import { spawnSync } from "node:child_process";
export function cleanup(tmuxTmpdir: string): void {
  const env = { ...process.env, TMUX_TMPDIR: tmuxTmpdir, TMUX: undefined, TMUX_PANE: undefined };
  spawnSync("tmux", ["kill-server"], { env, timeout: 20_000 });
}
`;

describe("t-6ef951 no source under src/ or scripts/ can reach the fleet's tmux server", () => {
  it("refuses an invocation that neither pins its own socket nor drops TMUX, and accepts the four safe forms", () => {
    expect(Object.values(UNRESOLVABLE_ARGV_ALLOWLIST).every((reason) => reason.length > 0)).toBe(true);
    expect(scanRepository()).toEqual([]);

    // RED, on the real defect: the stunt double of runtime-remeasure.ts:309 as it was written.
    const before = scanRepository({ "scripts/dogfood/stunt-double-remeasure.ts": REMEASURE_BEFORE });
    expect(before).toEqual([
      { at: "scripts/dogfood/stunt-double-remeasure.ts:4", code: expect.stringContaining('spawnSync("tmux", ["kill-server"]'), problem: AMBIENT_SERVER },
    ]);
    // GREEN, on the same file after the fix's shape.
    expect(scanRepository({ "scripts/dogfood/stunt-double-remeasure.ts": REMEASURE_AFTER })).toEqual([]);
    // …and RED again when the same line is injected into a file the walk really visits, so a green scan
    // is evidence the walk ran and not evidence it skipped everything.
    const injected = `${fs.readFileSync(path.join(repoRoot, "src/presentation/Terminals.ts"), "utf8")}\nspawnSync("tmux", ["kill-server"]);\n`;
    expect(scanRepository({ "src/presentation/Terminals.ts": injected }).map((f) => f.at)).toEqual([
      expect.stringMatching(/^src\/presentation\/Terminals\.ts:\d+$/),
    ]);

    const problems = (source: string): string[] => tmuxInvocationFindings("scripts/probe.ts", source).map((f) => f.problem);
    // The four safe forms, each ACCEPTED — a prohibition with no substitute loses to the convention it bans.
    expect(problems('execFileSync("tmux", ["-L", SOCK, "kill-server"]);')).toEqual([]);
    expect(problems('execFileSync("tmux", ["-u", "-S", sockPath, "attach-session"]);')).toEqual([]);
    expect(problems('execFileSync("tmux", ["kill-server"], { env: tmuxChildEnv() });')).toEqual([]);
    expect(problems('execFileSync("tmux", ["-V"], { stdio: "pipe" });')).toEqual([]);
    // The two named seams count by name, in both argv and env position.
    expect(problems('spawn("tmux", isolatedArgs(args), {});')).toEqual([]);
    expect(problems('execSync("env -u TMUX tmux kill-server");')).toEqual([]);

    // RED on each trap this guard was built for, measured against tmux 3.6 rather than assumed.
    expect(problems('execFileSync("tmux", ["list-sessions", "-L", SOCK]);'), "a socket flag after the command word pins nothing").toEqual([AMBIENT_SERVER]);
    expect(problems('execFileSync("tmux", ["capture-pane", "-p", "-S", "-40"]);'), "-S is also capture-pane's own flag").toEqual([AMBIENT_SERVER]);
    expect(problems('spawnSync("tmux", ["kill-server"], { env: { TMUX: undefined, ...process.env } });'), "the spread puts TMUX back").toEqual([AMBIENT_SERVER]);
    expect(problems('spawnSync("tmux", ["kill-server"], { env: { ...process.env, TMUX_TMPDIR: dir } });'), "TMUX_TMPDIR alone never isolates").toEqual([AMBIENT_SERVER]);
    expect(problems('execFileSync("tmux", ["kill-server"]);'), "an argv with no flags at all").toEqual([AMBIENT_SERVER]);
    expect(problems('execFileSync("tmux", args);'), "an argv the source cannot resolve fails closed").toEqual([AMBIENT_SERVER]);
    expect(problems('vscode.window.createTerminal({ shellPath: "tmux", shellArgs: ["attach-session", "-t", s] });'), "a terminal is a tmux client too").toEqual([AMBIENT_SERVER]);
    expect(problems('spawnSync("systemd-run", ["--scope", "--", "tmux", "kill-server"]);'), "tmux behind a wrapper's -- is still tmux").toEqual([AMBIENT_SERVER]);

    // The comment trap that broke `main` twice: this guard reads the tree, so prose about it is inert.
    expect(problems('// never write execFileSync("tmux", ["kill-server"]) — it kills the fleet\nconst x = 1;')).toEqual([]);
    expect(problems('/** @example spawnSync("tmux", ["kill-server"]) */\nexport const doc = 1;')).toEqual([]);
    // …and neither is a string that merely starts with the word, nor a UI label that happens to be "tmux"
    // (`src/webview/TmuxPanel.ts`, `src/webview/controlStrings.ts` — the first three false positives this
    // guard produced, and the reason a lone string argument is not treated as an invocation).
    expect(problems('throw new Error("tmux session is gone");')).toEqual([]);
    expect(problems('vscode.l10n.t("tmux");\nthis.manager.refresh("tmux");')).toEqual([]);
  });

  it("refuses a destructive command aimed at the fleet socket by literal name, while the product may still drive its own fleet", () => {
    const problems = (source: string): string[] => tmuxInvocationFindings("scripts/probe.ts", source).map((f) => f.problem);
    // Passing `-L` proves the server was CHOSEN, not that it is yours. This is the deadliest line possible.
    expect(problems(`execFileSync("tmux", ["-L", "${DEFAULT_SOCKET_NAME}", "kill-server"]);`)).toEqual([FLEET_DESTRUCTION]);
    expect(problems(`execFileSync("tmux", ["-S", "/tmp/tmux-1000/${DEFAULT_SOCKET_NAME}", "kill-session", "-t", s]);`)).toEqual([FLEET_DESTRUCTION]);
    // Driving the live fleet is the product's job — attach and send-keys stay legal (src/extension.ts,
    // scripts/screenshots/runner.js), and a socket read from the run's env is nobody's literal.
    expect(problems(`execFileSync("tmux", ["-L", "${DEFAULT_SOCKET_NAME}", "send-keys", "-t", target, "C-m"]);`)).toEqual([]);
    expect(problems('execFileSync("tmux", ["-L", SOCKET_NAME, "kill-server"]);')).toEqual([]);
  });

  it("the two compliance seams are real, so accepting them by name is measurement and not faith", () => {
    // `isolatedArgs` alone adds `-f /dev/null`, NOT `-L`. What saves the fleet is TmuxService's exec seam
    // prefixing `-L <socket>` on every single op; if that prefix ever goes, this guard's acceptance is a lie.
    expect(isolatedArgs(["-L", "s", "kill-server"])).toEqual(["-f", "/dev/null", "-L", "s", "kill-server"]);
    const argvs: string[][] = [];
    const recorder = async (args: string[]): Promise<ExecResult> => {
      argvs.push(args);
      return { stdout: "", stderr: "" };
    };
    const tmux = new TmuxService(recorder, "guard-socket");
    return Promise.all([tmux.hasSession("x"), tmux.listSessions("tachyon-"), tmux.killSession("x").catch(() => undefined)]).then(() => {
      expect(argvs.length).toBeGreaterThan(0);
      for (const argv of argvs) expect(argv.slice(0, 2)).toEqual(["-L", "guard-socket"]);
      // And `tmuxChildEnv` really removes what tmux reads first.
      const child = tmuxChildEnv({ TMUX: "/tmp/tmux-1000/tachyon,1,2", TMUX_PANE: "%3", PATH: "/usr/bin" });
      expect("TMUX" in child).toBe(false);
      expect("TMUX_PANE" in child).toBe(false);
      expect(child.PATH).toBe("/usr/bin");
    });
  });
});
