/**
 * Option A prototype — message and pick shapes for the IDE browser stream panel.
 * Dev Host / Extension Development only. Not a product contract.
 */

export type IdeBrowserPickPayload = {
  url: string;
  tag: string;
  id: string;
  className: string;
  text: string;
  html: string;
  bounds: { x: number; y: number; w: number; h: number };
  styles: Record<string, string>;
  /** ISO timestamp when the pick was captured */
  capturedAt: string;
};

/** Webview → extension host */
export type IdeBrowserFromWeb =
  | { type: "ready" }
  | { type: "navigate"; url: string }
  | { type: "reload" }
  | { type: "click"; x: number; y: number; displayW: number; displayH: number; designMode: boolean }
  | { type: "setDesignMode"; on: boolean }
  | { type: "copyPick" };

/** Extension host → webview */
export type IdeBrowserToWeb =
  | { type: "status"; text: string; url?: string; designMode?: boolean; error?: boolean }
  | {
      type: "frame";
      dataUrl: string;
      cssW: number;
      cssH: number;
      url: string;
      source?: "screencast" | "screenshot";
    }
  | { type: "pick"; payload: IdeBrowserPickPayload | null }
  | { type: "designMode"; on: boolean };

export function formatPickForAgent(pick: IdeBrowserPickPayload): string {
  const lines = [
    "## IDE Browser pick (prototype)",
    "",
    `- URL: ${pick.url}`,
    `- Element: <${pick.tag.toLowerCase()}>${pick.id ? ` #${pick.id}` : ""}${pick.className ? ` .${String(pick.className).split(/\s+/).filter(Boolean).join(".")}` : ""}`,
    `- Bounds (css): x=${Math.round(pick.bounds.x)} y=${Math.round(pick.bounds.y)} w=${Math.round(pick.bounds.w)} h=${Math.round(pick.bounds.h)}`,
    `- Text: ${JSON.stringify(pick.text)}`,
    `- Styles: ${JSON.stringify(pick.styles)}`,
    `- Captured: ${pick.capturedAt}`,
    "",
    "### outerHTML (truncated)",
    "```html",
    pick.html,
    "```",
    "",
    "Please inspect / fix this UI element in the app under development.",
  ];
  return lines.join("\n");
}
