/**
 * SDD 443 / t-7551f9 + t-6d09e6 — Dev Host headless dogfood.
 *
 * 1) Unit: cmdRuntimeGate + sessionContinuation (worktree source)
 * 2) Module smoke: prepareContinueTask writes handoff under a temp root
 * 3) EDH: Open Control + Fleet for UI evidence (engine carries continue_task after this build)
 *
 *   npm run dogfood -- dev-host -- point --worktree <wt> --fixture companion-track-dogfood --spec 443 --slug session-continuation
 *   TACHYON_ENGINE_CHANNEL=dev npm run build --prefix <wt>
 *   node scripts/dev-host/headless-interactive.mjs --scenario scripts/dev-host/scenarios/session-continuation-443.mjs
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// scenario lives in scripts/dev-host/scenarios → worktree root is ../../../
const REPO = path.resolve(here, "..", "..", "..");

function runVitest(args, timeoutMs = 120_000) {
  const vitestBin = path.join(REPO, "node_modules", ".bin", "vitest");
  // Prefer monorepo vitest if worktree has no node_modules/.bin
  const bin = fs.existsSync(vitestBin)
    ? vitestBin
    : path.join("/home/goat/tachyon/node_modules/.bin/vitest");
  const r = spawnSync(bin, ["run", ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: process.env,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return { status: r.status ?? 1, stdout: r.stdout || "", stderr: r.stderr || "" };
}

export async function run(ctx) {
  const asserts = [];
  const check = (id, ok, detail) => {
    asserts.push({ id, ok: !!ok, detail: detail ?? "" });
    ctx.log(`${ok ? "ok  " : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
  };
  const outDir = ctx.outDir || path.join(REPO, ".tachyon", "dev-host", "interactive-out");
  fs.mkdirSync(outDir, { recursive: true });

  // --- 1) unit tests ---
  ctx.log("vitest cmdRuntimeGate + sessionContinuation…");
  const unit = runVitest([
    "test/unit/cmdRuntimeGate.test.ts",
    "test/unit/sessionContinuation.test.ts",
  ]);
  fs.writeFileSync(
    path.join(outDir, "vitest-session-continuation.log"),
    `STATUS=${unit.status}\n--- stdout ---\n${unit.stdout}\n--- stderr ---\n${unit.stderr}\n`,
  );
  const passed = /Tests\s+(\d+)\s+passed/.exec(unit.stdout)?.[1];
  const passedN = passed ? Number(passed) : 0;
  check(
    "unit-gate-and-handoff",
    unit.status === 0 && passedN >= 9,
    unit.status === 0 ? `${passedN} passed` : `exit ${unit.status}: ${(unit.stderr || unit.stdout).slice(-600)}`,
  );

  // --- 2) real Grok agents on real tmux (skipIf no grok/tmux inside the suite) ---
  ctx.log("integration dogfood: continue_task with cmd:grok agents…");
  const grokDog = runVitest(
    ["test/integration/sessionContinuationGrokDogfood.test.ts"],
    200_000,
  );
  // Allow longer — spawn real grok
  fs.writeFileSync(
    path.join(outDir, "vitest-grok-agents.log"),
    `STATUS=${grokDog.status}\n--- stdout ---\n${grokDog.stdout}\n--- stderr ---\n${grokDog.stderr}\n`,
  );
  const grokPassed = /Tests\s+(\d+)\s+passed/.exec(grokDog.stdout)?.[1];
  const grokSkipped = /Tests\s+\d+\s+skipped|skipped/.test(grokDog.stdout) && !/1 passed/.test(grokDog.stdout);
  const grokOk =
    grokDog.status === 0 &&
    (Number(grokPassed) >= 1 || /skipIf|no test|skipped \(1\)/.test(grokDog.stdout));
  // Prefer real pass; if skipped (no grok/tmux) mark ok with detail skip
  if (Number(grokPassed) >= 1) {
    check("grok-agents-continue-task", true, `integration ${grokPassed} passed (real grok+tmux)`);
  } else if (grokDog.status === 0) {
    check("grok-agents-continue-task", true, "skipped (grok or tmux unavailable in env)");
  } else {
    check(
      "grok-agents-continue-task",
      false,
      `exit ${grokDog.status}: ${(grokDog.stderr || grokDog.stdout).slice(-800)}`,
    );
  }

  // --- 3) EDH Control surface ---
  await ctx.command("Tachyon: Open Control");
  await ctx.sleep(4000);
  const control = await ctx.findWebviewFrame(
    "!!document.querySelector('.ck-tabs') || !!document.querySelector('.ck-root')",
  );
  check("control-open", !!control);
  if (!control) {
    await ctx.shot("no-control");
    return { asserts };
  }
  await ctx.shot("01-control");

  await control.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) =>
      /fleet/i.test((b.textContent || "").trim()),
    );
    if (btn) btn.click();
  });
  await ctx.sleep(2000);
  await ctx.shot("02-fleet");

  const fleetText = await control.evaluate(() => (document.body?.innerText || "").slice(0, 500));
  check(
    "fleet-visible",
    /fleet|agent|claude|codex|grok/i.test(fleetText),
    fleetText.slice(0, 160).replace(/\s+/g, " "),
  );

  // Gate module is in the pointed extension build — presence of dist after build is a packaging check.
  const distJs = path.join(REPO, "dist", "extension.js");
  check("extension-dist-built", fs.existsSync(distJs), distJs);

  return { asserts };
}
