/**
 * Pure Design Mode pick payload + prompt formatting (no CDP / no vscode).
 * Unit-tested; shell CDP path assembles the same shape from page capture.
 */

export type DesignModeBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type DesignModePickPayload = {
  url: string;
  tag: string;
  id: string;
  className: string;
  text: string;
  html: string;
  bounds: DesignModeBounds;
  styles: Record<string, string>;
  /** CSS-ish selector hint when available */
  selectorHint: string;
  capturedAt: string;
  /** Optional note typed by the human before send */
  note?: string;
  /** Absolute path to cropped PNG when capture succeeded */
  screenshotPath?: string;
};

/** Style keys included in every pick (subset — enough for layout/styling feedback). */
export const DESIGN_MODE_STYLE_KEYS = [
  "color",
  "backgroundColor",
  "fontSize",
  "fontWeight",
  "fontFamily",
  "display",
  "padding",
  "margin",
  "border",
  "borderRadius",
  "width",
  "height",
  "position",
  "flexDirection",
  "gap",
  "justifyContent",
  "alignItems",
] as const;

export type DesignModeStyleKey = (typeof DESIGN_MODE_STYLE_KEYS)[number];

/** Cap HTML included in the agent prompt. */
export const DESIGN_MODE_HTML_MAX = 4000;
export const DESIGN_MODE_TEXT_MAX = 240;

/**
 * Subset a full computed-style map to the design-mode allowlist.
 * Unknown keys dropped; empty string values kept (they are still information).
 */
export function subsetComputedStyles(
  styles: Record<string, string | undefined | null>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of DESIGN_MODE_STYLE_KEYS) {
    const v = styles[key];
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

/**
 * Build a stable-ish selector hint from tag/id/class (not guaranteed unique).
 */
export function selectorHintFromIdentity(input: {
  tag: string;
  id?: string;
  className?: string;
}): string {
  const tag = (input.tag || "div").toLowerCase();
  if (input.id?.trim()) return `${tag}#${safeId(input.id)}`;
  const classes = String(input.className || "")
    .split(/\s+/)
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, 3);
  if (classes.length) return `${tag}.${classes.map(safeClass).join(".")}`;
  return tag;
}

function safeId(id: string): string {
  return id.trim().replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

function safeClass(c: string): string {
  return c.replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, "\\$1");
}

/**
 * Normalize a raw page capture into a DesignModePickPayload (truncation + style subset).
 */
export function assembleDesignModePick(raw: {
  url: string;
  tag: string;
  id?: string;
  className?: string;
  text?: string;
  html?: string;
  bounds: DesignModeBounds;
  styles?: Record<string, string | undefined | null>;
  selectorHint?: string;
  note?: string;
  screenshotPath?: string;
  capturedAt?: string;
}): DesignModePickPayload {
  const tag = (raw.tag || "UNKNOWN").toUpperCase();
  const id = raw.id?.trim() ?? "";
  const className = typeof raw.className === "string" ? raw.className : "";
  const text = (raw.text ?? "").trim().slice(0, DESIGN_MODE_TEXT_MAX);
  const html = (raw.html ?? "").slice(0, DESIGN_MODE_HTML_MAX);
  const styles = subsetComputedStyles(raw.styles ?? {});
  const selectorHint =
    raw.selectorHint?.trim()
    || selectorHintFromIdentity({ tag, id, className });
  return {
    url: raw.url || "",
    tag,
    id,
    className,
    text,
    html,
    bounds: {
      x: Number(raw.bounds?.x) || 0,
      y: Number(raw.bounds?.y) || 0,
      width: Number(raw.bounds?.width) || 0,
      height: Number(raw.bounds?.height) || 0,
    },
    styles,
    selectorHint,
    capturedAt: raw.capturedAt ?? new Date().toISOString(),
    ...(raw.note?.trim() ? { note: raw.note.trim() } : {}),
    ...(raw.screenshotPath ? { screenshotPath: raw.screenshotPath } : {}),
  };
}

/**
 * Format a pick as a prompt the agent can act on (markdown).
 */
export function formatDesignModePickForAgent(
  pick: DesignModePickPayload,
  opts?: { agent?: string },
): string {
  const lines: string[] = [
    "## Design Mode pick (Integrated Browser)",
    "",
    opts?.agent ? `- Target agent: \`${opts.agent}\`` : "",
    `- URL: ${pick.url}`,
    `- Element: <${pick.tag.toLowerCase()}>${pick.id ? ` #${pick.id}` : ""}${pick.className ? ` class="${pick.className}"` : ""}`,
    `- Selector hint: \`${pick.selectorHint}\``,
    `- Bounds (css px): x=${Math.round(pick.bounds.x)} y=${Math.round(pick.bounds.y)} w=${Math.round(pick.bounds.width)} h=${Math.round(pick.bounds.height)}`,
    `- Text: ${JSON.stringify(pick.text)}`,
    `- Styles: ${JSON.stringify(pick.styles)}`,
    `- Captured: ${pick.capturedAt}`,
  ].filter((l) => l !== "");

  if (pick.note) {
    lines.push("", "### User note", pick.note);
  }
  if (pick.screenshotPath) {
    lines.push("", `### Screenshot`, `File: \`${pick.screenshotPath}\``);
  }
  const sel = pick.selectorHint || pick.tag.toLowerCase();
  lines.push(
    "",
    "### outerHTML (truncated)",
    "```html",
    pick.html || "<!-- empty -->",
    "```",
    "",
    "### How to act on this pick (Bridge MCP → Integrated Browser)",
    "Official path (prefer this — do **not** dig for `~/.tachyon/ide-browser-instances/`):",
    "1. `ide_browser_status` — confirm bridge online + CDP connected",
    "2. Prefer selector: `" + sel + "`",
    "3. Change styles/DOM: `ide_browser_eval` e.g.",
    "   `document.querySelector(" + JSON.stringify(sel) + ").style.setProperty('background','red','important')`",
    "4. Click: `ide_browser_click` with that selector when needed",
    "5. Re-check: `ide_browser_snapshot` / `ide_browser_screenshot`",
    "",
    "### If MCP fails",
    "- **401 / `token_unknown`**: Bridge auth rejected your agent token — not “tools missing” and not “bridge offline”.",
    "  Retry once; Tachyon heals live process tokens into the registry. If it still fails, restart this agent (remints `TACHYON_AGENT_BRIDGE_TOKEN`).",
    "- **Tools missing / bridge_offline**: open the globe icon on the VS Code status bar (IDE Browser bridge).",
    "- Master token in env is **not** a substitute for MCP when the client only sends the agent token.",
  );
  return lines.join("\n");
}
