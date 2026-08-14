import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { modelFacingScreenshotResult } from "../../companion/screenshotPersist.js";
import { envelopeFromTabResult } from "../../companion/tabEnvelope.js";
import { appendMutationLog, evaluateMutationSafety } from "../../companion/tabSafety.js";
import { fail, ok } from "./shared.js";
import type { BridgeDeps } from "./shared.js";

export function registerUserBrowserTools(mcp: McpServer, deps: BridgeDeps): void {

  // SDD 414 + SDD 420 — Companion browser tools (tabId-scoped; tabTools settings opt-in).
  // t-7aef5a — disambiguate from ide_browser_* (VS Code Integrated Browser) in every tool blurb.
  const USER_BROWSER_SCOPE =
    "[Companion human browser — paired device session; NOT VS Code Integrated Browser (ide_browser_*) and NOT agent-browser] ";
  const companionNotPairedMessage =
    "Companion tab tools are enabled in settings (settings.companion.tabTools), but no browser is paired " +
    "to this engine. Open Tachyon Companion, pair this engine (same Base URL as the Bridge), enable " +
    "Agent tab access, then retry.";

  const companionAllowedHosts = (): string[] | undefined =>
    deps.companionAllowedHosts?.() ?? undefined;

  const gateMutation = (input: {
    tool: string;
    tabId?: string;
    url?: string;
    selector?: string;
    ref?: string;
    text?: string;
    submit?: boolean;
    confirmed?: boolean;
  }): { ok: true } | { ok: false; env: string } => {
    const hints =
      input.tabId && input.ref && deps.companionRefHints
        ? deps.companionRefHints(input.tabId, input.ref)
        : undefined;
    const decision = evaluateMutationSafety({
      tool: input.tool,
      url: input.url,
      selector: input.selector ?? hints?.selector,
      ref: input.ref,
      text: input.text,
      submit: input.submit,
      name: hints?.name,
      href: hints?.href,
      elementText: hints?.elementText,
      allowedHosts: companionAllowedHosts(),
      confirmed: input.confirmed,
    });
    if (decision.allow) return { ok: true };
    const env = envelopeFromTabResult({
      tool: input.tool,
      tabId: input.tabId,
      raw: {
        ok: false,
        id: "safety",
        code: decision.code,
        message: decision.message,
        tabId: input.tabId,
      },
    });
    appendMutationLog(deps.workspaceRoot, {
      at: new Date().toISOString(),
      tool: input.tool,
      tabId: input.tabId,
      status: env.status,
      code: decision.code,
      detail: decision.message,
    });
    return { ok: false, env: JSON.stringify(env, null, 2) };
  };


  const tabIdSchema = z
    .string()
    .min(1)
    .max(128)
    .describe("Opaque companion tabId from user_browser_tabs_list (required — no active-tab default)");
  const documentTokenSchema = z
    .string()
    .min(1)
    .max(256)
    .optional()
    .describe("Optional document token from last snapshot; mismatch fails stale_tab");
  const refSchema = z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Element ref from snapshot (e.g. @e3) — preferred over selector");
  const selectorSchema = z
    .string()
    .min(1)
    .max(500)
    .optional()
    .describe("CSS selector fallback when no ref (fragile)");
  const tabTimeoutSchema = z
    .number()
    .int()
    .min(5)
    .max(120)
    .optional()
    .describe("How long to wait for Companion (default 30s)");

  if (deps.companionTabToolsEnabled?.()) {
    mcp.registerTool(
      "user_browser_tabs_list",
      {
        description:
          USER_BROWSER_SCOPE +
          "List the human's browser tabs. Returns opaque tabId handles, title, url, " +
          "active flag, and documentToken. Use tabId on every other user_browser_* call (SDD 420).",
        inputSchema: { timeoutSec: tabTimeoutSchema },
      },
      async ({ timeoutSec }) => {
        try {
          if (!deps.companionTabTabsList) {
            return fail(new Error("user_browser_tabs_list is not available."));
          }
          if (!deps.companionBrowserPaired?.()) {
            return fail(new Error(companionNotPairedMessage));
          }
          const result = await deps.companionTabTabsList({
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          return ok(
            JSON.stringify(
              envelopeFromTabResult({ tool: "user_browser_tabs_list", raw: result }),
              null,
              2,
            ),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_snapshot",
      {
        description:
          USER_BROWSER_SCOPE +
          "DOM outline of a specific companion tabId. Returns outline, stable @e refs, documentToken. SDD 420.",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, timeoutSec }) => {
        try {
          if (!deps.companionTabSnapshot) {
            return fail(new Error("user_browser_snapshot is not available."));
          }
          if (!deps.companionBrowserPaired?.()) {
            return fail(new Error(companionNotPairedMessage));
          }
          const result = await deps.companionTabSnapshot({
            tabId,
            expectedDocumentToken,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          // Workspace caches refs; optional double-cache via companionRefHints owner is enough.
          return ok(
            JSON.stringify(
              envelopeFromTabResult({ tool: "user_browser_snapshot", tabId, raw: result }),
              null,
              2,
            ),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_click",
      {
        description:
          USER_BROWSER_SCOPE +
          "Click an element on companion tabId. Prefer ref from snapshot (@eN); selector is fragile fallback.",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          ref: refSchema,
          selector: selectorSchema,
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, ref, selector, timeoutSec }) => {
        try {
          if (!deps.companionTabAct) {
            return fail(new Error("user_browser_click is not available."));
          }
          if (!deps.companionBrowserPaired?.()) {
            return fail(new Error(companionNotPairedMessage));
          }
          const gated = gateMutation({
            tool: "user_browser_click",
            tabId,
            selector,
            ref,
          });
          if (!gated.ok) return ok(gated.env);
          const result = await deps.companionTabAct({
            kind: "click",
            tabId,
            expectedDocumentToken,
            ref,
            selector,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          appendMutationLog(deps.workspaceRoot, {
            at: new Date().toISOString(),
            tool: "user_browser_click",
            tabId,
            status: "applied",
            detail: typeof ref === "string" ? ref : selector,
          });
          return ok(
            JSON.stringify(
              envelopeFromTabResult({ tool: "user_browser_click", tabId, raw: result }),
              null,
              2,
            ),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_type",
      {
        description:
          USER_BROWSER_SCOPE +
          "Type into an element on companion tabId (focus + insert, optional Enter). Prefer ref from snapshot.",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          ref: refSchema,
          selector: selectorSchema,
          text: z.string().max(4000).describe("Text to type"),
          submit: z.boolean().optional().describe("If true, press Enter after typing"),
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, ref, selector, text, submit, timeoutSec }) => {
        try {
          if (!deps.companionTabAct) {
            return fail(new Error("user_browser_type is not available."));
          }
          if (!deps.companionBrowserPaired?.()) {
            return fail(new Error(companionNotPairedMessage));
          }
          const gated = gateMutation({
            tool: "user_browser_type",
            tabId,
            selector,
            ref,
            text,
            submit,
          });
          if (!gated.ok) return ok(gated.env);
          const result = await deps.companionTabAct({
            kind: "type",
            tabId,
            expectedDocumentToken,
            ref,
            selector,
            text,
            submit,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          appendMutationLog(deps.workspaceRoot, {
            at: new Date().toISOString(),
            tool: "user_browser_type",
            tabId,
            status: "applied",
          });
          return ok(
            JSON.stringify(
              envelopeFromTabResult({ tool: "user_browser_type", tabId, raw: result }),
              null,
              2,
            ),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_fill",
      {
        description:
          USER_BROWSER_SCOPE +
          "Set value of input/textarea/select on companion tabId. Password fields refused.",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          ref: refSchema,
          selector: selectorSchema,
          value: z.string().max(4000).describe("New value"),
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, ref, selector, value, timeoutSec }) => {
        try {
          if (!deps.companionTabAct) {
            return fail(new Error("user_browser_fill is not available."));
          }
          if (!deps.companionBrowserPaired?.()) {
            return fail(new Error(companionNotPairedMessage));
          }
          const gated = gateMutation({
            tool: "user_browser_fill",
            tabId,
            selector,
            ref,
            text: value,
          });
          if (!gated.ok) return ok(gated.env);
          const result = await deps.companionTabAct({
            kind: "fill",
            tabId,
            expectedDocumentToken,
            ref,
            selector,
            value,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          appendMutationLog(deps.workspaceRoot, {
            at: new Date().toISOString(),
            tool: "user_browser_fill",
            tabId,
            status: "applied",
          });
          return ok(
            JSON.stringify(
              envelopeFromTabResult({ tool: "user_browser_fill", tabId, raw: result }),
              null,
              2,
            ),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_screenshot",
      {
        description:
          USER_BROWSER_SCOPE +
          "Screenshot companion tabId (viewport, full page, or element). Saves under .tachyon/companion/screenshots/.",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          format: z.enum(["jpeg", "png"]).optional().describe("Image format (default jpeg)"),
          quality: z.number().min(10).max(100).optional().describe("JPEG quality 10–100 (default 70)"),
          scope: z
            .enum(["viewport", "full_page", "element"])
            .optional()
            .describe("viewport (default), full_page, or element (needs ref/selector)"),
          ref: refSchema,
          selector: selectorSchema,
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, format, quality, scope, ref, selector, timeoutSec }) => {
        try {
          if (!deps.companionTabScreenshot) {
            return fail(new Error("user_browser_screenshot is not available."));
          }
          if (!deps.companionBrowserPaired?.()) {
            return fail(new Error(companionNotPairedMessage));
          }
          if (scope === "element" && !ref?.trim() && !selector?.trim()) {
            return fail(new Error("scope=element requires ref or selector"));
          }
          const result = await deps.companionTabScreenshot({
            tabId,
            expectedDocumentToken,
            format,
            quality,
            scope,
            ref,
            selector,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          const facing = modelFacingScreenshotResult(result, deps.workspaceRoot);
          if (facing.kind === "persist_failed") {
            return fail(new Error(`Screenshot captured but failed to save: ${facing.reason}`));
          }
          const rid =
            typeof (result as { id?: string })?.id === "string"
              ? (result as { id: string }).id
              : "shot";
          const payload =
            facing.payload && typeof facing.payload === "object"
              ? (facing.payload as Record<string, unknown>)
              : {};
          return ok(
            JSON.stringify(
              envelopeFromTabResult({
                tool: "user_browser_screenshot",
                tabId,
                raw: { ok: true, id: rid, kind: "screenshot", ...payload },
              }),
              null,
              2,
            ),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_eval",
      {
        description:
          USER_BROWSER_SCOPE +
          "Evaluate a short JS expression in the MAIN world of companion tabId.",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          expression: z.string().min(1).max(4000).describe("JS expression"),
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, expression, timeoutSec }) => {
        try {
          if (!deps.companionTabEval) {
            return fail(new Error("user_browser_eval is not available."));
          }
          if (!deps.companionBrowserPaired?.()) {
            return fail(new Error(companionNotPairedMessage));
          }
          const result = await deps.companionTabEval({
            tabId,
            expectedDocumentToken,
            expression,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          return ok(
            JSON.stringify(
              envelopeFromTabResult({ tool: "user_browser_eval", tabId, raw: result }),
              null,
              2,
            ),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_console",
      {
        description: USER_BROWSER_SCOPE +
          "Read recent console.* lines from companion tabId.",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          limit: z.number().int().min(1).max(100).optional().describe("Max lines (default 30)"),
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, limit, timeoutSec }) => {
        try {
          if (!deps.companionTabConsole) {
            return fail(new Error("user_browser_console is not available."));
          }
          if (!deps.companionBrowserPaired?.()) {
            return fail(new Error(companionNotPairedMessage));
          }
          const result = await deps.companionTabConsole({
            tabId,
            expectedDocumentToken,
            limit,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          return ok(
            JSON.stringify(
              envelopeFromTabResult({ tool: "user_browser_console", tabId, raw: result }),
              null,
              2,
            ),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_navigate",
      {
        description: USER_BROWSER_SCOPE +
          "Navigate companion tabId: goto URL, back, forward, or reload.",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          action: z.enum(["goto", "back", "forward", "reload"]),
          url: z.string().url().optional().describe("Required when action=goto"),
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, action, url, timeoutSec }) => {
        try {
          if (!deps.companionTabNavigate) return fail(new Error("user_browser_navigate unavailable"));
          if (!deps.companionBrowserPaired?.()) return fail(new Error(companionNotPairedMessage));
          if (action === "goto" && !url) return fail(new Error("url required for action=goto"));
          const gated = gateMutation({
            tool: "user_browser_navigate",
            tabId,
            url: action === "goto" ? url : undefined,
          });
          if (!gated.ok) return ok(gated.env);
          const result = await deps.companionTabNavigate({
            tabId,
            expectedDocumentToken,
            action,
            url,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          appendMutationLog(deps.workspaceRoot, {
            at: new Date().toISOString(),
            tool: "user_browser_navigate",
            tabId,
            url,
            status: "applied",
            detail: action,
          });
          return ok(JSON.stringify(envelopeFromTabResult({ tool: "user_browser_navigate", tabId, raw: result }), null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_scroll",
      {
        description: USER_BROWSER_SCOPE +
          "Scroll companion tabId by direction/pixels or until element ref/selector.",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          direction: z.enum(["up", "down", "left", "right"]).optional(),
          pixels: z.number().int().min(1).max(50_000).optional(),
          ref: refSchema,
          selector: selectorSchema,
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, direction, pixels, ref, selector, timeoutSec }) => {
        try {
          if (!deps.companionTabScroll) return fail(new Error("user_browser_scroll unavailable"));
          if (!deps.companionBrowserPaired?.()) return fail(new Error(companionNotPairedMessage));
          const result = await deps.companionTabScroll({
            tabId,
            expectedDocumentToken,
            direction,
            pixels,
            ref,
            selector,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          return ok(JSON.stringify(envelopeFromTabResult({ tool: "user_browser_scroll", tabId, raw: result }), null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_press_key",
      {
        description: USER_BROWSER_SCOPE +
          "Press a key or chord on companion tabId (optional focused ref).",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          key: z.string().min(1).max(32).describe("Key name e.g. Enter, Escape, a"),
          modifiers: z.array(z.string()).optional(),
          ref: refSchema,
          selector: selectorSchema,
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, key, modifiers, ref, selector, timeoutSec }) => {
        try {
          if (!deps.companionTabPressKey) return fail(new Error("user_browser_press_key unavailable"));
          if (!deps.companionBrowserPaired?.()) return fail(new Error(companionNotPairedMessage));
          const gated = gateMutation({
            tool: "user_browser_press_key",
            tabId,
            selector,
            ref,
            text: key,
          });
          if (!gated.ok) return ok(gated.env);
          const result = await deps.companionTabPressKey({
            tabId,
            expectedDocumentToken,
            key,
            modifiers,
            ref,
            selector,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          appendMutationLog(deps.workspaceRoot, {
            at: new Date().toISOString(),
            tool: "user_browser_press_key",
            tabId,
            status: "applied",
            detail: key,
          });
          return ok(JSON.stringify(envelopeFromTabResult({ tool: "user_browser_press_key", tabId, raw: result }), null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_wait_for",
      {
        description: USER_BROWSER_SCOPE +
          "Wait on companion tabId for element, text, navigation, or load (bounded).",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          what: z.enum(["element", "text", "navigation", "load"]),
          ref: refSchema,
          selector: selectorSchema,
          text: z.string().max(500).optional(),
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, what, ref, selector, text, timeoutSec }) => {
        try {
          if (!deps.companionTabWaitFor) return fail(new Error("user_browser_wait_for unavailable"));
          if (!deps.companionBrowserPaired?.()) return fail(new Error(companionNotPairedMessage));
          const result = await deps.companionTabWaitFor({
            tabId,
            expectedDocumentToken,
            what,
            ref,
            selector,
            text,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          return ok(JSON.stringify(envelopeFromTabResult({ tool: "user_browser_wait_for", tabId, raw: result }), null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_tab_open",
      {
        description: USER_BROWSER_SCOPE +
          "Open a new browser tab (optional URL). Returns new opaque tabId.",
        inputSchema: {
          url: z.string().url().optional(),
          active: z.boolean().optional(),
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ url, active, timeoutSec }) => {
        try {
          if (!deps.companionTabOpen) return fail(new Error("user_browser_tab_open unavailable"));
          if (!deps.companionBrowserPaired?.()) return fail(new Error(companionNotPairedMessage));
          const gated = gateMutation({
            tool: "user_browser_tab_open",
            url,
          });
          if (!gated.ok) return ok(gated.env);
          const result = await deps.companionTabOpen({
            url,
            active,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          appendMutationLog(deps.workspaceRoot, {
            at: new Date().toISOString(),
            tool: "user_browser_tab_open",
            url,
            status: "applied",
          });
          return ok(JSON.stringify(envelopeFromTabResult({ tool: "user_browser_tab_open", raw: result }), null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_tab_activate",
      {
        description: USER_BROWSER_SCOPE +
          "Focus/activate companion tabId in the browser.",
        inputSchema: { tabId: tabIdSchema, timeoutSec: tabTimeoutSchema },
      },
      async ({ tabId, timeoutSec }) => {
        try {
          if (!deps.companionTabActivate) return fail(new Error("user_browser_tab_activate unavailable"));
          if (!deps.companionBrowserPaired?.()) return fail(new Error(companionNotPairedMessage));
          const result = await deps.companionTabActivate({
            tabId,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          return ok(JSON.stringify(envelopeFromTabResult({ tool: "user_browser_tab_activate", tabId, raw: result }), null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_tab_close",
      {
        description: USER_BROWSER_SCOPE +
          "Close companion tabId.",
        inputSchema: { tabId: tabIdSchema, timeoutSec: tabTimeoutSchema },
      },
      async ({ tabId, timeoutSec }) => {
        try {
          if (!deps.companionTabClose) return fail(new Error("user_browser_tab_close unavailable"));
          if (!deps.companionBrowserPaired?.()) return fail(new Error(companionNotPairedMessage));
          const result = await deps.companionTabClose({
            tabId,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          appendMutationLog(deps.workspaceRoot, {
            at: new Date().toISOString(),
            tool: "user_browser_tab_close",
            tabId,
            status: "applied",
          });
          return ok(JSON.stringify(envelopeFromTabResult({ tool: "user_browser_tab_close", tabId, raw: result }), null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    // ---- SDD 420 P1 ----
    mcp.registerTool(
      "user_browser_get",
      {
        description:
          USER_BROWSER_SCOPE +
          "Directed read on companion tabId element (prefer ref): text, html, value, attribute, or state. Never returns password values or secret-like attributes.",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          what: z.enum(["text", "html", "value", "attribute", "state"]),
          attribute: z.string().min(1).max(128).optional().describe("Required when what=attribute"),
          ref: refSchema,
          selector: selectorSchema,
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, what, attribute, ref, selector, timeoutSec }) => {
        try {
          if (!deps.companionTabGet) return fail(new Error("user_browser_get unavailable"));
          if (!deps.companionBrowserPaired?.()) return fail(new Error(companionNotPairedMessage));
          if (what === "attribute" && !attribute?.trim()) {
            return fail(new Error("attribute name required when what=attribute"));
          }
          const result = await deps.companionTabGet({
            tabId,
            expectedDocumentToken,
            what,
            attribute,
            ref,
            selector,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          return ok(JSON.stringify(envelopeFromTabResult({ tool: "user_browser_get", tabId, raw: result }), null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_find",
      {
        description: USER_BROWSER_SCOPE +
          "Find visible text on companion tabId; returns matching nodes (ref when stamped).",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          text: z.string().min(1).max(500),
          limit: z.number().int().min(1).max(50).optional(),
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, text, limit, timeoutSec }) => {
        try {
          if (!deps.companionTabFind) return fail(new Error("user_browser_find unavailable"));
          if (!deps.companionBrowserPaired?.()) return fail(new Error(companionNotPairedMessage));
          const result = await deps.companionTabFind({
            tabId,
            expectedDocumentToken,
            text,
            limit,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          return ok(JSON.stringify(envelopeFromTabResult({ tool: "user_browser_find", tabId, raw: result }), null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_hover",
      {
        description: USER_BROWSER_SCOPE +
          "Hover an element on companion tabId (prefer ref).",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          ref: refSchema,
          selector: selectorSchema,
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, ref, selector, timeoutSec }) => {
        try {
          if (!deps.companionTabHover) return fail(new Error("user_browser_hover unavailable"));
          if (!deps.companionBrowserPaired?.()) return fail(new Error(companionNotPairedMessage));
          const result = await deps.companionTabHover({
            tabId,
            expectedDocumentToken,
            ref,
            selector,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          return ok(JSON.stringify(envelopeFromTabResult({ tool: "user_browser_hover", tabId, raw: result }), null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_select_option",
      {
        description: USER_BROWSER_SCOPE +
          "Select an option in a <select> on companion tabId (by value, label, or index).",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          ref: refSchema,
          selector: selectorSchema,
          value: z.string().max(500).optional(),
          label: z.string().max(500).optional(),
          index: z.number().int().min(0).max(10_000).optional(),
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, ref, selector, value, label, index, timeoutSec }) => {
        try {
          if (!deps.companionTabSelectOption) return fail(new Error("user_browser_select_option unavailable"));
          if (!deps.companionBrowserPaired?.()) return fail(new Error(companionNotPairedMessage));
          if (value === undefined && label === undefined && index === undefined) {
            return fail(new Error("Provide value, label, or index"));
          }
          const result = await deps.companionTabSelectOption({
            tabId,
            expectedDocumentToken,
            ref,
            selector,
            value,
            label,
            index,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          appendMutationLog(deps.workspaceRoot, {
            at: new Date().toISOString(),
            tool: "user_browser_select_option",
            tabId,
            status: "applied",
            detail: value ?? label ?? String(index),
          });
          return ok(
            JSON.stringify(envelopeFromTabResult({ tool: "user_browser_select_option", tabId, raw: result }), null, 2),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_check",
      {
        description: USER_BROWSER_SCOPE +
          "Check or uncheck a checkbox/radio on companion tabId.",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          ref: refSchema,
          selector: selectorSchema,
          checked: z.boolean(),
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, ref, selector, checked, timeoutSec }) => {
        try {
          if (!deps.companionTabCheck) return fail(new Error("user_browser_check unavailable"));
          if (!deps.companionBrowserPaired?.()) return fail(new Error(companionNotPairedMessage));
          const result = await deps.companionTabCheck({
            tabId,
            expectedDocumentToken,
            ref,
            selector,
            checked,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          appendMutationLog(deps.workspaceRoot, {
            at: new Date().toISOString(),
            tool: "user_browser_check",
            tabId,
            status: "applied",
            detail: checked ? "checked" : "unchecked",
          });
          return ok(JSON.stringify(envelopeFromTabResult({ tool: "user_browser_check", tabId, raw: result }), null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    // ---- SDD 420 P1 residual ----
    mcp.registerTool(
      "user_browser_drag",
      {
        description: USER_BROWSER_SCOPE +
          "Drag from source element to target on companion tabId (prefer @e refs).",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          sourceRef: refSchema,
          sourceSelector: selectorSchema,
          targetRef: refSchema,
          targetSelector: selectorSchema,
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, sourceRef, sourceSelector, targetRef, targetSelector, timeoutSec }) => {
        try {
          if (!deps.companionTabDrag) return fail(new Error("user_browser_drag unavailable"));
          if (!deps.companionBrowserPaired?.()) return fail(new Error(companionNotPairedMessage));
          if (!sourceRef?.trim() && !sourceSelector?.trim()) {
            return fail(new Error("sourceRef or sourceSelector required"));
          }
          if (!targetRef?.trim() && !targetSelector?.trim()) {
            return fail(new Error("targetRef or targetSelector required"));
          }
          const result = await deps.companionTabDrag({
            tabId,
            expectedDocumentToken,
            sourceRef,
            sourceSelector,
            targetRef,
            targetSelector,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          appendMutationLog(deps.workspaceRoot, {
            at: new Date().toISOString(),
            tool: "user_browser_drag",
            tabId,
            status: "applied",
          });
          return ok(JSON.stringify(envelopeFromTabResult({ tool: "user_browser_drag", tabId, raw: result }), null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_upload",
      {
        description:
          USER_BROWSER_SCOPE +
          "Upload workspace file(s) into an <input type=file> on companion tabId. Paths are relative to workspace root (or absolute under it).",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          ref: refSchema,
          selector: selectorSchema,
          paths: z
            .array(z.string().min(1).max(500))
            .min(1)
            .max(5)
            .describe("Workspace-relative file paths to attach"),
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, ref, selector, paths, timeoutSec }) => {
        try {
          if (!deps.companionTabUpload) return fail(new Error("user_browser_upload unavailable"));
          if (!deps.companionBrowserPaired?.()) return fail(new Error(companionNotPairedMessage));
          const root = path.resolve(deps.workspaceRoot);
          const files: Array<{ name: string; mimeType: string; base64: string }> = [];
          for (const p of paths) {
            const abs = path.resolve(root, p);
            if (!abs.startsWith(root + path.sep) && abs !== root) {
              return fail(new Error(`Path escapes workspace: ${p}`));
            }
            if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
              return fail(new Error(`Not a file: ${p}`));
            }
            const st = fs.statSync(abs);
            if (st.size > 5 * 1024 * 1024) {
              return fail(new Error(`File too large (>5MB): ${p}`));
            }
            const buf = fs.readFileSync(abs);
            const ext = path.extname(abs).toLowerCase();
            const mime =
              ext === ".png"
                ? "image/png"
                : ext === ".jpg" || ext === ".jpeg"
                  ? "image/jpeg"
                  : ext === ".pdf"
                    ? "application/pdf"
                    : ext === ".txt" || ext === ".md"
                      ? "text/plain"
                      : ext === ".json"
                        ? "application/json"
                        : "application/octet-stream";
            files.push({ name: path.basename(abs), mimeType: mime, base64: buf.toString("base64") });
          }
          const result = await deps.companionTabUpload({
            tabId,
            expectedDocumentToken,
            ref,
            selector,
            files,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          appendMutationLog(deps.workspaceRoot, {
            at: new Date().toISOString(),
            tool: "user_browser_upload",
            tabId,
            status: "applied",
            detail: paths.join(","),
          });
          return ok(JSON.stringify(envelopeFromTabResult({ tool: "user_browser_upload", tabId, raw: result }), null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_download",
      {
        description:
          USER_BROWSER_SCOPE +
          "Trigger a download on companion tabId (optional click on ref) and wait for chrome.downloads result. Requires human confirm class when gated as download.",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          ref: refSchema,
          selector: selectorSchema,
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, ref, selector, timeoutSec }) => {
        try {
          if (!deps.companionTabDownload) return fail(new Error("user_browser_download unavailable"));
          if (!deps.companionBrowserPaired?.()) return fail(new Error(companionNotPairedMessage));
          const gated = gateMutation({
            tool: "user_browser_download",
            tabId,
            selector: selector ?? "download",
            ref,
            text: "download",
          });
          if (!gated.ok) return ok(gated.env);
          const result = await deps.companionTabDownload({
            tabId,
            expectedDocumentToken,
            ref,
            selector,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          appendMutationLog(deps.workspaceRoot, {
            at: new Date().toISOString(),
            tool: "user_browser_download",
            tabId,
            status: "applied",
          });
          return ok(
            JSON.stringify(envelopeFromTabResult({ tool: "user_browser_download", tabId, raw: result }), null, 2),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_network",
      {
        description:
          USER_BROWSER_SCOPE +
          "Recent network requests for companion tabId (method, url, status). No cookies/Authorization bodies — redacted.",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          limit: z.number().int().min(1).max(100).optional(),
          urlContains: z.string().max(300).optional(),
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, limit, urlContains, timeoutSec }) => {
        try {
          if (!deps.companionTabNetwork) return fail(new Error("user_browser_network unavailable"));
          if (!deps.companionBrowserPaired?.()) return fail(new Error(companionNotPairedMessage));
          const result = await deps.companionTabNetwork({
            tabId,
            expectedDocumentToken,
            limit,
            urlContains,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          return ok(
            JSON.stringify(envelopeFromTabResult({ tool: "user_browser_network", tabId, raw: result }), null, 2),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_list_frames",
      {
        description: USER_BROWSER_SCOPE +
          "List frames/iframes for companion tabId (frameId, parent, url).",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, timeoutSec }) => {
        try {
          if (!deps.companionTabListFrames) return fail(new Error("user_browser_list_frames unavailable"));
          if (!deps.companionBrowserPaired?.()) return fail(new Error(companionNotPairedMessage));
          const result = await deps.companionTabListFrames({
            tabId,
            expectedDocumentToken,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          return ok(
            JSON.stringify(envelopeFromTabResult({ tool: "user_browser_list_frames", tabId, raw: result }), null, 2),
          );
        } catch (err) {
          return fail(err);
        }
      },
    );

    mcp.registerTool(
      "user_browser_dialog",
      {
        description:
          USER_BROWSER_SCOPE +
          "Read/accept/dismiss an open HTML <dialog> or role=dialog on companion tabId (native window.alert needs browser UI).",
        inputSchema: {
          tabId: tabIdSchema,
          expectedDocumentToken: documentTokenSchema,
          action: z.enum(["accept", "dismiss", "read"]),
          text: z.string().max(500).optional(),
          timeoutSec: tabTimeoutSchema,
        },
      },
      async ({ tabId, expectedDocumentToken, action, text, timeoutSec }) => {
        try {
          if (!deps.companionTabDialog) return fail(new Error("user_browser_dialog unavailable"));
          if (!deps.companionBrowserPaired?.()) return fail(new Error(companionNotPairedMessage));
          const result = await deps.companionTabDialog({
            tabId,
            expectedDocumentToken,
            action,
            text,
            timeoutMs: timeoutSec !== undefined ? timeoutSec * 1000 : undefined,
          });
          return ok(JSON.stringify(envelopeFromTabResult({ tool: "user_browser_dialog", tabId, raw: result }), null, 2));
        } catch (err) {
          return fail(err);
        }
      },
    );
  }
}
