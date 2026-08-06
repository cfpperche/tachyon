/**
 * t-e0a0f5 — the doors of the INSTALLED package, opened from inside a real extension host.
 *
 * This runs against the extension VS Code resolved from `--extensions-dir`: the bytes out of the
 * .vsix, not the bytes in the checkout. Nothing here imports from `src/`, on purpose — the moment it
 * did, it would be reading the development tree again, which is the whole failure this exists to end.
 *
 * t-a8e1f7 — THE WORKSPACE NOW CARRIES A `tachyon.yml`, so the persistent engine is required.
 *
 * The disposable editor is real Electron. Its extension host reports `process.versions.electron`, so
 * the packaged shell takes the Electron branch of `resolveEngineRuntimeSource`. That branch is the
 * t-d11d57 fix. Before it, the daemon was launched from a content-addressed copy of `process.execPath`
 * — the Electron binary — which cannot start away from its install directory (`libffmpeg.so`). The
 * measured cost was activation failing after 12.8s on the published 0.57.1 artifact.
 *
 * The runner opens this file twice, and `TACHYON_SMOKE_EXPECT` says which run this is.
 *
 *   engine-ready — Node is on PATH. Activation must succeed and the daemon must answer a query.
 *   node-missing — PATH carries no Node. Activation must fail with a NAMED refusal, not a timeout.
 *
 * The second run measures what a host without Node gets. A named refusal tells that human what to
 * fix; a 12.8s supervisor timeout does not.
 *
 * REFUTED WHILE BUILDING THIS, and it matters for how the second run is read. "A graphical launcher
 * hands VS Code the session PATH, so the launcher case has no Node" is only half true. VS Code
 * desktop runs the user's LOGIN SHELL and merges the PATH it prints, precisely to repair that case.
 * Measured here: the runner handed the host a PATH with no Node and the host read
 * `~/.nvm/.../bin/node` anyway. So a launcher-started editor still finds a version manager the login
 * shell sets up. The uncovered host is the one where no login shell offers Node at all, and the
 * runner reproduces it with `--force-disable-user-env` rather than by claiming the launcher does.
 *
 * That pair is one layer of two. The class that shipped 0.57.0 is caught statically by
 * `scripts/package-closure.mjs`; this layer proves the package STARTS, that its doors answer, and that
 * it refuses honestly when the host cannot give it a runtime.
 */

const vscode = require("vscode");
const fs = require("node:fs");

const EXTENSION_ID = "cfpperche.tachyon";

/** The runner declares this command in the workspace `tachyon.yml`. The daemon must report it back. */
const ENGINE_COMMAND = "vsix-smoke-engine-door";

/**
 * What the refusal looks like AT THIS DOOR, which is not what it looks like at its source.
 *
 * `resolveEngineRuntimeSource` raises `EngineBundleError` carrying `code: "NODE_RUNTIME_NOT_FOUND"`.
 * That code does not survive the activation boundary. MEASURED on VS Code 1.128.0: the object
 * `extension.activate()` rejects with is a plain `Error` whose own properties are exactly
 * `["stack","name","message"]`. VS Code copies the name, prefixes the message with "Activating
 * extension ... failed:", and drops every custom property. So the code cannot be asserted from here.
 *
 * The class name and the refusal wording DO survive, and they identify the same guard. The code stays
 * pinned at its source by `test/unit/engineBundleStore.test.ts`; this door pins what a caller can
 * actually see. The case "keeps the refusal wording the VSIX smoke door matches", in that same file,
 * ties the two ends together — reword the refusal and it goes red before this door does.
 */
const REFUSAL_NAME = "EngineBundleError";
const REFUSAL_TEXT = /requires a real Node executable on PATH/;

/** The supervisor's readiness timeout. The refusal must never arrive as this instead. */
const TIMEOUT_TEXT = /did not become ready in time/i;

function say(line) {
  // The runner greps stdout for these; they are also what a human reads when it goes red.
  console.log(`[vsix-smoke] ${line}`);
}

/** Everything an error carries that can name a cause. `code` is a property, not part of the text. */
function describeError(error) {
  if (!error || typeof error !== "object") return String(error);
  const parts = [];
  if (typeof error.code === "string") parts.push(`code=${error.code}`);
  if (typeof error.name === "string") parts.push(error.name);
  if (typeof error.message === "string") parts.push(error.message);
  return parts.length > 0 ? parts.join(" ") : String(error);
}

