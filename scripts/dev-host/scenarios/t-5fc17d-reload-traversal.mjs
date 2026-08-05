/**
 * t-5fc17d — the reload CROSSING, as a standing case.
 *
 * Restore is the only family of product behaviour that needs a `Developer: Reload Window` to be
 * observed at all, so "can the harness see the other side of a reload" is the precondition for
 * verifying any of it. This scenario is that precondition, executable.
 *
 * What it establishes, in order:
 *   1. the window is observable BEFORE the reload (otherwise nothing after it means anything);
 *   2. the reload REALLY happened — a marker planted on `window` is gone afterwards, which no
 *      amount of "the page still answers" can fake;
 *   3. the window is observable AFTER it — same puppeteer Page handle, no reconnect needed,
 *      because VS Code reloads the renderer's webContents in place;
 *   4. editors that were open came back;
 *   5. a further command still lands, so the scenario can keep driving.
 *
 * Measured while writing it (2026-08-05): the crossing already worked. What did not work was the
 * harness's own account of it — `edhPid` pointed at the bin/code wrapper, so `status` reported a
 * healthy EDH as dead. This case exists so that "the harness cannot cross a reload" is a claim
 * something can answer, instead of a conclusion drawn from a broken liveness check.
 *
 * Run:
 *   node scripts/dev-host/headless-interactive.mjs \
 *     --scenario scripts/dev-host/scenarios/t-5fc17d-reload-traversal.mjs
 */

/** Never let the scenario itself become the hang we are trying to observe. */
const withTimeout = (p, ms, label) =>
  Promise.race([
    Promise.resolve(p).then((value) => ({ ok: true, value })),
    new Promise((r) => setTimeout(() => r({ ok: false, timedOut: true, label }), ms)),
  ]).catch((error) => ({ ok: false, label, error: String(error?.message ?? error).split("\n")[0].slice(0, 200) }));

const CENSUS = `JSON.stringify({
  tabs: document.querySelectorAll('.tabs-container .tab').length,
  groups: document.querySelectorAll('.editor-group-container').length,
  workbench: !!document.querySelector('.monaco-workbench'),
})`;

const MARKER = "t-5fc17d-planted-before-reload";

export async function run(ctx) {
  const asserts = [];
  const note = (id, ok, detail) => {
    asserts.push({ id, ok, detail });
    ctx.log(`ASSERT ${id} ok=${ok} :: ${detail}`);
  };

  // A couple of real editors, so "did anything come back" is a question with an answer.
  await ctx.command("View: Toggle Primary Side Bar Visibility");
  await ctx.command("Tachyon: Control");
  await ctx.sleep(3000);
  await ctx.command("Tachyon: Board");
  await ctx.sleep(4000);

  const before = await withTimeout(ctx.workbench.evaluate(CENSUS), 20000, "census-before");
  note("pre.observable", before.ok && JSON.parse(before.value || "{}").workbench === true, JSON.stringify(before));
  await ctx.shot("reload-pre");

  await ctx.workbench.evaluate((m) => { window.__t5fc17d = m; }, MARKER);
  const planted = await withTimeout(ctx.workbench.evaluate(() => window.__t5fc17d ?? null), 15000, "plant");
  note("pre.markerPlanted", planted.ok && planted.value === MARKER, JSON.stringify(planted));

  // ---- the crossing ----
  const issued = await withTimeout(ctx.command("Developer: Reload Window"), 30000, "reload-command");
  note("reload.issued", issued.ok, JSON.stringify(issued));

  // Restoring editors and reactivating the extension is not instant; poll rather than guess.
  let after = null;
  for (let attempt = 0; attempt < 24; attempt++) {
    await ctx.sleep(5000);
    const probe = await withTimeout(ctx.workbench.evaluate(CENSUS), 15000, `poll-${attempt}`);
    ctx.log(`poll t+${(attempt + 1) * 5}s :: ${JSON.stringify(probe)}`);
    if (!probe.ok) continue;
    const parsed = JSON.parse(probe.value || "{}");
    if (!parsed.workbench) continue;
    after = parsed;
    const target = before.ok ? JSON.parse(before.value || "{}").tabs ?? 0 : 0;
    if (parsed.tabs >= target) break;
  }
  note("post.observable", after !== null && after.workbench === true, JSON.stringify(after));

  // The load-bearing assert: a stale page that merely still answers would keep the marker.
  const marker = await withTimeout(ctx.workbench.evaluate(() => window.__t5fc17d ?? "<gone>"), 15000, "marker-after");
  note("post.reloadActuallyHappened", marker.ok && marker.value === "<gone>",
    `expected the planted marker to be gone; got ${JSON.stringify(marker)}`);

  await withTimeout(ctx.shot("reload-post"), 25000, "shot-after");

  const beforeTabs = before.ok ? JSON.parse(before.value || "{}").tabs ?? 0 : 0;
  note("post.editorsRestored", !!after && after.tabs >= beforeTabs && beforeTabs > 0,
    `tabs before=${beforeTabs} after=${after?.tabs}`);

  const again = await withTimeout(ctx.command("View: Toggle Primary Side Bar Visibility"), 25000, "post-command");
  note("post.stillDrivable", again.ok, JSON.stringify(again));

  return { asserts };
}
