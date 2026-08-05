/**
 * t-a03fb6 / SDD 485 D21 — exercise restore with section apps open across editor groups.
 *
 * MEASUREMENT. Reuses headless-interactive + the reload-crossing technique from
 * `t-5fc17d-reload-traversal.mjs` (marker plant, poll, post-drive).
 *
 * Opening was driven by temporary palette commands (`Tachyon: Restore Exercise Open` /
 * `Tachyon: Restore Exercise Dump`) registered only for the 2026-08-05 measurement and then removed
 * from product. Evidence from that run lives under
 * `docs/specs/485-standalone-section-apps/evidence/t-a03fb6-restore-exercise-*.md|json`.
 * Re-running this scenario requires re-adding those measurement hooks (or another open path).
 *
 * Run (with measurement commands present):
 *   node scripts/dev-host/headless-interactive.mjs \
 *     --scenario scripts/dev-host/scenarios/t-a03fb6-restore-exercise.mjs \
 *     --timeout 600 \
 *     --out .tachyon/dev-host/interactive-out-a03fb6
 */

import fs from "node:fs";
import path from "node:path";

const withTimeout = (p, ms, label) =>
  Promise.race([
    Promise.resolve(p).then((value) => ({ ok: true, value })),
    new Promise((r) => setTimeout(() => r({ ok: false, timedOut: true, label }), ms)),
  ]).catch((error) => ({
    ok: false,
    label,
    error: String(error?.message ?? error).split("\n")[0].slice(0, 200),
  }));

const MARKER = "t-a03fb6-planted-before-reload";

const CENSUS = `(() => {
  const groups = [...document.querySelectorAll('.editor-group-container')];
  const rows = [];
  groups.forEach((g, gi) => {
    const tabs = [...g.querySelectorAll('.tabs-container .tab')];
    tabs.forEach((t, ti) => {
      const label =
        t.getAttribute('aria-label')
        || t.querySelector('.tab-label')?.textContent
        || t.textContent
        || '';
      rows.push({
        group: gi,
        index: ti,
        label: label.replace(/\\s+/g, ' ').trim().slice(0, 160),
        active: t.classList.contains('active') || t.getAttribute('aria-selected') === 'true',
      });
    });
  });
  return JSON.stringify({
    workbench: !!document.querySelector('.monaco-workbench'),
    groups: groups.length,
    tabs: rows.length,
    rows,
  });
})()`;

function readWorkspaceJson(name) {
  // pointed fixture mirror
  const candidates = [
    path.join(process.cwd(), ".tachyon/dev-host/workspace/.tachyon", name),
    path.join(process.cwd(), "test/fixtures/agent-studio-canonical-dogfood/.tachyon", name),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return { path: p, data: JSON.parse(fs.readFileSync(p, "utf8")) };
    } catch {
      /* try next */
    }
  }
  return null;
}

function labelHits(rows, fragment) {
  return (rows ?? []).filter((r) => r.label.includes(fragment));
}

