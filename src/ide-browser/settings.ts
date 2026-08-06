/**
 * SDD 488 F4 — Integrated Browser GA gate helpers (workspace settings.ideBrowser.*).
 *
 * The gate is human surface + call-time only. Tools stay registered when the engine wires
 * ideBrowserRequest (t-3cab05 / MCP catalog freeze). Do not use these helpers to omit tools.
 */

/** Call-time fail-closed when settings.ideBrowser.enabled is not true. */
export const IDE_BROWSER_DISABLED_ERROR =
  "Integrated Browser is disabled. Set settings.ideBrowser.enabled: true in tachyon.yml (Control → Settings), then open the globe icon.";

export const IDE_BROWSER_DISABLED_CODE = "feature_disabled" as const;

/**
 * First-use tips (ASD-STE100: short procedural steps, active voice).
 * Shown once after the human opens Integrated Browser with the feature enabled.
 */
export const IDE_BROWSER_FIRST_USE_TIPS = [
  "Integrated Browser is ready.",
  "1. Click the globe icon to open a page.",
  "2. Click the inspect icon to turn Design Mode on.",
  "3. Pick an element or chat with your active agent.",
  "Set settings.ideBrowser.homeUrl in tachyon.yml for your default page.",
].join(" ");

/** True only when the project explicitly opts in. Absent/false both mean off. */
export function isIdeBrowserEnabled(
  settings: { ideBrowser?: { enabled?: boolean } } | undefined | null,
): boolean {
  return settings?.ideBrowser?.enabled === true;
}
