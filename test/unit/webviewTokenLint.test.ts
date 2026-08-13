import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// The scanner is plain ESM with no declaration surface — same convention as sourceIsDiffable.
// Single-line import so @ts-expect-error covers the missing .d.mts (a multi-line import leaves it unused).
// @ts-expect-error -- see above
import * as tokens from "../../scripts/check-webview-tokens.mjs";

const {
  FIX_HINT,
  HEX_EXCEPTIONS,
  MIN_REASON,
  SCAN_ROOT,
  TOKEN_SOURCE,
  Z_INDEX_EXCEPTIONS,
  findHexLiterals,
  findNumericZIndex,
  scanRepo,
} = tokens as {
  FIX_HINT: string;
  HEX_EXCEPTIONS: Array<{ file: string; values: string[]; reason: string }>;
  MIN_REASON: number;
  SCAN_ROOT: string;
  TOKEN_SOURCE: string;
  Z_INDEX_EXCEPTIONS: Array<{ file: string; values: number[]; reason: string }>;
  findHexLiterals: (src: string, ext?: string) => Array<{ line: number; value: string }>;
  findNumericZIndex: (src: string, ext?: string) => Array<{ line: number; value: number }>;
  scanRepo: (root?: string) => Array<{ file: string; message: string }>;
};

const ROOT = path.resolve(__dirname, "../..");

describe("t-c8e2bd — webview token lint", () => {
  it("the tree is clean against the declared exceptions", () => {
    expect(scanRepo(ROOT)).toEqual([]);
  });

  it("detects an injected hex — the guard is not vacuous", () => {
    const hits = findHexLiterals(".x { color: #00ff00; }\n", ".css");
    expect(hits).toEqual([{ line: 1, value: "#00ff00" }]);
  });

  it("detects an injected numeric z-index — the guard is not vacuous", () => {
    const css = findNumericZIndex(".x { z-index: 9999; }\n", ".css");
    expect(css).toEqual([{ line: 1, value: 9999 }]);
    const js = findNumericZIndex("const s = { zIndex: 2_147_483_647 };\n", ".ts");
    expect(js).toEqual([{ line: 1, value: 2147483647 }]);
    const assign = findNumericZIndex(`host.style.zIndex = "2147483647";\n`, ".ts");
    expect(assign).toEqual([{ line: 1, value: 2147483647 }]);
  });

  it("does not treat a token z-index as numeric", () => {
    expect(findNumericZIndex(".x { z-index: var(--ds-z-popover); }\n", ".css")).toEqual([]);
    expect(findNumericZIndex(".x { z-index: var(--ds-z-toast, 50); }\n", ".css")).toEqual([]);
  });

  it("ignores hex and z-index inside comments", () => {
    expect(findHexLiterals("/* color: #ff0000 */\n.x { color: var(--ds-err); }\n", ".css")).toEqual([]);
    expect(findNumericZIndex("// z-index: 99\nconst x = 1;\n", ".ts")).toEqual([]);
  });

  it("hex inside the design-system token file is the allowed source, not a violation", () => {
    const src = fs.readFileSync(path.join(ROOT, TOKEN_SOURCE), "utf8");
    expect(findHexLiterals(src, ".css").length).toBeGreaterThan(0);
    expect(scanRepo(ROOT).filter((v) => v.file === TOKEN_SOURCE)).toEqual([]);
  });

  it("a new distinct hex in an excepted file fails — exception is for what already shipped", () => {
    const sample = HEX_EXCEPTIONS[0];
    const planted = `${fs.readFileSync(path.join(ROOT, sample.file), "utf8")}\n.probe { color: #00ff00; }\n`;
    const found = new Set(findHexLiterals(planted, ".css").map((h) => h.value));
    expect(found.has("#00ff00")).toBe(true);
    expect(sample.values).not.toContain("#00ff00");
  });

  it("every exception carries a written reason, not an anonymous block", () => {
    const rows = [...HEX_EXCEPTIONS, ...Z_INDEX_EXCEPTIONS];
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows
        .filter((row) => !row.reason || row.reason.trim().length < MIN_REASON)
        .map((row) => row.file),
    ).toEqual([]);
  });

  it("scans design-mode-overlay: hex is closed, leftover z-index is declared, skip is gone", () => {
    const dir = path.join(ROOT, SCAN_ROOT, "design-mode-overlay");
    const files = ["App.tsx", "main.tsx", "styles.ts"].map((name) => path.join(dir, name));
    expect(files.every((file) => fs.existsSync(file))).toBe(true);

    const hex = files.flatMap((file) => findHexLiterals(fs.readFileSync(file, "utf8"), path.extname(file)));
    expect(hex).toEqual([]);

    const byFile = new Map<string, number[]>();
    for (const file of files) {
      const rel = path.relative(ROOT, file).split(path.sep).join("/");
      const values = findNumericZIndex(fs.readFileSync(file, "utf8"), path.extname(file)).map((h) => h.value);
      byFile.set(rel, [...new Set(values)].sort((a, b) => a - b));
    }
    expect(Object.fromEntries(byFile)).toEqual({
      "src/webview/design-mode-overlay/App.tsx": [1, 2, 2147483646],
      "src/webview/design-mode-overlay/main.tsx": [2147483647],
      "src/webview/design-mode-overlay/styles.ts": [3, 2147483647],
    });

    const overlayRows = Z_INDEX_EXCEPTIONS.filter((row) => row.file.startsWith("src/webview/design-mode-overlay/"));
    expect(overlayRows.length).toBeGreaterThan(0);
    expect(overlayRows.every((row) => row.reason.trim().length >= MIN_REASON)).toBe(true);
    expect(scanRepo(ROOT).filter((v) => v.file.includes("design-mode-overlay"))).toEqual([]);
    expect("SKIP_DIRS" in tokens).toBe(false);
  });
});

describe("t-c8e2bd — one implementation, wired as a static gate", () => {
  it("runs before the compile, after the cheaper byte scan", async () => {
    // @ts-expect-error -- plain ESM, see the import above
    const { STATIC_GATES } = await import("../../scripts/verify-full.mjs");
    expect(STATIC_GATES[0]).toBe("check:source-diffable");
    expect(STATIC_GATES).toContain("check:webview-tokens");
    expect(STATIC_GATES.indexOf("check:webview-tokens")).toBeLessThan(STATIC_GATES.indexOf("typecheck"));
    expect(STATIC_GATES.indexOf("check:source-diffable")).toBeLessThan(STATIC_GATES.indexOf("check:webview-tokens"));
  });

  it("is a real npm script, so the gate name resolves to something runnable", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["check:webview-tokens"]).toBe("node scripts/check-webview-tokens.mjs");
  });

  it("teaches the fix rather than only reporting a position", () => {
    expect(FIX_HINT).toContain("design-system.css");
    expect(FIX_HINT).toContain("--ds-");
  });
});