function analyze({ preDom, postDom, preDump, postDump }) {
  const preRows = preDom?.rows ?? [];
  const postRows = postDom?.rows ?? [];
  const preKeys = preDump?.openKeys ?? {};
  const postKeys = postDump?.openKeys ?? {};

  const flattenKeys = (keys) =>
    Object.entries(keys).flatMap(([mgr, list]) => (list ?? []).map((k) => `${mgr}::${k}`));
  const preFlat = flattenKeys(preKeys).sort();
  const postFlat = flattenKeys(postKeys).sort();

  // Q1 — all apps return (authoritative keys if dump available; else DOM labels)
  const missingKeys = preFlat.filter((k) => !postFlat.includes(k));
  const extraKeys = postFlat.filter((k) => !preFlat.includes(k));
  const preLabels = preRows.map((r) => r.label);
  const postLabels = postRows.map((r) => r.label);
  const q1 = {
    question: "Do all apps return after reload?",
    preTabsDom: preDom?.tabs ?? 0,
    postTabsDom: postDom?.tabs ?? 0,
    preGroupsDom: preDom?.groups ?? 0,
    postGroupsDom: postDom?.groups ?? 0,
    preTabCountDump: preDump?.tabCount ?? null,
    postTabCountDump: postDump?.tabCount ?? null,
    preOpenKeys: preKeys,
    postOpenKeys: postKeys,
    preFlatKeys: preFlat,
    postFlatKeys: postFlat,
    missingKeys,
    extraKeys,
    preLabels,
    postLabels,
    answer:
      preFlat.length > 0 && missingKeys.length === 0 && postFlat.length >= preFlat.length
        ? "YES (observed — every pre-open key present post-reload)"
        : preFlat.length === 0
          ? "INCOMPLETE (no pre dump keys)"
          : `NO (${missingKeys.length} keys missing after reload)`,
  };

  // Q2 — same entity for documents
  const wantDocs = [
    "t-restore-a",
    "t-restore-b",
    "p-restore-a",
    "p-restore-b",
  ];
  const keyHas = (flat, id) => flat.some((k) => k.includes(id));
  const entities = wantDocs.map((id) => ({
    id,
    preKey: keyHas(preFlat, id),
    postKey: keyHas(postFlat, id),
    preDom: labelHits(preRows, id).map((r) => r.label),
    postDom: labelHits(postRows, id).map((r) => r.label),
    sameEntityReturned: keyHas(preFlat, id) && keyHas(postFlat, id),
  }));
  const q2 = {
    question: "Do documents return to the SAME entity?",
    entities,
    answer: entities.every((e) => e.sameEntityReturned)
      ? "YES (observed — each seeded task/pin identity key present pre and post)"
      : entities.some((e) => e.preKey && !e.postKey)
        ? "NO (identity key lost)"
        : "INCOMPLETE (documents not open pre-reload)",
  };

  // Q3 — cardinality
  const countSuffix = (flat, re) => flat.filter((k) => re.test(k)).length;
  const dashCard = Object.fromEntries(
    Object.entries(postKeys).map(([mgr, list]) => [mgr, { pre: (preKeys[mgr] ?? []).length, post: (list ?? []).length }]),
  );
  const multiPost = Object.entries(dashCard).filter(([, c]) => c.post > 1 && !["taskDetail", "pinDetail", "agentStudio", "commandStudio", "terminalStudio", "runbookStudio", "scheduleStudio", "activity", "probes"].includes);
  // windows should be exactly 1 when open
  const windowManagers = ["tmux", "runtimeOps"];
  const windowOk = windowManagers.every((m) => (postKeys[m] ?? []).length <= 1);
  const docIds = {};
  for (const id of wantDocs) {
    docIds[id] = postFlat.filter((k) => k.includes(id)).length;
  }
  const q3 = {
    question: "Does cardinality survive restore?",
    managerCounts: dashCard,
    windowManagersPost: Object.fromEntries(windowManagers.map((m) => [m, postKeys[m] ?? []])),
    documentIdentityCountsPost: docIds,
    multiPanelManagersPost: multiPost,
    answer:
      windowOk
      && Object.values(docIds).every((n) => n <= 1)
      && !Object.entries(postKeys).some(([mgr, list]) =>
        ["overview", "engine", "fleet", "humanInbox", "board", "worktrees", "executionGraph", "runtimeConfig", "plugins", "settings", "handoff"].includes(mgr)
        && (list ?? []).length > 1)
        ? "YES (observed — dashboards ≤1, windows ≤1, document ids ≤1)"
        : "NO (cardinality violation — see managerCounts)",
  };

  // Q4 — editor groups from dump (viewColumn) and DOM
  const groupOf = (dump, labelSub) => {
    const hits = [];
    for (const g of dump?.tabGroups ?? []) {
      for (const t of g.tabs ?? []) {
        if ((t.label || "").includes(labelSub) || JSON.stringify(t.input || {}).includes(labelSub)) {
          hits.push({ groupIndex: g.groupIndex, viewColumn: g.viewColumn, label: t.label });
        }
      }
    }
    return hits;
  };
  const keyLabels = ["Board", "Fleet", "Engine", "tmux", "Plugins", "Task t-restore-a", "Task t-restore-b", "Pin — p-restore-a", "Pin — p-restore-b"];
  const groupMap = keyLabels.map((frag) => {
    const pre = groupOf(preDump, frag.replace(/^Task /, "").replace(/^Pin — /, "")) ;
    // also match tab labels
    const preL = (preDump?.tabGroups ?? []).flatMap((g) =>
      (g.tabs ?? []).filter((t) => (t.label || "").includes(frag.split(" ").pop()) || (t.label || "").includes(frag))
        .map((t) => ({ groupIndex: g.groupIndex, viewColumn: g.viewColumn, label: t.label })),
    );
    const postL = (postDump?.tabGroups ?? []).flatMap((g) =>
      (g.tabs ?? []).filter((t) => (t.label || "").includes(frag.split(" ").pop()) || (t.label || "").includes(frag))
        .map((t) => ({ groupIndex: g.groupIndex, viewColumn: g.viewColumn, label: t.label })),
    );
    const preG = preL.map((x) => x.viewColumn);
    const postG = postL.map((x) => x.viewColumn);
    return {
      frag,
      pre: preL,
      post: postL,
      preserved: preG.length > 0 && JSON.stringify(preG) === JSON.stringify(postG),
    };
  });
  const q4 = {
    question: "Does position across editor groups survive?",
    preGroupCount: preDump?.groupCount ?? preDom?.groups ?? 0,
    postGroupCount: postDump?.groupCount ?? postDom?.groups ?? 0,
    groupMap,
    answer:
      (preDump?.groupCount ?? 0) > 1
      && (postDump?.groupCount ?? 0) >= 2
      && groupMap.filter((g) => g.pre.length).every((g) => g.preserved)
        ? "YES (observed — viewColumns of key tabs match pre/post)"
        : (preDump?.groupCount ?? 0) > 1 && (postDump?.groupCount ?? 0) >= 2
          ? "PARTIAL (groups restored; some tabs moved — see groupMap)"
          : "INCOMPLETE / NO",
  };

  return { q1, q2, q3, q4 };
}

