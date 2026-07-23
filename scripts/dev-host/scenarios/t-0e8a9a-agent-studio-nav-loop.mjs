/**
 * t-0e8a9a repro + instrumentation — Agent Studio edit traps navigation.
 *
 * Reported flow (0.56.91 dogfood): Control → Fleet → "Edit" on an agent row (Agent Studio,
 * studio-edit) → click the "← Fleet" breadcrumb → Fleet flashes → bounces straight back to the
 * Agent Studio edit screen, forever; no other route wins either.
 *
 * Beyond reproducing, this installs a message spy INSIDE the Control webview (window-level
 * `message` events from the host) so we can see whether the nav checkpoint/ack handshake actually
 * happens when "back" is clicked — the webview's own console isn't visible to the parent CDP target,
 * so this is how we get client-side visibility.
 */
export async function run(ctx) {
  const asserts = [];
  const check = (id, ok, detail) => {
    asserts.push({ id, ok: !!ok, detail: detail ?? "" });
    ctx.log(`${ok ? "ok  " : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
  };

  await ctx.command("Tachyon: Open Control");
  await ctx.sleep(4000);
  const control = await ctx.findWebviewFrame(
    "!!document.querySelector('.ck-tabs') || !!document.querySelector('.ck-root')",
  );
  check("control-opened", !!control, control ? "found Control webview frame" : "no frame with .ck-root/.ck-tabs");
  if (!control) { await ctx.shot("no-control"); return { asserts }; }

  // install a host->webview message spy (records the last N inbound host messages by type)
  await control.evaluate(`(() => {
    if (window.__navspy) return;
    window.__navspy = [];
    window.addEventListener('message', (e) => {
      const d = e && e.data;
      const t = d && typeof d === 'object' ? (d.type || (typeof d.studioProtocolVersion === 'number' ? 'ENVELOPE:' + d.type : '?')) : typeof d;
      window.__navspy.push({ ts: Date.now(), type: t, hasStudio: !!(d && typeof d.studioProtocolVersion === 'number'), section: d && d.model ? d.model.section : undefined, activeRoute: d && d.model && d.model.activeRoute ? (d.model.activeRoute.kind + (d.model.activeRoute.studio ? ':' + d.model.activeRoute.studio : '')) : undefined });
      if (window.__navspy.length > 200) window.__navspy.shift();
    });
  })()`);

  const clickByText = async (frame, selector, text) => frame.evaluate(
    (sel, t) => {
      const els = [...document.querySelectorAll(sel)];
      const el = els.find((e) => (e.textContent || "").trim().includes(t));
      if (!el) return { ok: false, seen: els.map((e) => (e.textContent || "").trim()).slice(0, 30) };
      el.click();
      return { ok: true };
    }, selector, text,
  );

  const clickByTestId = async (frame, testid, text) => frame.evaluate(
    (id, t) => {
      const scope = document.querySelector(`[data-testid='${id}']`);
      if (!scope) return { ok: false, seen: `no [data-testid=${id}]` };
      const els = [...scope.querySelectorAll("button")];
      const el = els.find((e) => (e.textContent || "").trim().includes(t));
      if (!el) return { ok: false, seen: els.map((e) => (e.textContent || "").trim()) };
      el.click();
      return { ok: true };
    }, testid, text,
  );

  await clickByText(control, ".ck-tabs button", "Fleet");
  await ctx.sleep(2500);
  await ctx.shot("02-fleet");

  const editClick = await clickByTestId(control, "control-fleet", "Edit");
  check("edit-clicked", editClick.ok, editClick.ok ? "" : `buttons: ${JSON.stringify(editClick.seen)}`);
  await ctx.sleep(4000);
  const onStudio = await control.evaluate("!!document.querySelector(\"[data-testid='control-studio']\")");
  check("agent-studio-open", onStudio, onStudio ? "studio embed present" : "no control-studio testid");
  await ctx.shot("03-agent-studio");

  // clear the spy so we only see what happens FROM the back-click onward
  await control.evaluate("window.__navspy = []");

  const backClick = await clickByTestId(control, "control-studio-breadcrumb", "Fleet");
  check("breadcrumb-clicked", backClick.ok, backClick.ok ? "" : `breadcrumb: ${JSON.stringify(backClick.seen)}`);
  await ctx.sleep(8000); // let the 3s poll + any checkpoint timeout play out

  const spy = await control.evaluate("window.__navspy || []");
  ctx.log(`navspy (${spy.length} msgs after back-click):`);
  for (const m of spy) {
    ctx.log(`  +${m.type} section=${m.section ?? "-"} active=${m.activeRoute ?? "-"} studioEnv=${m.hasStudio}`);
  }
  const sawCheckpoint = spy.some((m) => m.type === "studioNavCheckpoint");
  const sawAbort = spy.some((m) => m.type === "studioNavAbort");
  check("checkpoint-issued", sawCheckpoint, sawCheckpoint ? "host sent studioNavCheckpoint" : "NO checkpoint seen after back-click");
  ctx.log(`sawAbort=${sawAbort}`);

  const state = await control.evaluate(`(() => {
    const studio = !!document.querySelector("[data-testid='control-studio']");
    const fleet = !!document.querySelector("[data-testid='control-fleet']");
    const active = [...document.querySelectorAll('.ck-tabs button')].find((b) => b.classList.contains('active'));
    return { studio, fleet, activeTab: active ? active.textContent.trim() : null };
  })()`);
  check("stays-on-fleet", state.fleet && !state.studio, `8s after back: fleet=${state.fleet} studio=${state.studio} activeTab=${state.activeTab}`);
  await ctx.shot("05-final");

  return { asserts };
}
