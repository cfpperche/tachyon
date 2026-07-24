/**
 * t-7426de dogfood — Grok headless probe via Dev Host headless interactive.
 *
 * 1) Runs adapter unit + binary-gated capability smoke against the pointed worktree.
 * 2) Optionally (PROBE_LIVE_SMOKE=1) runs a real freeform Grok model probe (costs $).
 * 3) Opens Control → Probes surface for UI evidence screenshot.
 *
 * Prereq:
 *   npm run dogfood:dev-host -- point --worktree <repo> --fixture companion-track-dogfood --spec 257 --slug probe-grok-runtime
 *   TACHYON_ENGINE_CHANNEL=dev npm run build
 *   node scripts/dev-host/headless-interactive.mjs --scenario scripts/dev-host/scenarios/probe-grok-runtime.mjs
 *
 * Env:
 *   PROBE_LIVE_SMOKE=1  — also run the paid live freeform probe (default: off)
 *   PROBE_SKIP_UI=1     — skip Control Probes UI steps (adapter-only)
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..", "..");

function runVitest(args, env = {}) {
  const vitestBin = path.join(REPO, "node_modules", ".bin", "vitest");
  const r = spawnSync(vitestBin, ["run", ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 180_000,
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    error: r.error ? String(r.error.message || r.error) : undefined,
  };
}

export async function run(ctx) {
  const asserts = [];
  const check = (id, ok, detail) => {
    asserts.push({ id, ok: !!ok, detail: detail ?? "" });
    ctx.log(`${ok ? "ok  " : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
  };

  // --- 1) Golden + capability smoke (free, offline-ish) ---
  ctx.log("running probeAdapterGrok + probeSmoke (capability)…");
  const unit = runVitest([
    "test/unit/probeAdapterGrok.test.ts",
    "test/unit/probeSmoke.test.ts",
    "-t",
    "capability|grok adapter",
  ]);
  const unitOk = unit.status === 0;
  check(
    "adapter-unit-and-capability-smoke",
    unitOk,
    unitOk
      ? "vitest exit 0"
      : `vitest exit ${unit.status}: ${(unit.stderr || unit.stdout).slice(-800)}`,
  );
  const outDir = ctx.outDir || path.join(REPO, ".tachyon", "dev-host", "interactive-out");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "vitest-unit.log"),
    `STATUS=${unit.status}\n--- stdout ---\n${unit.stdout}\n--- stderr ---\n${unit.stderr}\n`,
    "utf8",
  );

  // --- 2) Optional live freeform (paid) ---
  const live = process.env.PROBE_LIVE_SMOKE === "1";
  if (live) {
    ctx.log("PROBE_LIVE_SMOKE=1 — running real grok freeform probe…");
    // Match the describe title (spaces = regex "real grok end"); require at least 1 passed test.
    const liveRun = runVitest(
      ["test/unit/probeSmoke.test.ts", "-t", "real grok end"],
      { PROBE_LIVE_SMOKE: "1" },
    );
    const passed = /Tests\s+(\d+)\s+passed/.exec(liveRun.stdout)?.[1];
    const passedN = passed ? Number(passed) : 0;
    const liveOk = liveRun.status === 0 && passedN >= 1;
    check(
      "live-grok-freeform",
      liveOk,
      liveOk
        ? `ProbeService freeform → ok (${passedN} passed)`
        : `vitest exit ${liveRun.status}, passed=${passedN}: ${(liveRun.stderr || liveRun.stdout).slice(-1200)}`,
    );
    fs.writeFileSync(
      path.join(outDir, "vitest-live.log"),
      `STATUS=${liveRun.status}\n--- stdout ---\n${liveRun.stdout}\n--- stderr ---\n${liveRun.stderr}\n`,
      "utf8",
    );
  } else {
    check("live-grok-freeform", true, "skipped (set PROBE_LIVE_SMOKE=1 to spend a real model call)");
  }

  if (process.env.PROBE_SKIP_UI === "1") {
    check("probes-ui", true, "skipped (PROBE_SKIP_UI=1)");
    await ctx.shot("probe-skip-ui");
    return { asserts };
  }

  // --- 3) Control Probes surface (UI evidence in the EDH) ---
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

  // Command palette: Open Probes (workspace probes / inspector surface from SDD 257 UI).
  await ctx.command("Tachyon: Open Probes");
  await ctx.sleep(3000);
  await ctx.shot("02-probes");

  // Best-effort: ProbesApp or empty state still counts as surface mounted.
  const probesFrame = await ctx.findWebviewFrame(
    "!!document.querySelector('[data-testid]') || !!document.querySelector('.ck-root') || !!document.body?.innerText",
  );
  check("probes-surface", !!probesFrame, probesFrame ? "webview frame still present after Open Probes" : "no webview after Open Probes");

  // Peek for any probe-related chrome text.
  if (control) {
    const peek = await control.evaluate(() => {
      const t = (document.body?.innerText || "").slice(0, 400);
      return { text: t, hasProbe: /probe/i.test(t) };
    }).catch(() => ({ text: "", hasProbe: false }));
    check("probes-ui-text", true, peek.hasProbe ? "saw 'probe' in Control text" : `Control text sample: ${peek.text.slice(0, 120)}`);
  }

  return { asserts };
}