export async function run(ctx) {
  const asserts = [];
  const note = (id, ok, detail) => {
    asserts.push({ id, ok: !!ok, detail: detail ?? "" });
    ctx.log(`ASSERT ${id} ok=${ok} :: ${detail}`);
  };

  const evidence = {
    startedAt: new Date().toISOString(),
    preDom: null,
    postDom: null,
    preDump: null,
    postDump: null,
    analysis: null,
    reload: {},
  };

  // settle extension host
  await ctx.sleep(4000);
  try {
    await ctx.command("View: Toggle Primary Side Bar Visibility");
  } catch {
    /* ignore */
  }
  await ctx.sleep(1000);

  // ---- open all apps via measurement command ----
  const openCmd = await withTimeout(ctx.command("Tachyon: Restore Exercise Open"), 120000, "restore-open");
  note("pre.openCommand", openCmd.ok, JSON.stringify(openCmd));
  // opening many panels takes wall clock beyond the command return (command palette returns when issued)
  await ctx.sleep(45000);

  // dump again to be sure file is written after panels settle
  const dumpPreCmd = await withTimeout(ctx.command("Tachyon: Restore Exercise Dump"), 30000, "dump-pre");
  note("pre.dumpCommand", dumpPreCmd.ok, JSON.stringify(dumpPreCmd));
  await ctx.sleep(3000);

  // read dump from workspace (file written by the command)
  // phase name from open is pre-open; dump command uses "dump"
  let preDumpFile = readWorkspaceJson("restore-exercise-pre-open.json");
  if (!preDumpFile) preDumpFile = readWorkspaceJson("restore-exercise-dump.json");
  evidence.preDump = preDumpFile?.data ?? null;
  note(
    "pre.dumpFile",
    !!evidence.preDump && (evidence.preDump.tabCount ?? 0) >= 10,
    preDumpFile
      ? `path=${preDumpFile.path} tabs=${evidence.preDump?.tabCount} groups=${evidence.preDump?.groupCount} keys=${JSON.stringify(evidence.preDump?.openKeys)}`
      : "no dump file",
  );

  const beforeRaw = await withTimeout(ctx.workbench.evaluate(CENSUS), 20000, "census-before");
  if (beforeRaw.ok) {
    try {
      evidence.preDom = JSON.parse(beforeRaw.value || "{}");
    } catch {
      evidence.preDom = { parseError: true, raw: beforeRaw.value };
    }
  }
  note("pre.observable", !!evidence.preDom?.workbench, JSON.stringify({ groups: evidence.preDom?.groups, tabs: evidence.preDom?.tabs }));
  await ctx.shot("a03fb6-pre-reload");
  fs.writeFileSync(path.join(ctx.outDir, "restore-exercise-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);

  // ---- reload crossing (t-5fc17d technique) ----
  await ctx.workbench.evaluate((m) => {
    window.__ta03fb6 = m;
  }, MARKER);
  const planted = await withTimeout(ctx.workbench.evaluate(() => window.__ta03fb6 ?? null), 15000, "plant");
  note("pre.markerPlanted", planted.ok && planted.value === MARKER, JSON.stringify(planted));

  const issued = await withTimeout(ctx.command("Developer: Reload Window"), 30000, "reload-command");
  note("reload.issued", issued.ok, JSON.stringify(issued));
  evidence.reload.issued = issued;

  const targetTabs = evidence.preDump?.tabCount ?? evidence.preDom?.tabs ?? 10;
  let after = null;
  for (let attempt = 0; attempt < 36; attempt++) {
    await ctx.sleep(5000);
    const probe = await withTimeout(ctx.workbench.evaluate(CENSUS), 15000, `poll-${attempt}`);
    ctx.log(`poll t+${(attempt + 1) * 5}s :: ${JSON.stringify(probe).slice(0, 500)}`);
    if (!probe.ok) continue;
    let parsed;
    try {
      parsed = JSON.parse(probe.value || "{}");
    } catch {
      continue;
    }
    if (!parsed.workbench) continue;
    after = parsed;
    if (parsed.tabs >= Math.max(1, Math.floor(targetTabs * 0.6))) break;
  }
  evidence.postDom = after;
  note("post.observable", after !== null && after?.workbench === true, JSON.stringify({ groups: after?.groups, tabs: after?.tabs }));

  const marker = await withTimeout(
    ctx.workbench.evaluate(() => window.__ta03fb6 ?? "<gone>"),
    15000,
    "marker-after",
  );
  note(
    "post.reloadActuallyHappened",
    marker.ok && marker.value === "<gone>",
    `expected planted marker gone; got ${JSON.stringify(marker)}`,
  );
  evidence.reload.markerAfter = marker;

  // post dump (extension reactivated; managers re-bound from serializers)
  await ctx.sleep(8000);
  const dumpPostCmd = await withTimeout(ctx.command("Tachyon: Restore Exercise Dump"), 30000, "dump-post");
  note("post.dumpCommand", dumpPostCmd.ok, JSON.stringify(dumpPostCmd));
  await ctx.sleep(2000);
  // dump writes restore-exercise-dump.json (overwrites)
  const postDumpFile = readWorkspaceJson("restore-exercise-dump.json");
  evidence.postDump = postDumpFile?.data ?? null;
  note(
    "post.dumpFile",
    !!evidence.postDump,
    postDumpFile
      ? `path=${postDumpFile.path} tabs=${evidence.postDump?.tabCount} groups=${evidence.postDump?.groupCount} keys=${JSON.stringify(evidence.postDump?.openKeys)}`
      : "no post dump file",
  );

  await withTimeout(ctx.shot("a03fb6-post-reload"), 25000, "shot-after");
  const again = await withTimeout(ctx.command("View: Toggle Primary Side Bar Visibility"), 25000, "post-command");
  note("post.stillDrivable", again.ok, JSON.stringify(again));

  const analysis = analyze({
    preDom: evidence.preDom,
    postDom: evidence.postDom,
    preDump: evidence.preDump,
    postDump: evidence.postDump,
  });
  evidence.analysis = analysis;
  evidence.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(ctx.outDir, "restore-exercise-evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);

  const summary = [
    "# t-a03fb6 restore exercise — observed answers",
    "",
    `## Q1 ${analysis.q1.answer}`,
    `- pre tabs dump=${analysis.q1.preTabCountDump} dom=${analysis.q1.preTabsDom}`,
    `- post tabs dump=${analysis.q1.postTabCountDump} dom=${analysis.q1.postTabsDom}`,
    `- pre keys (${analysis.q1.preFlatKeys.length}): ${JSON.stringify(analysis.q1.preFlatKeys)}`,
    `- post keys (${analysis.q1.postFlatKeys.length}): ${JSON.stringify(analysis.q1.postFlatKeys)}`,
    `- missing: ${JSON.stringify(analysis.q1.missingKeys)}`,
    `- pre labels: ${JSON.stringify(analysis.q1.preLabels)}`,
    `- post labels: ${JSON.stringify(analysis.q1.postLabels)}`,
    "",
    `## Q2 ${analysis.q2.answer}`,
    `- entities: ${JSON.stringify(analysis.q2.entities)}`,
    "",
    `## Q3 ${analysis.q3.answer}`,
    `- managerCounts: ${JSON.stringify(analysis.q3.managerCounts)}`,
    `- windowManagersPost: ${JSON.stringify(analysis.q3.windowManagersPost)}`,
    `- documentIdentityCountsPost: ${JSON.stringify(analysis.q3.documentIdentityCountsPost)}`,
    "",
    `## Q4 ${analysis.q4.answer}`,
    `- preGroupCount=${analysis.q4.preGroupCount} postGroupCount=${analysis.q4.postGroupCount}`,
    `- groupMap: ${JSON.stringify(analysis.q4.groupMap)}`,
    "",
  ].join("\n");
  fs.writeFileSync(path.join(ctx.outDir, "restore-exercise-answers.md"), summary);
  // durable copy under docs for the task deliverable
  try {
    const docsDir = path.join(process.cwd(), "docs/specs/485-standalone-section-apps/evidence");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, "t-a03fb6-restore-exercise-answers.md"), summary);
    fs.copyFileSync(
      path.join(ctx.outDir, "restore-exercise-evidence.json"),
      path.join(docsDir, "t-a03fb6-restore-exercise-evidence.json"),
    );
  } catch (err) {
    ctx.log(`docs copy failed: ${err}`);
  }
  ctx.log(summary);

  note("q1.allAppsReturn", analysis.q1.answer.startsWith("YES"), analysis.q1.answer);
  note("q2.sameEntity", analysis.q2.answer.startsWith("YES"), analysis.q2.answer);
  note("q3.cardinality", analysis.q3.answer.startsWith("YES"), analysis.q3.answer);
  note("q4.editorGroups", analysis.q4.answer.startsWith("YES") || analysis.q4.answer.startsWith("PARTIAL"), analysis.q4.answer);

  return { asserts };
}
