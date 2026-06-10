import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * i18n drift guards: every l10n.t() source key must have a pt-BR translation,
 * and every %key% referenced in package.json must exist in both nls files.
 */

const root = path.resolve(__dirname, "../..");

function sourceKeys(): Set<string> {
  const keys = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith(".ts")) {
        const text = fs.readFileSync(p, "utf8");
        for (const m of text.matchAll(/l10n\.t\(\s*"((?:[^"\\]|\\.)*)"/g)) {
          keys.add(m[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"));
        }
      }
    }
  };
  walk(path.join(root, "src"));
  return keys;
}

describe("i18n completeness", () => {
  it("every l10n.t key has a pt-BR translation", () => {
    const bundle = JSON.parse(fs.readFileSync(path.join(root, "l10n/bundle.l10n.pt-br.json"), "utf8"));
    const missing = [...sourceKeys()].filter((k) => !(k in bundle));
    expect(missing).toEqual([]);
  });

  it("pt-BR translations keep the {n} placeholders of their keys", () => {
    const bundle: Record<string, string> = JSON.parse(
      fs.readFileSync(path.join(root, "l10n/bundle.l10n.pt-br.json"), "utf8"),
    );
    const bad = Object.entries(bundle).filter(([key, value]) => {
      const want = [...key.matchAll(/\{(\d+)\}/g)].map((m) => m[0]).sort();
      const got = [...value.matchAll(/\{(\d+)\}/g)].map((m) => m[0]).sort();
      return JSON.stringify(want) !== JSON.stringify(got);
    });
    expect(bad.map(([k]) => k)).toEqual([]);
  });

  it("every %key% in package.json exists in package.nls.json and the pt-BR variant", () => {
    const pkg = fs.readFileSync(path.join(root, "package.json"), "utf8");
    const refs = [...pkg.matchAll(/%([a-zA-Z0-9._-]+)%/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(20);
    const en = JSON.parse(fs.readFileSync(path.join(root, "package.nls.json"), "utf8"));
    const pt = JSON.parse(fs.readFileSync(path.join(root, "package.nls.pt-br.json"), "utf8"));
    expect(refs.filter((r) => !(r in en))).toEqual([]);
    expect(refs.filter((r) => !(r in pt))).toEqual([]);
  });
});
