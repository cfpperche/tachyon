import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseRootDeclarations, resolveChain } from "./support/cssVarResolver.js";
import { nonEmpty } from "../helpers/repositorySourceScan.js";

// spec 342 T2 — the token-bridge completeness check. Two layers:
//  1. the CANONICAL set spec.md enumerates (what shadcn's generated config emits) must be defined in
//     vscode-theme.css, AND resolve to a concrete value even with ZERO --vscode-* tokens available (i.e. the
//     chain's terminal fallback is a real literal, not a dangling var()).
//  2. a forward scan of shared/ui/vendor + shared/ui/kit (empty until T3/T4) for any `var(--name)` reference
//     NOT in vscode-theme.css — so a future vendored component that reads an unanticipated variable fails
//     this test instead of silently rendering unstyled. "Remove a mapping → build fails" (tasks.md
//     verification): deleting any CANONICAL entry below from vscode-theme.css fails assertion #1.
const ROOT = path.resolve(__dirname, "..", "..");
const THEME_CSS_PATH = path.join(ROOT, "packages/webview-ui/src/webview/shared/vscode-theme.css");

const CANONICAL_VARS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "radius",
];

function walk(dir: string, exts: string[]): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, exts));
    else if (exts.includes(path.extname(entry.name))) out.push(full);
  }
  return out;
}

describe("vscode-theme.css token bridge", () => {
  const css = fs.readFileSync(THEME_CSS_PATH, "utf8");
  const declarations = parseRootDeclarations(css);

  it("defines every canonical shadcn variable spec.md enumerates", () => {
    const missing = CANONICAL_VARS.filter((name) => !declarations.has(name));
    expect(missing).toEqual([]);
  });

  it("every canonical variable resolves to a literal even with zero --vscode-* tokens available", () => {
    const dangling = CANONICAL_VARS.filter((name) => {
      try {
        resolveChain(name, {}, declarations);
        return false;
      } catch {
        return true;
      }
    });
    expect(dangling).toEqual([]);
  });

  it("has no unbridged variable reference in vendored/kit source", () => {
    const files = nonEmpty([
      ...walk(path.join(ROOT, "packages/webview-ui/src/webview/shared/ui/vendor"), [".css", ".ts", ".tsx"]),
      ...walk(path.join(ROOT, "packages/webview-ui/src/webview/shared/ui/kit"), [".css", ".ts", ".tsx"]),
    ], "VS Code theme bridge source scan");
    const unbridged = new Set<string>();
    const varRe = /var\(\s*--([a-z0-9-]+)/gi;
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = varRe.exec(content))) {
        const name = m[1];
        // vscode-/ds-/tw- are other bridges' namespaces (not this file's concern); radix- are Radix's OWN
        // runtime-computed geometry vars (e.g. `--radix-select-trigger-height`, set via inline style on the
        // popper content for sizing) — internal plumbing, never a shadcn semantic token this bridge owns.
        if (name.startsWith("vscode-") || name.startsWith("ds-") || name.startsWith("tw-") || name.startsWith("radix-")) continue;
        if (!declarations.has(name)) unbridged.add(`${name} (${path.relative(ROOT, file)})`);
      }
    }
    expect([...unbridged]).toEqual([]);
  });
});
