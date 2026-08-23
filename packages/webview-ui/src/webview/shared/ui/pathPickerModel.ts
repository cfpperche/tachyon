/**
 * 514 — the two reading rules of the path picker, kept OUT of the JSX module.
 *
 * Same reason `studioFolders.ts` sits apart from `ContinuePicker.tsx`: a unit test cannot import a
 * `.tsx` under the gate's typecheck config, and these two rules are the part worth testing. The
 * component imports them, so a rule that stops fitting the picker fails the build there.
 */

/** The segments of a path, each with the absolute path that reaches it. */
export function breadcrumbSegments(dir: string): Array<{ label: string; path: string }> {
  const parts = dir.split("/").filter((part) => part.length > 0);
  const out: Array<{ label: string; path: string }> = [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of parts) {
    acc += `/${part}`;
    out.push({ label: part, path: acc });
  }
  return out;
}

/**
 * A typed value is a PATH when it looks like one — that is the whole rule, and it is the user's.
 *
 * One box does filtering and addressing because a sidebar rail cannot afford two. What decides which
 * is what the human typed: a leading `/` or `~` is an address, anything else is a filter.
 */
export function looksLikePath(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith("/") || trimmed.startsWith("~/") || trimmed === "~";
}
