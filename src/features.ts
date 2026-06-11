/**
 * Feature flags for HIDING (not removing) subsystems. Flip a flag back to true
 * to re-surface the feature — code, config parsing, and tests stay in the tree.
 */
export const FEATURES = {
  /**
   * Editor layouts / split panels (spec 203 / F22 + the original layouts).
   * Hidden 2026-06-10 (product call): VSCode's native editor-group system
   * already covers splitting/resizing panes, so the named-layout machinery is
   * redundant surface. While off: the Layouts sidebar view, the Apply/Save
   * Layout commands, and the `settings.layout` auto-apply are not presented or
   * honored. `layouts:` in tachyon.yml is still parsed (so existing configs
   * don't error) — just ignored. layoutLogic + its unit tests remain green.
   */
  layouts: false,
} as const;
