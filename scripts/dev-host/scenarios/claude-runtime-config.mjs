/**
 * SDD 464 — Runtime Config Claude visual/functional dogfood.
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
    window.__tachyonRuntimeConfigMessages = [];
    window.addEventListener("message", (event) => {
      const type = event.data?.type;
      if (typeof type === "string") {
        window.__tachyonRuntimeConfigMessages.push({
          type,
          selectedWsHash: event.data?.model?.selectedWsHash,
          workspaceHashes: event.data?.model?.workspaces?.map((workspace) => workspace.hash),
        });
      }
    });
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim().includes("Runtime Config"));
    button?.click();
    return !!button;
  });
  check("runtime-config-route", opened);
  await ctx.sleep(2500);

  const selected = await control.evaluate(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim().includes("Anthropic Claude"));
    button?.click();
    return !!button;
  });
  check("claude-selector", selected);
  await ctx.sleep(1500);

  const settingsState = await control.evaluate(() => {
    const body = document.body?.innerText ?? "";
    return {
      documents: ["Global settings", "Workspace settings", "Workspace MCP"]
        .filter((label) => body.includes(label)),
      hasTheme: body.includes("Theme"),
      leakedPayload: body.includes("never-render-"),
      messages: window.__tachyonRuntimeConfigMessages ?? [],
    };
  });
  ctx.log(`runtime-config messages: ${JSON.stringify(settingsState.messages)}`);
  check("three-documents", settingsState.documents.length === 3, settingsState.documents.join(", "));
  check("measured-settings", settingsState.hasTheme);

  const openedMcp = await control.evaluate(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim().includes("Workspace MCP"));
    button?.click();
    return !!button;
  });
  await ctx.sleep(500);
  const mcpState = await control.evaluate(() => {
    const body = document.body?.innerText ?? "";
    return {
      hasReadOnly: body.includes("Read only"),
      leakedPayload: body.includes("never-render-"),
    };
  });
  check("mcp-read-only", openedMcp && mcpState.hasReadOnly);
  check("no-sensitive-payload", !settingsState.leakedPayload && !mcpState.leakedPayload);

  const reopenedGlobal = await control.evaluate(() => {
    const globalButton = [...document.querySelectorAll("button")]
      .find((candidate) => candidate.textContent?.trim().includes("Global settings"));
    globalButton?.click();
    return !!globalButton;
  });
  await ctx.sleep(300);
  const edited = await control.evaluate(() => {
    const themeLabel = [...document.querySelectorAll("label")]
      .find((candidate) => candidate.textContent?.trim().startsWith("Theme"));
    const input = themeLabel?.parentElement?.querySelector("input");
    if (!(input instanceof HTMLInputElement)) return false;
    input.value = "light";
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
  await ctx.sleep(700);
  const disposableGlobal = path.join(process.cwd(), ".tachyon", "dev-host", "profile-home", ".claude", "settings.json");
  const trackedGlobal = path.join(process.cwd(), "test", "fixtures", "runtime-config-prototype-dogfood", ".runtime-config-global-home", ".claude", "settings.json");
  check("safe-global-save", reopenedGlobal && edited && saved && fs.readFileSync(disposableGlobal, "utf8").includes("\"theme\": \"light\""));
  check("fixture-not-mutated", fs.readFileSync(trackedGlobal, "utf8").includes("\"theme\": \"dark\""));
  await ctx.shot("claude-runtime-config");
  return { asserts };
}
