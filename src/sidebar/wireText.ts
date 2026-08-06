/**
 * Size policy for persisted prose projected onto the strict Sidebar wire.
 *
 * The projection parser is used on both sides of the engine/shell boundary. Its transforms are the
 * one place that fits display prose, while tool schemas import these same caps when rejecting an
 * authoring value is preferable to shortening durable state.
 */
export const SIDEBAR_FOCUS_FULL_MAX = 2_000;
export const SIDEBAR_PIN_TEXT_MAX = 2_000;

export function fitSidebarWireText(value: string, max: number, marker: string): string {
  if (value.length <= max) return value;
  if (max <= marker.length) return marker.slice(0, max);
  const end = max - marker.length;
  let prefix = value.slice(0, end);
  const last = prefix.charCodeAt(prefix.length - 1);
  if (last >= 0xD800 && last <= 0xDBFF) prefix = prefix.slice(0, -1);
  return `${prefix}${marker}`;
}
