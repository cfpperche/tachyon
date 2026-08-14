/**
 * spec 282 — the FROZEN class-composer for the webview component kit. Intentionally primitive: strings + falsey
 * values only, in order, no object syntax / no dedupe / no conflict resolution (that's how `classnames` grows into
 * a dependency). Variant→class mapping lives as explicit objects in the components, not in here.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
