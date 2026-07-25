/**
 * t-f03ae5 — a new canonical Codex exposes and defaults its typed native policy.
 */
export async function run(ctx) {
  const asserts = [];
  const check = (id, ok, detail = "") => {
    asserts.push({ id, ok: Boolean(ok), detail });
    ctx.log(`${ok ? "ok  " : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
  };

  await ctx.command("Tachyon: New Agent Studio");
  await ctx.sleep(2500);
  const studio = await ctx.findWebviewFrame("!!document.querySelector('#ash-cmd')");
  check("new-agent-opened", studio, studio ? "found Agent Studio frame" : "no #ash-cmd frame");
  if (!studio) {
    await ctx.shot("new-agent-missing");
    return { asserts };
  }

  await studio.evaluate(`(() => {
    const command = document.querySelector('#ash-cmd');
    command.value = 'codex';
    command.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await ctx.sleep(500);

  const state = await studio.evaluate(`(() => {
    const card = document.querySelector('.ash-native-config-editor');
    const rows = [...document.querySelectorAll('.ash-native-config-editor-row')];
    return {
      card: !!card,
      labels: rows.map((row) => row.querySelector('label')?.textContent?.trim()),
      values: rows.map((row) => row.querySelector('select')?.value),
      width: card?.getBoundingClientRect().width ?? 0,
      parentWidth: card?.parentElement?.getBoundingClientRect().width ?? 0,
    };
  })()`);
  check("native-policy-card-visible", state.card, JSON.stringify(state));
  check("three-policy-families", state.labels.length === 3, state.labels.join(", "));
  check("global-defaults-selected", state.values.every((value) => value === "global"), state.values.join(", "));
  check("full-width-in-flow", state.width > 0 && state.width >= state.parentWidth - 2, `${state.width}/${state.parentWidth}`);
  await ctx.shot("canonical-native-policy");
  return { asserts };
}
