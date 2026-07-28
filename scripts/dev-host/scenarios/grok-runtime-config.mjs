/**
 * SDD 481 — Runtime Config Grok visual/functional dogfood.
 *
 * The headless counterpart (`npm run dogfood:grok-runtime-config`) proves the adapter against the
 * installed binary. This one proves the surface a person actually uses: that Grok is selectable,
 * that its three documents render, that no payload reaches the DOM, that folder trust is read-only
 * and that a save lands in the disposable profile home rather than the tracked fixture.
 */
import fs from "node:fs";
import path from "node:path";

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
  check("control-open", !!control);
  if (!control) {
    await ctx.shot("no-control");
    return { asserts };
  }

  const opened = await control.evaluate(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim().includes("Runtime Config"));
    button?.click();
    return !!button;
  });
  check("runtime-config-route", opened);
  await ctx.sleep(2500);

  const selected = await control.evaluate(() => {
    const trigger = document.querySelector('[data-testid="runtime-config-runtime-trigger"]');
    if (!(trigger instanceof HTMLElement)) return false;
    trigger.click();
    return true;
  });
  await ctx.sleep(600);
  const picked = await control.evaluate(() => {
    const option = document.querySelector('[data-testid="runtime-config-runtime-grok"]');
    if (!(option instanceof HTMLElement)) return false;
    option.click();
    return true;
  });
  check("grok-selector", selected && picked);
  await ctx.sleep(1500);

  const globalState = await control.evaluate(() => {
    const body = document.body?.innerText ?? "";
    return {
      documents: ["Global config", "Workspace config", "Folder trust"].filter((label) => body.includes(label)),
      hasMeasuredScalar: body.includes("Default model") || body.includes("models.default"),
      hasAuthorityNote: body.includes("Permission mode"),
      hasImpact: !!document.querySelector('[data-testid="runtime-config-impact"]'),
      impact: document.querySelector('[data-testid="runtime-config-impact"]')?.textContent ?? "",
      leakedPayload: body.includes("fixture-never-render-"),
    };
  });
  check("three-documents", globalState.documents.length === 3, globalState.documents.join(", "));
  check("measured-settings", globalState.hasMeasuredScalar);
  check("authority-visible", globalState.hasAuthorityNote);
  check("global-impact-stated", globalState.hasImpact && globalState.impact.includes("private GROK_HOME"), globalState.impact);

  const openedWorkspace = await control.evaluate(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim().includes("Workspace config"));
    button?.click();
    return !!button;
  });
  await ctx.sleep(600);
  const workspaceState = await control.evaluate(() => {
    const body = document.body?.innerText ?? "";
    return {
      impact: document.querySelector('[data-testid="runtime-config-impact"]')?.textContent ?? "",
      hasMcp: body.includes("fixture_repo_tools"),
      leakedPayload: body.includes("fixture-never-render-"),
    };
  });
  check("workspace-mcp-only", openedWorkspace && workspaceState.hasMcp && workspaceState.impact.includes("Only [mcp_servers]"), workspaceState.impact);

  const openedTrust = await control.evaluate(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim().includes("Folder trust"));
    button?.click();
    return !!button;
  });
  await ctx.sleep(600);
  const trustState = await control.evaluate(() => ({
    readOnly: !!document.querySelector('[data-testid="runtime-config-read-only"]'),
    body: document.body?.innerText ?? "",
  }));
  check("trust-read-only", openedTrust && trustState.readOnly && trustState.body.includes("Not decided"));
  check("no-sensitive-payload", !globalState.leakedPayload && !workspaceState.leakedPayload && !trustState.body.includes("fixture-never-render-"));

  const reopenedGlobal = await control.evaluate(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim().includes("Global config"));
    button?.click();
    return !!button;
  });
  await ctx.sleep(400);
  const edited = await control.evaluate(() => {
    const label = [...document.querySelectorAll("label")]
      .find((candidate) => candidate.textContent?.trim().startsWith("Reasoning display width"));
    const input = label?.parentElement?.querySelector("input");
    if (!(input instanceof HTMLInputElement)) return false;
    input.value = "140";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  });
  await ctx.sleep(300);
  const saved = await control.evaluate(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim() === "Save changes");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return false;
    button.click();
    return true;
  });
  await ctx.sleep(900);
  const disposableGlobal = path.join(process.cwd(), ".tachyon", "dev-host", "profile-home", ".grok", "config.toml");
  const trackedGlobal = path.join(process.cwd(), "test", "fixtures", "runtime-config-prototype-dogfood", ".runtime-config-global-home", ".grok", "config.toml");
  const written = fs.existsSync(disposableGlobal) ? fs.readFileSync(disposableGlobal, "utf8") : "";
  check("safe-global-save", reopenedGlobal && edited && saved && written.includes("max_thoughts_width = 140"));
  check("unknown-keys-preserved", written.includes('must_survive = "yes"') && written.includes('api_key = "fixture-never-render-model-key"'));
  check("fixture-not-mutated", fs.readFileSync(trackedGlobal, "utf8").includes("max_thoughts_width = 120"));
  await ctx.shot("grok-runtime-config");
  return { asserts };
}
