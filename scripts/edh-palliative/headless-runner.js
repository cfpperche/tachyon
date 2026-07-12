/**
 * EDH palliative headless runner (extensionTestsPath).
 *
 * Scenario S1 (t-8354ae fail-visible): fixture opens with invalid tachyon.yml + LKG + ledger.
 * Asserts configFailure, degraded roster (not empty-only), LKG spawn refusal, Doctor findings.
 *
 * Env:
 *   EDH_PALLIATIVE_RESULT  — path to write JSON report (required for shell to reap status)
 *   EDH_PALLIATIVE_WS      — workspace root (optional; defaults to first folder)
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

exports.run = async function run() {
  const asserts = [];
  const startedAt = new Date().toISOString();
  let health = null;
  let doctorText = "";

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

    // Cold start against whatever is on disk (seed+break → invalid config).
    try {
      await vscode.commands.executeCommand("tachyon.start");
    } catch (err) {
      console.warn("[edh-palliative] tachyon.start threw (may be expected when config invalid):", err);
    }
    await sleep(1500);

    health = await vscode.commands.executeCommand("tachyon._configHealth");
    if (!health || health.ok === false) {
      throw new Error(`_configHealth failed: ${health?.error ?? "null"}`);
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
      error: err instanceof Error ? err.message : String(err),
      sha: process.env.EDH_PALLIATIVE_SHA ?? null,
    };
    writeResult(payload);
    throw err;
  }
};
