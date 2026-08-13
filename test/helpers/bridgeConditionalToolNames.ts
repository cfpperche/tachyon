/**
 * Handwritten name lists for the two Bridge families that register only under a dep/setting.
 * t-8e0366 — this file IS the guard. Do not derive these names from src/; a list that reads the
 * registrar is a tautology (t-33b5cd). Adding a tool without adding it here must fail the tests
 * that import these arrays.
 */
export const IDE_BROWSER_TOOL_NAMES = [
  "ide_browser_status",
  "ide_browser_navigate",
  "ide_browser_screenshot",
  "ide_browser_snapshot",
  "ide_browser_eval",
  "ide_browser_click",
  "ide_browser_url",
] as const;

export const USER_BROWSER_TOOL_NAMES = [
  "user_browser_tabs_list",
  "user_browser_snapshot",
  "user_browser_click",
  "user_browser_type",
  "user_browser_fill",
  "user_browser_screenshot",
  "user_browser_eval",
  "user_browser_console",
  "user_browser_navigate",
  "user_browser_scroll",
  "user_browser_press_key",
  "user_browser_wait_for",
  "user_browser_tab_open",
  "user_browser_tab_activate",
  "user_browser_tab_close",
  "user_browser_get",
  "user_browser_find",
  "user_browser_hover",
  "user_browser_select_option",
  "user_browser_check",
  "user_browser_drag",
  "user_browser_upload",
  "user_browser_download",
  "user_browser_network",
  "user_browser_list_frames",
  "user_browser_dialog",
] as const;
