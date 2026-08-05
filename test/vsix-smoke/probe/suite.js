/**
 * t-e0a0f5 — the doors of the INSTALLED package, opened from inside a real extension host.
 *
 * This runs against the extension VS Code resolved from `--extensions-dir`: the bytes out of the
 * .vsix, not the bytes in the checkout. Nothing here imports from `src/`, on purpose — the moment it
 * did, it would be reading the development tree again, which is the whole failure this exists to end.
 *
 * WHAT IT DOES NOT DO, and why that is not an oversight. The workspace it opens carries NO
 * `tachyon.yml`, so no persistent engine is started. Measured on the real 0.57.1 artifact: with a
 * `tachyon.yml` present, activation fails with "Tachyon's persistent engine did not become ready in
 * time" — the daemon is launched from a content-addressed copy of `process.execPath`, which inside a
 * DESKTOP extension host is the Electron binary, and an Electron binary copied away from its install
 * directory cannot start. The seam that fixes this for the Dev Host
 * (`TACHYON_DEV_HOST_ENGINE_RUNTIME`) is `dev`-channel-only by design (src/extension.ts), and a
 * packaged build is `stable`. A human's install works because their extension host runs on a real
 * Node. So engine-backed doors are not reachable here, and pretending otherwise would produce a red
 * that means "wrong host", not "broken package" — the kind of red people learn to ignore.
 *
 * That bound is why this is one layer of two. The class that shipped 0.57.0 is caught statically by
 * `scripts/package-closure.mjs`; this layer proves the package STARTS and its non-engine doors answer.
 */

const vscode = require("vscode");
const fs = require("node:fs");

const EXTENSION_ID = "cfpperche.tachyon";

function say(line) {
  // The runner greps stdout for these; they are also what a human reads when it goes red.
  console.log(`[vsix-smoke] ${line}`);
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

  // DOOR 1 — the package starts. Everything the bundle imports at load time resolves, or this throws
  // exactly the way a user's first Reload Window would.
  try {
    await extension.activate();
    door("activation", `activated in ${Date.now() - started}ms`, true);
  } catch (error) {
    door("activation", `activate() threw: ${error && error.message ? error.message : String(error)}`, false);
    return finish(started, doors, failures);
  }

  const manifest = extension.packageJSON;

  // DOOR 2 — the command surface. Every command the manifest promises the palette must exist, or the
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

  // DOOR 3 — the view surface. One focus per contributed view: the container resolves, the view
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