exports.run = async function run() {
  const started = Date.now();
  const doors = [];
  const failures = [];

  const door = (name, detail, ok) => {
    doors.push({ name, detail, ok });
    say(`${ok ? "ok  " : "FAIL"} ${name} — ${detail}`);
    if (!ok) failures.push(`${name}: ${detail}`);
  };

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  if (!extension) {
    door("install", `${EXTENSION_ID} is not installed in the disposable extensions directory`, false);
    return finish(started, doors, failures);
  }

  if (process.env.TACHYON_SMOKE_EXPECT === "node-missing") {
    await refusalDoor(extension, door, started);
    return finish(started, doors, failures);
  }

  // DOOR 1 — the package starts. Everything the bundle imports at load time resolves, or this throws
  // exactly the way a user's first Reload Window would. With a `tachyon.yml` present it also means the
  // engine became ready: activation awaits the workspace attach and rethrows what that attach raises.
  try {
    await extension.activate();
    door("activation", `activated in ${Date.now() - started}ms`, true);
  } catch (error) {
    door("activation", `activate() threw: ${describeError(error)}`, false);
    return finish(started, doors, failures);
  }

  const manifest = extension.packageJSON;

  // DOOR 2 — the engine answers. The daemon runs from a staged runtime outside the editor, and this
  // query crosses the control socket to reach it. A workspace that never attached answers with an
  // empty list, so the door asserts the declared command instead of a bare "it did not throw".
  try {
    const rows = (await vscode.commands.executeCommand("tachyon._commands")) ?? [];
    const named = rows.some((row) => row && row.name === ENGINE_COMMAND);
    door(
      "engine",
      named
        ? `the persistent engine answered commands.list with '${ENGINE_COMMAND}'`
        : `commands.list returned ${rows.length} row(s) and none was '${ENGINE_COMMAND}'`,
      named,
    );
  } catch (error) {
    door("engine", `commands.list threw: ${describeError(error)}`, false);
  }

  // DOOR 3 — the command surface. Every command the manifest promises the palette must exist, or the
  // shipped UI offers entries that throw when a human picks one.
  const declared = (manifest.contributes?.commands ?? []).map((entry) => entry.command);
  const registered = new Set(await vscode.commands.getCommands(true));
  const unregistered = declared.filter((command) => !registered.has(command));
  door(
    "commands",
    unregistered.length === 0
      ? `${declared.length}/${declared.length} declared commands registered`
      : `${unregistered.length} declared command(s) never registered: ${unregistered.slice(0, 8).join(", ")}`,
    unregistered.length === 0,
  );

  // DOOR 4 — the view surface. One focus per contributed view: the container resolves, the view
  // provider is registered, and the webview is constructed from the packaged extension root.
  for (const [container, views] of Object.entries(manifest.contributes?.views ?? {})) {
    for (const view of views) {
      try {
        await vscode.commands.executeCommand(`${view.id}.focus`);
        door(`view:${view.id}`, `focused (container ${container})`, true);
      } catch (error) {
        door(`view:${view.id}`, `focus threw: ${error && error.message ? error.message : String(error)}`, false);
      }
    }
  }

  return finish(started, doors, failures);
};

/**
 * The only door of the `node-missing` run.
 *
 * The runner removed every PATH entry that holds a Node executable. So the Electron host cannot find a
 * runtime for the daemon, and the shell must say exactly that. Three things are asserted. Activation
 * must fail. The failure must be the named refusal, raised by the runtime guard. The failure must not
 * be the supervisor timeout, because a timeout names nothing and costs 12.8s.
 *
 * This run also proves the branch the other run depends on. The refusal only exists behind
 * `isElectronRuntime`, so reaching it proves this host IS Electron — and therefore that the
 * engine-ready run staged a real Node instead of passing straight through.
 */
async function refusalDoor(extension, door, started) {
  let raised;
  try {
    await extension.activate();
  } catch (error) {
    raised = error;
  }
  const elapsed = Date.now() - started;

  if (raised === undefined) {
    door("engine-refusal", `activation succeeded in ${elapsed}ms, but this host has no Node on PATH`, false);
    return;
  }

  const text = describeError(raised);
  const named = raised.name === REFUSAL_NAME && REFUSAL_TEXT.test(text);
  const timedOut = TIMEOUT_TEXT.test(text);
  // The top frame is reported, never asserted. It says WHICH guard refused, and a human reading a red
  // door needs that. Asserting it would tie the door to a bundler's naming instead of to behaviour.
  const frame = String(raised.stack ?? "").split("\n")[1]?.trim() ?? "no stack";
  door(
    "engine-refusal",
    named && !timedOut
      ? `refused in ${elapsed}ms by ${REFUSAL_NAME} — ${frame}`
      : `expected ${REFUSAL_NAME}${timedOut ? ", and got the supervisor timeout" : ""}; the host raised: ${text}`,
    named && !timedOut,
  );
}

function finish(started, doors, failures) {
  const result = {
    ok: failures.length === 0,
    durationMs: Date.now() - started,
    doors,
    failures,
  };
  const out = process.env.TACHYON_SMOKE_RESULT;
  if (out) {
    try {
      fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    } catch (error) {
      say(`could not write ${out}: ${String(error)}`);
    }
  }
  say(`${result.ok ? "PASS" : "FAIL"} — ${doors.length} door(s) in ${result.durationMs}ms`);
  // Throwing is how `--extensionTestsPath` reports a non-zero exit; the runner never trusts the file
  // alone, because a host that died before writing it must not read as a pass.
  if (!result.ok) throw new Error(`vsix smoke failed: ${failures.join(" | ")}`);
}
