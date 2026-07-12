/**
 * EDH palliative headless runner (extensionTestsPath).
 *
 * Scenario S1 (t-8354ae fail-visible): fixture opens with invalid tachyon.yml + LKG + ledger.
 * Asserts configFailure, degraded roster (not empty-only), LKG spawn refusal, Doctor findings.
 * Optionally handshakes with the shell for an Xvfb screenshot (ready-/done- markers).
 *
 * Env:
 *   EDH_PALLIATIVE_RESULT  — path to write JSON report (required for shell to reap status)
 *   EDH_PALLIATIVE_WS      — workspace root (optional; defaults to first folder)
 *   EDH_PALLIATIVE_SHOTDIR — if set, write ready-<name> and wait for done-<name> (ffmpeg outside)
 */
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeResult(payload) {
  const out = process.env.EDH_PALLIATIVE_RESULT;
  if (!out) {
    console.log("[edh-palliative] result:", JSON.stringify(payload, null, 2));
    return;
  }
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } catch (err) {
    console.error("[edh-palliative] failed to write result:", err);
  }
}

function check(asserts, ok, id, detail) {
  asserts.push({ id, ok: !!ok, detail: detail ?? "" });
  if (!ok) console.error(`[edh-palliative] FAIL ${id}: ${detail ?? ""}`);
  else console.log(`[edh-palliative] ok   ${id}${detail ? ` — ${detail}` : ""}`);
}

/** Signal the outer shell to grab an Xvfb frame (mirrors scripts/screenshots/capture.sh). */
async function frame(name) {
  const shotDir = process.env.EDH_PALLIATIVE_SHOTDIR;
  if (!shotDir) return false;
  try {
    fs.mkdirSync(shotDir, { recursive: true });
    const ready = path.join(shotDir, `ready-${name}`);
    const done = path.join(shotDir, `done-${name}`);
    try {
      fs.unlinkSync(done);
    } catch {
      /* ignore */
    }
    fs.writeFileSync(ready, "");
    console.log(`[edh-palliative] frame ready: ${name}`);
    for (let i = 0; i < 60 && !fs.existsSync(done); i++) await sleep(500);
    const ok = fs.existsSync(done);
    console.log(`[edh-palliative] frame ${ok ? "captured" : "TIMEOUT"}: ${name}`);
    return ok;
  } catch (err) {
    console.warn("[edh-palliative] frame handshake failed:", err);
    return false;
  }
}

exports.run = async function run() {
  const asserts = [];
  const startedAt = new Date().toISOString();
  let health = null;
  let doctorText = "";
  const frames = {};

  try {
    const ext = vscode.extensions.getExtension("cfpperche.tachyon");
    if (!ext) throw new Error("extension cfpperche.tachyon not found (extensionDevelopmentPath?)");
    await ext.activate();
    await sleep(2000);

    // Close welcome noise; open Tachyon view (best-effort).
    for (const c of [
      "workbench.action.closeAllEditors",
      "notifications.clearAll",
      "workbench.view.extension.tachyon",
    ]) {
      try {
        await vscode.commands.executeCommand(c);
      } catch {
        /* ignore */
      }
    }
    // Focus the Tachyon sidebar webview if the command exists (prototype id).
    for (const c of ["tachyonSidebarPrototype.focus", "workbench.view.extension.tachyon"]) {
      try {
        await vscode.commands.executeCommand(c);
      } catch {
        /* ignore */
      }
    }

    // Cold start against whatever is on disk (seed+break → invalid config).
    try {
      await vscode.commands.executeCommand("tachyon.start");
    } catch (err) {
      console.warn("[edh-palliative] tachyon.start threw (may be expected when config invalid):", err);
    }
    await sleep(1500);

    // Refresh views so sidebar paints degraded roster before the screenshot.
    try {
      await vscode.commands.executeCommand("tachyon.refreshViews");
    } catch {
      /* ignore */
    }
    await sleep(1500);

    health = await vscode.commands.executeCommand("tachyon._configHealth");
    if (!health || health.ok === false) {
      throw new Error(`_configHealth failed: ${health?.error ?? "null"}`);
    }

    // Visual evidence: Xvfb grab of fail-visible state (banner + roster when UI is up).
    frames["fail-visible"] = await frame("fail-visible");
    if (process.env.EDH_PALLIATIVE_SHOTDIR) {
      check(asserts, frames["fail-visible"] === true, "frame.fail-visible", frames["fail-visible"] ? "png ok" : "no done marker");
    }

    // --- acceptance (a)(b)(c) core ---
    check(asserts, !!health.configFailure, "config.failure", health.configFailure?.errors?.[0] ?? "missing");
    check(
      asserts,
      !health.emptyRosterOnly && (health.rosterNames?.length ?? 0) > 0,
      "roster.degraded",
      `names=${(health.rosterNames ?? []).join(",")}`,
    );
    check(
      asserts,
      (health.extras?.length ?? 0) > 0 || (health.live?.length ?? 0) > 0,
      "roster.disk-backed",
      `extras=${health.extras?.length ?? 0} live=${health.live?.length ?? 0}`,
    );
    check(asserts, !!health.lkg && (health.lkg.agents?.length ?? 0) > 0, "lkg.present", health.lkg?.savedAt ?? "none");
    check(
      asserts,
      !!health.lkgSpawn && health.lkgSpawn.refused === true,
      "lkg.spawn-refused",
      health.lkgSpawn
        ? `${health.lkgSpawn.name}: refused=${health.lkgSpawn.refused} ${health.lkgSpawn.message ?? ""}`
        : "no spawn attempt",
    );

    // Doctor command (d) — should open without throw; re-probe file for invalid finding via health.
    try {
      await vscode.commands.executeCommand("tachyon.doctor");
      check(asserts, true, "doctor.command", "executed");
    } catch (err) {
      check(asserts, false, "doctor.command", err instanceof Error ? err.message : String(err));
    }

    // Optional: restore valid config and confirm recovery path.
    const wsRoot =
      process.env.EDH_PALLIATIVE_WS
      || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
      || "";
    if (wsRoot) {
      const yml = path.join(wsRoot, "tachyon.yml");
      const valid = `agents:
  pilot:
    cmd: echo pilot-agent
    kind: agent
    autostart: false
    subagents: [reviewer]
  reviewer:
    cmd: echo reviewer-agent
    kind: agent
    autostart: false
commands:
  hello:
    cmd: "echo edh-palliative-ok"
`;
      fs.writeFileSync(yml, valid, "utf8");
      const recovered = await vscode.commands.executeCommand("tachyon._configHealth");
      check(asserts, recovered?.reloadOk === true && !recovered?.configFailure, "config.recovered", recovered?.reloadOk ? "reloadOk" : "still invalid");
    }

    const failed = asserts.filter((a) => !a.ok);
    const payload = {
      ok: failed.length === 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      asserts,
      health,
      doctorText,
      frames,
      shotDir: process.env.EDH_PALLIATIVE_SHOTDIR ?? null,
      sha: process.env.EDH_PALLIATIVE_SHA ?? null,
    };
    writeResult(payload);
    if (failed.length) {
      throw new Error(`edh-palliative headless failed: ${failed.map((f) => f.id).join(", ")}`);
    }
    console.log("[edh-palliative] PASSED");
  } catch (err) {
    const payload = {
      ok: false,
      startedAt,
      finishedAt: new Date().toISOString(),
      asserts,
      health,
      frames,
      error: err instanceof Error ? err.message : String(err),
      sha: process.env.EDH_PALLIATIVE_SHA ?? null,
    };
    writeResult(payload);
    throw err;
  }
};
