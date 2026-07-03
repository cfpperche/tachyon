// spec 342 — a tiny CSS custom-property fallback resolver shared by vscodeThemeBridge.test.ts and
// vscodeThemeFixtures.test.ts, so "does this chain bottom out in a literal" is checked the SAME way in both
// places instead of two regex heuristics drifting apart. Handles this project's actual chain shapes:
// `var(--a)`, `var(--a, LITERAL)`, `var(--a, var(--b, LITERAL))`, and a locally-defined `--b` that itself
// resolves via the same rules (e.g. `--card-foreground` falling back to this file's own `--foreground`).

export function parseRootDeclarations(cssText: string): Map<string, string> {
  const rootBlock = cssText.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!rootBlock) throw new Error("no :root { … } block found");
  const map = new Map<string, string>();
  const declRe = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(rootBlock[1]))) map.set(m[1], m[2].trim());
  return map;
}

/** Resolve one declaration's value against a synthetic `--vscode-*` token map (key = suffix after
 *  `vscode-`), transitively following references to OTHER locally-declared variables. Returns undefined only
 *  for a truly dangling `var(--x)` with no matching token and no fallback. */
export function resolveValue(
  value: string,
  vscodeTokens: Record<string, string>,
  declarations: Map<string, string>,
  seen = new Set<string>(),
): string | undefined {
  const varCall = value.match(/^var\(\s*--([a-z0-9-]+)\s*(?:,\s*([\s\S]+))?\)$/i);
  if (!varCall) return value; // already a literal: hex, color-mix(...), rgb(...), keyword, or a length
  const [, name, fallback] = varCall;
  if (seen.has(name)) throw new Error(`circular var(--${name}) reference`);
  const nextSeen = new Set(seen).add(name);
  if (name.startsWith("vscode-") && name.slice(7) in vscodeTokens) return vscodeTokens[name.slice(7)];
  if (declarations.has(name)) return resolveValue(declarations.get(name)!, vscodeTokens, declarations, nextSeen);
  if (fallback === undefined) return undefined;
  if (/^var\(/.test(fallback)) return resolveValue(fallback, vscodeTokens, declarations, nextSeen);
  return fallback; // a literal (hex / color-mix(...) / rgb(...) / keyword / length)
}

export function resolveChain(
  name: string,
  vscodeTokens: Record<string, string>,
  declarations: Map<string, string>,
): string {
  const raw = declarations.get(name);
  if (raw === undefined) throw new Error(`--${name} is not declared`);
  const resolved = resolveValue(raw, vscodeTokens, declarations);
  if (resolved === undefined) throw new Error(`--${name} resolved to nothing under this fixture (dangling var())`);
  return resolved;
}
