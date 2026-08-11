/**
 * t-831332 — title a load-failure screen may claim: the surface kind, never a fake entity name.
 *
 * The `error` envelope carries no identity (four hosts post it bare). Calling `titleFor` with no
 * entity falls through to "New Agent" / "New Pipeline" and asserts a create-flow the human is not
 * in. What the screen knows is which studio it is; the banner already says the load failed.
 *
 * Pure helper (no JSX) so unit tests and pipeline-studio can share the same formula without
 * pulling the Preact surface module.
 */
export function studioLoadErrorTitle(entityType: string): string {
  const kind = entityType.trim();
  if (!kind) return "Studio";
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)} Studio`;
}
