/**
 * t-5fc17d — WHICH process is the Dev Host?
 *
 * The harness used to answer "the pid I spawned". That pid is never the EDH. `bin/code` is a shell
 * wrapper that runs `resources/app/out/cli.js` under `ELECTRON_RUN_AS_NODE=1`; for a window launch
 * cli.js spawns the REAL Electron DETACHED (it reparents to init) and then both the CLI and the
 * wrapper exit. So roughly two seconds after a perfectly SUCCESSFUL launch the recorded pid is gone.
 *
 * Measured on 2026-08-05: `headless-session.mjs up` recorded edhPid=969784 while the EDH serving CDP
 * on 9405 was 969804. `status` therefore answered {"live":false} about a healthy window — before any
 * reload had been issued. That false negative is what got read as "the extension host dies instead
 * of reloading"; the window had in fact reloaded and was still there. Killing the recorded pid was
 * equally inert: teardown only worked because killing Xvfb takes the EDH down with it.
 *
 * So the pid has to be discovered from something the real process actually owns. The CDP port is
 * that thing: it is unique per launch and it is on the main process's command line, never on a
 * renderer/gpu/utility child (those all carry `--type=`).
 *
 * Matching is done on the argv ARRAY, not a joined string: `--remote-debugging-port=9405` must not
 * be satisfied by a process holding `--remote-debugging-port=94050`.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Turn one /proc/<pid>/cmdline into a token list.
 *
 * Two shapes show up, and assuming only the first is how this went wrong once already: the shell
 * wrapper and the cli.js shim have an ordinary NUL-separated argv, but Electron REWRITES its own
 * process title, so the app and every `--type=` child report their whole command line as a SINGLE
 * NUL-terminated blob. Measured 2026-08-05: the EDH's cmdline was one entry reading
 * `…/code --extensionDevelopmentPath=… --remote-debugging-port=9407 …` with nothing after it.
 *
 * Splitting the blob on whitespace is safe for what we ask of it — we only ever look for flag
 * tokens and the leading executable, never for a path that might itself contain a space.
 */
export function tokenizeCmdline(raw) {
  const parts = raw.split("\0").filter((part) => part.length > 0);
  if (parts.length === 1) return parts[0].split(/\s+/).filter(Boolean);
  return parts;
}

/** argv of every live process, from /proc. Linux-only, which is where the headless harness runs. */
export function readProcessTable(procRoot = "/proc") {
  const rows = [];
  let entries;
  try { entries = fs.readdirSync(procRoot); } catch { return rows; }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    let raw;
    try { raw = fs.readFileSync(path.join(procRoot, entry, "cmdline"), "utf8"); } catch { continue; }
    if (!raw) continue;
    const argv = tokenizeCmdline(raw);
    if (argv.length === 0) continue;
    rows.push({ pid: Number(entry), argv });
  }
  return rows;
}

/** The shell wrapper and the CLI shim both carry our argv; neither is the app. */
function isLauncherShim(argv) {
  const argv0 = argv[0] ?? "";
  const base = path.basename(argv0);
  if (base === "sh" || base === "bash" || base === "dash") return true;
  // `bin/code` (the wrapper) and `… code <path>/out/cli.js …` (the CLI shim under ELECTRON_RUN_AS_NODE)
  if (argv.some((a) => a.endsWith(`${path.sep}out${path.sep}cli.js`))) return true;
  return argv0.endsWith(`${path.sep}bin${path.sep}code`);
}

/**
 * Pure selection over a process table — the part worth testing without launching VS Code.
 *
 * @param {{pid:number, argv:string[]}[]} procs
 * @param {{port:number, electronBin?:string}} options
 * @returns {number|undefined} pid of the Electron main process serving `port`
 */
export function pickEdhPid(procs, { port, electronBin } = {}) {
  if (!port) throw new Error("edh-process: port is required");
  const flag = `--remote-debugging-port=${port}`;
  const candidates = procs.filter((p) =>
    p.argv.includes(flag) &&
    !p.argv.some((a) => a.startsWith("--type=")) &&
    !isLauncherShim(p.argv));
  if (candidates.length === 0) return undefined;
  if (electronBin) {
    const exact = candidates.find((p) => p.argv[0] === electronBin);
    if (exact) return exact.pid;
  }
  // Deterministic tie-break; in practice one process owns a given debugging port.
  return candidates.sort((a, b) => a.pid - b.pid)[0].pid;
}

/**
 * `bin/code` is the launcher we spawn; the app it starts is the sibling ELF one directory up.
 * Returns undefined when the caller passed something else, in which case selection falls back to
 * "the non-shim process holding this port".
 */
export function electronBinaryFor(codeBin) {
  if (!codeBin) return undefined;
  if (codeBin.endsWith(`${path.sep}bin${path.sep}code`)) {
    return path.join(path.dirname(path.dirname(codeBin)), "code");
  }
  return codeBin;
}

/**
 * Find the live EDH main process for `port`, retrying briefly: the detached app can take a moment
 * to appear after the CLI returns. Returns undefined rather than throwing — callers decide whether
 * a missing EDH is fatal.
 */
export async function resolveEdhPid({ port, codeBin, timeoutMs = 10_000, intervalMs = 250, procRoot = "/proc" } = {}) {
  const electronBin = electronBinaryFor(codeBin);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pid = pickEdhPid(readProcessTable(procRoot), { port, electronBin });
    if (pid !== undefined) return pid;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Is this pid still around? Signal 0 never delivers, it only asks. */
export function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
