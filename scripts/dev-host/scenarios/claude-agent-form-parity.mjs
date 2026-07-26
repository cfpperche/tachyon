/**
 * SDD 466 — canonical Claude Agent Form authoring, functional + visual dogfood.
 */
import fs from "node:fs";
import path from "node:path";

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
    await ctx.shot("claude-agent-form-missing");
    return { asserts };
  }

  const authored = await studio.evaluate(() => {
    const setInput = (selector, value) => {
      const input = document.querySelector(selector);
      if (!(input instanceof HTMLInputElement)) return false;
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    };
    const command = setInput("#ash-cmd", "claude");
    const name = setInput("#ash-name", "claude-form-dogfood");
    return { command, name };
  });
  await ctx.sleep(500);
  const surface = await studio.evaluate(() => ({
    selectors: !!document.querySelector("#ash-runtime-selectors-title"),
    model: !!document.querySelector("#ash-runtime-model"),
    effort: !!document.querySelector("#ash-runtime-effort"),
    provider: !!document.querySelector("#ash-runtime-provider"),
    serviceTier: !!document.querySelector("#ash-runtime-service-tier"),
    familyValues: [...document.querySelectorAll(".ash-native-config-editor-row select")]
      .map((select) => select.value),
  }));
  check("claude-selectors-visible", authored.command && surface.selectors && surface.model && surface.effort, JSON.stringify(surface));
  check("unsupported-selectors-hidden", !surface.provider && !surface.serviceTier);
  check("claude-global-defaults", surface.familyValues.length === 3 && surface.familyValues.every((value) => value === "global"), surface.familyValues.join(","));

  const filled = await studio.evaluate(() => {
    const model = document.querySelector("#ash-runtime-model");
    const effort = document.querySelector("#ash-runtime-effort");
    const permissions = document.querySelector("#ash-native-config-permissions");
    if (!(model instanceof HTMLInputElement) || !(effort instanceof HTMLSelectElement)
      || !(permissions instanceof HTMLSelectElement)) return false;
    model.value = "claude-opus-5";
    model.dispatchEvent(new Event("input", { bubbles: true }));
    effort.value = "xhigh";
    effort.dispatchEvent(new Event("change", { bubbles: true }));
    permissions.value = "workspace";
    permissions.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
  await ctx.sleep(300);
  const saved = await studio.evaluate(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === "Save");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  });
  await ctx.sleep(1200);

  const profilePath = path.join(
    process.cwd(),
    ".tachyon",
    "dev-host",
    "workspace",
    ".tachyon",
    "agents",
    "claude-form-dogfood",
    "agent.yml",
  );
  const profile = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, "utf8") : "";
  check("profile-created", filled && saved && profile.length > 0, profilePath);
  check("typed-selectors-authored", profile.includes("model: claude-opus-5")
    && profile.includes("reasoningEffort: xhigh")
    && profile.includes("selectors:")
    && profile.includes("- fork"));
  check("unsupported-selectors-absent", !profile.includes("provider:") && !profile.includes("serviceTier:"));
  check("workspace-permissions-authored", /permissions:[\s\S]*source: workspace/.test(profile));
  const roundTrip = await studio.evaluate(() => ({
    title: document.querySelector(".studio-title")?.textContent ?? document.body?.innerText.slice(0, 120),
    model: document.querySelector("#ash-runtime-model")?.value,
    effort: document.querySelector("#ash-runtime-effort")?.value,
    permissions: document.querySelector("#ash-native-config-permissions")?.value,
    readiness: document.body?.innerText.includes("Ready"),
    supported: [...document.querySelectorAll(".ash-native-config-row")]
      .filter((row) => row.textContent?.includes("Supported")).length,
  }));
  check("edit-round-trip", roundTrip.model === "claude-opus-5"
    && roundTrip.effort === "xhigh"
    && roundTrip.permissions === "workspace", JSON.stringify(roundTrip));
  check("readiness-and-support", roundTrip.readiness && roundTrip.supported >= 4, JSON.stringify(roundTrip));

  await ctx.shot("claude-agent-form-parity");
  return { asserts };
}
