import type { ExternalToolKind } from "@tachyon/shared/externalTools/types.js";

const HOST_UI_ACTION_SUBSTRINGS = [
  "open",
  "focus",
  "window",
  "desktop",
  "browser",
  "reload",
  "screenshot",
  "click",
  "type",
  "launch",
  "start",
  "input",
  "cursor",
  "mouse",
  "key",
] as const;

export function isLauncherExternalToolKind(kind: ExternalToolKind): kind is "browser" | "desktop" | "screen" {
  return kind === "browser" || kind === "desktop" || kind === "screen";
}

export function hostActionTouchesHostUi(action: string): boolean {
  const label = action.toLowerCase();
  return HOST_UI_ACTION_SUBSTRINGS.some((part) => label.includes(part));
}
