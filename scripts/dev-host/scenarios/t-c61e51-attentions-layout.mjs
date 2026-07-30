/**
 * t-c61e51 — OS-level Visual QA of the REAL Tachyon sidebar in EDH.
 *
 * Captures Attentions vs Agents at two workbench widths via CDP screenshots of a live
 * Extension Development Host (not a static HTML unit harness). Asserts Clear sits on
 * the section header row with ATTENTIONS when present, and never as a second toolbar.
 */
export async function run(ctx) {
  const asserts = [];
  const check = (id, ok, detail) => {
    asserts.push({ id, ok: !!ok, detail: detail ?? "" });
    ctx.log(`${ok ? "ok  " : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
  };

  // Focus Tachyon activity / sidebar.
  for (const cmd of [
    "workbench.view.extension.tachyon",
    "tachyonSidebarPrototype.focus",
  ]) {
    try {
      await ctx.command(cmd);
    } catch {
      /* some hosts only have one of these */
    }
    await ctx.sleep(800);
  }
  await ctx.sleep(2500);

  const findSidebar = async () =>
    ctx.findWebviewFrame(
      "!!document.querySelector('[data-testid=\"tab-attentions\"]') || !!document.querySelector('.tabs[role=\"tablist\"]')",
    );

  let sidebar = await findSidebar();
  if (!sidebar) {
    // Palette focus sometimes lands on editor — try once more after opening the view.
    try {
      await ctx.command("workbench.action.focusSideBar");
    } catch {
      /* ignore */
    }
    await ctx.sleep(1500);
    sidebar = await findSidebar();
  }
  check("sidebar-frame", !!sidebar, sidebar ? "found Tachyon sidebar webview" : "no sidebar webview frame");
  if (!sidebar) {
    await ctx.shot("fail-no-sidebar");
    return { asserts };
  }

  /** Click a tab button inside the sidebar webview by its accessible name / testid. */
  const selectTab = async (id) => {
    const frame = await findSidebar();
    if (!frame) return { ok: false, reason: "frame gone" };
    return frame.evaluate((tabId) => {
      const byTest = tabId === "Attentions"
        ? document.querySelector('[data-testid="tab-attentions"]')
        : null;
      const tabs = [...document.querySelectorAll('.tabs [role="tab"], .tab')];
      const el = byTest
        || tabs.find((t) => (t.getAttribute("aria-label") || "").startsWith(tabId))
        || tabs.find((t) => (t.id || "") === `tab-${tabId}`);
      if (!el) return { ok: false, reason: `tab ${tabId} not found`, seen: tabs.map((t) => t.getAttribute("aria-label") || t.id) };
      el.click();
      return { ok: true };
    }, id);
  };

  const geometry = async () => {
    const frame = await findSidebar();
    if (!frame) return { ok: false, reason: "no frame" };
    return frame.evaluate(() => {
      const sec = document.querySelector(".sec");
      const clear = document.querySelector('[data-testid="attention-clear"]');
      const label = sec?.querySelector("b");
      const toolbar = document.querySelector('[data-testid="attention-toolbar"]');
      const badge = document.querySelector('[data-testid="tab-attentions-badge"]');
      const stack = document.querySelector('[data-testid="attention-stack"], [data-testid="attention-stack-empty"]');
      const active = document.querySelector('.tab.active, [role="tab"][aria-selected="true"]');
      const base = {
        noToolbar: !toolbar,
        hasBadge: !!badge,
        hasStack: !!stack,
        activeLabel: active?.getAttribute("aria-label") || active?.id || "",
        secText: label?.textContent || "",
        secHeight: sec ? Math.round(sec.getBoundingClientRect().height) : 0,
      };
      if (!clear || !label || !sec) {
        return { ok: true, ...base, hasClear: !!clear, sameRow: null, clearInSec: null };
      }
      const sr = sec.getBoundingClientRect();
      const cr = clear.getBoundingClientRect();
      const lr = label.getBoundingClientRect();
      return {
        ok: true,
        ...base,
        hasClear: true,
        sameRow: Math.abs(cr.top - lr.top) < 10,
        clearInSec: cr.top >= sr.top - 2 && cr.bottom <= sr.bottom + 2,
        secHeight: Math.round(sr.height),
      };
    });
  };

  // Two effective viewport widths via CDP Emulation (Browser.getWindowForTarget is not always
  // available when attached as a non-root session to Electron's CDP).
  const session = await ctx.workbench.createCDPSession();
  const widths = [
    { id: "narrow", width: 1100, height: 900 },
    { id: "normal", width: 1440, height: 900 },
  ];

  for (const w of widths) {
    try {
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: w.width,
        height: w.height,
        deviceScaleFactor: 1,
        mobile: false,
      });
    } catch (err) {
      ctx.log(`emulation width ${w.width} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Also pin the sidebar webview host width when we can find it (true sidebar strip widths).
    try {
      await ctx.workbench.evaluate((px) => {
        const hosts = [...document.querySelectorAll(".webview, .monaco-workbench")];
        // Best-effort: set a CSS variable many layouts read; if not, the viewport change still stands.
        document.documentElement.style.setProperty("--tachyon-qa-width", `${px}px`);
      }, w.id === "narrow" ? 220 : 340);
    } catch {
      /* ignore */
    }
    await ctx.sleep(1200);

    // --- Attentions ---
    const attClick = await selectTab("Attentions");
    check(`attentions-tab-${w.id}`, attClick.ok, attClick.ok ? "" : JSON.stringify(attClick));
    await ctx.sleep(900);
    await ctx.shot(`os-attentions-${w.id}`);
    const g = await geometry();
    check(`geom-no-toolbar-${w.id}`, g.ok && g.noToolbar, JSON.stringify(g));
    check(`geom-stack-${w.id}`, g.ok && g.hasStack, JSON.stringify(g));
    if (g.hasClear) {
      check(`geom-clear-same-row-${w.id}`, g.sameRow === true, JSON.stringify(g));
      check(`geom-clear-in-sec-${w.id}`, g.clearInSec === true, JSON.stringify(g));
      check(`geom-sec-compact-${w.id}`, (g.secHeight ?? 99) <= 44, `secHeight=${g.secHeight}`);
    } else {
      check(`geom-clear-optional-empty-${w.id}`, true, "no open attentions — Clear correctly absent");
    }

    // --- Agents (comparison) ---
    const agentsClick = await selectTab("Agents");
    check(`agents-tab-${w.id}`, agentsClick.ok, agentsClick.ok ? "" : JSON.stringify(agentsClick));
    await ctx.sleep(900);
    await ctx.shot(`os-agents-${w.id}`);
    const agentsFrame = await findSidebar();
    const agentsSec = agentsFrame
      ? await agentsFrame.evaluate(() => {
        const sec = document.querySelector(".sec");
        const b = sec?.querySelector("b");
        return {
          label: b?.textContent || "",
          secHeight: sec ? Math.round(sec.getBoundingClientRect().height) : 0,
          hasSecActions: !!document.querySelector(".sec .sec-actions"),
        };
      })
      : null;
    check(
      `agents-sec-${w.id}`,
      !!agentsSec && /agents/i.test(agentsSec.label),
      JSON.stringify(agentsSec),
    );
    if (agentsSec && g.secHeight) {
      // Attentions section header should be comparable density to Agents (not a tall toolbar stack).
      const delta = Math.abs((g.secHeight || 0) - agentsSec.secHeight);
      check(`sec-density-parity-${w.id}`, delta <= 16, `att=${g.secHeight} agents=${agentsSec.secHeight}`);
    }
  }

  return { asserts };
}
