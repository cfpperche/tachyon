/**
 * SDD 467 — comparative canonical Agent Form dogfood for Claude and Codex.
 */
import fs from "node:fs";
import path from "node:path";

export async function run(ctx) {
  const asserts = [];
  const check = (id, ok, detail = "") => {
    asserts.push({ id, ok: Boolean(ok), detail });
    ctx.log(`${ok ? "ok  " : "FAIL"} ${id}${detail ? ` — ${detail}` : ""}`);
  };
  const profilePath = (name) => path.join(
    process.cwd(),
    ".tachyon",
    "dev-host",
    "workspace",
    ".tachyon",
    "agents",
    name,
    "agent.yml",
  );
  const openNewStudio = async () => {
    await ctx.command("Tachyon: New Agent Studio");
    await ctx.sleep(2200);
    return ctx.findWebviewFrame(`(() => {
      const command = document.querySelector('#ash-cmd');
      const name = document.querySelector('#ash-name');
      return command instanceof HTMLInputElement
        && name instanceof HTMLInputElement
        && command.value === ''
        && name.value === '';
    })()`);
  };
  const authorBase = async (studio, { command, name }) => studio.evaluate(({ command, name }) => {
    const setInput = (selector, value) => {
      const input = document.querySelector(selector);
      if (!(input instanceof HTMLInputElement)) return false;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    };
    return setInput("#ash-cmd", command) && setInput("#ash-name", name);
  }, { command, name });
  const save = async (studio) => studio.evaluate(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === "Save");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  });

  const claude = await openNewStudio();
  check("claude-new-opened", claude, "canonical Claude form");
  if (!claude) return { asserts };
  const claudeBase = await authorBase(claude, {
    command: "claude",
    name: "parity-audit-claude",
  });
  await ctx.sleep(400);
  const claudeFields = await claude.evaluate(() => ({
    model: !!document.querySelector("#ash-runtime-model"),
    effortTag: document.querySelector("#ash-runtime-effort")?.tagName,
    provider: !!document.querySelector("#ash-runtime-provider"),
    serviceTier: !!document.querySelector("#ash-runtime-service-tier"),
  }));
  check("claude-supported-fields", claudeBase
    && claudeFields.model
    && claudeFields.effortTag === "SELECT"
    && !claudeFields.provider
    && !claudeFields.serviceTier, JSON.stringify(claudeFields));
  const claudeFilled = await claude.evaluate(() => {
    const model = document.querySelector("#ash-runtime-model");
    const effort = document.querySelector("#ash-runtime-effort");
    const permissions = document.querySelector("#ash-native-config-permissions");
    if (!(model instanceof HTMLInputElement)
      || !(effort instanceof HTMLSelectElement)
      || !(permissions instanceof HTMLSelectElement)) return false;
    model.value = "claude-opus-5";
    model.dispatchEvent(new Event("input", { bubbles: true }));
    effort.value = "xhigh";
    effort.dispatchEvent(new Event("change", { bubbles: true }));
    permissions.value = "workspace";
    permissions.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
  const claudeSaved = await save(claude);
  await ctx.sleep(1200);
  const claudeYamlPath = profilePath("parity-audit-claude");
  const claudeYaml = fs.existsSync(claudeYamlPath) ? fs.readFileSync(claudeYamlPath, "utf8") : "";
  check("claude-profile-created", claudeFilled && claudeSaved && claudeYaml.length > 0, claudeYamlPath);
  check("claude-profile-policy", claudeYaml.includes("adapter: claude")
    && claudeYaml.includes("model: claude-opus-5")
    && claudeYaml.includes("reasoningEffort: xhigh")
    && /permissions:[\s\S]*source: workspace/.test(claudeYaml)
    && claudeYaml.includes("- fork"));
  const claudeRoundTrip = await claude.evaluate(() => ({
    model: document.querySelector("#ash-runtime-model")?.value,
    effort: document.querySelector("#ash-runtime-effort")?.value,
    ready: document.body?.innerText.includes("Ready"),
  }));
  check("claude-round-trip", claudeRoundTrip.model === "claude-opus-5"
    && claudeRoundTrip.effort === "xhigh"
    && claudeRoundTrip.ready, JSON.stringify(claudeRoundTrip));

  await ctx.workbench.keyboard.down("Control");
  await ctx.workbench.keyboard.press("KeyW");
  await ctx.workbench.keyboard.up("Control");
  await ctx.sleep(800);
  const codex = await openNewStudio();
  check("codex-new-opened", codex, "canonical Codex form");
  if (!codex) return { asserts };
  const codexBase = await authorBase(codex, {
    command: "codex",
    name: "parity-audit-codex",
  });
  await ctx.sleep(400);
  const codexFields = await codex.evaluate(() => ({
    model: !!document.querySelector("#ash-runtime-model"),
    effortTag: document.querySelector("#ash-runtime-effort")?.tagName,
    provider: !!document.querySelector("#ash-runtime-provider"),
    serviceTier: !!document.querySelector("#ash-runtime-service-tier"),
  }));
  check("codex-supported-fields", codexBase
    && codexFields.model
    && codexFields.effortTag === "INPUT"
    && codexFields.provider
    && codexFields.serviceTier, JSON.stringify(codexFields));
  const codexFilled = await codex.evaluate(() => {
    const values = {
      "#ash-runtime-model": "gpt-5.6",
      "#ash-runtime-effort": "xhigh",
      "#ash-runtime-provider": "openai",
      "#ash-runtime-service-tier": "priority",
    };
    for (const [selector, value] of Object.entries(values)) {
      const input = document.querySelector(selector);
      if (!(input instanceof HTMLInputElement)) return false;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const permissions = document.querySelector("#ash-native-config-permissions");
    if (!(permissions instanceof HTMLSelectElement)) return false;
    permissions.value = "workspace";
    permissions.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
  const codexSaved = await save(codex);
  await ctx.sleep(1200);
  const codexYamlPath = profilePath("parity-audit-codex");
  const codexYaml = fs.existsSync(codexYamlPath) ? fs.readFileSync(codexYamlPath, "utf8") : "";
  check("codex-profile-created", codexFilled && codexSaved && codexYaml.length > 0, codexYamlPath);
  check("codex-profile-policy", codexYaml.includes("adapter: codex")
    && codexYaml.includes("model: gpt-5.6")
    && codexYaml.includes("provider: openai")
    && codexYaml.includes("reasoningEffort: xhigh")
    && codexYaml.includes("serviceTier: priority")
    && /permissions:[\s\S]*source: workspace/.test(codexYaml)
    && !codexYaml.includes("- fork"));
  const codexRoundTrip = await codex.evaluate(() => ({
    model: document.querySelector("#ash-runtime-model")?.value,
    effort: document.querySelector("#ash-runtime-effort")?.value,
    provider: document.querySelector("#ash-runtime-provider")?.value,
    serviceTier: document.querySelector("#ash-runtime-service-tier")?.value,
    limited: document.body?.innerText.includes("Limited"),
    nativeForkUnavailable: document.body?.innerText.includes("Native session fork is unavailable for this runtime."),
  }));
  check("codex-round-trip", codexRoundTrip.model === "gpt-5.6"
    && codexRoundTrip.effort === "xhigh"
    && codexRoundTrip.provider === "openai"
    && codexRoundTrip.serviceTier === "priority"
    && codexRoundTrip.limited
    && codexRoundTrip.nativeForkUnavailable, JSON.stringify(codexRoundTrip));

  await ctx.shot("claude-codex-parity-audit");
  return { asserts };
}
