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
  UNDECLARED_EXCEPTIONS,
  Z_INDEX_EXCEPTIONS,
  evaluateUndeclaredTokens,
  findHexLiterals,
  findNumericZIndex,
  findTokenDeclarations,
  findTokenVars,
  scanRepo,
} = tokens as {
  FIX_HINT: string;
  HEX_EXCEPTIONS: Array<{ file: string; values: string[]; reason: string }>;
  MIN_REASON: number;
  SCAN_ROOT: string;
  TOKEN_SOURCE: string;
  UNDECLARED_EXCEPTIONS: Array<{ file: string; values: string[]; reason: string }>;
  Z_INDEX_EXCEPTIONS: Array<{ file: string; values: number[]; reason: string }>;
  evaluateUndeclaredTokens: (
    hits: Array<{ file: string; line: number; name: string; hasFallback: boolean }>,
    declared: Set<string>,
    exceptions?: Array<{ file: string; values: string[]; reason: string }>,
  ) => Array<{ kind: string; rule: string; file: string; value?: string; message: string }>;
  findHexLiterals: (src: string, ext?: string) => Array<{ line: number; value: string }>;
  findNumericZIndex: (src: string, ext?: string) => Array<{ line: number; value: number }>;
  findTokenDeclarations: (src: string, ext?: string) => Set<string>;
  findTokenVars: (src: string, ext?: string) => Array<{ line: number; name: string; hasFallback: boolean }>;
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
    const rows = [...HEX_EXCEPTIONS, ...Z_INDEX_EXCEPTIONS, ...UNDECLARED_EXCEPTIONS];
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

describe("t-f45320 — undeclared --ds-* / --tachyon-* var()", () => {
  it("detects an injected undeclared token with no fallback — the guard is not vacuous", () => {
    const hits = findTokenVars(".x { color: var(--ds-not-a-token); }\n", ".css");
    expect(hits).toEqual([{ line: 1, name: "--ds-not-a-token", hasFallback: false }]);
    const violations = evaluateUndeclaredTokens(
      hits.map((h) => ({ file: "src/webview/probe.css", ...h })),
      new Set(["--ds-err"]),
    );
    expect(violations).toEqual([
      expect.objectContaining({
        kind: "new-value",
        rule: "undeclared-token",
        value: "--ds-not-a-token",
      }),
    ]);
  });

  it("an undeclared token with a fallback is not a violation — the property still applies", () => {
    const hits = findTokenVars(".x { font-size: var(--ds-large, 1.2em); }\n", ".css");
    expect(hits).toEqual([{ line: 1, name: "--ds-large", hasFallback: true }]);
    expect(
      evaluateUndeclaredTokens(
        hits.map((h) => ({ file: "src/webview/probe.css", ...h })),
        new Set(),
      ),
    ).toEqual([]);
  });

  it("a declared token with no fallback is not a violation", () => {
    const css = ":root { --ds-err: red; }\n.x { color: var(--ds-err); }\n";
    const declared = findTokenDeclarations(css, ".css");
    expect(declared.has("--ds-err")).toBe(true);
    expect(
      evaluateUndeclaredTokens(
        findTokenVars(css, ".css").map((h) => ({ file: "src/webview/probe.css", ...h })),
        declared,
      ),
    ).toEqual([]);
  });

  it("counts a JS object key as a declaration — overlay tokens live in themeTokens.ts", () => {
    const declared = findTokenDeclarations(`const t = { "--ds-font-ui": fontFamily };\n`, ".ts");
    expect([...declared]).toEqual(["--ds-font-ui"]);
  });

  it("ignores token names inside comments", () => {
    expect(findTokenVars("/* color: var(--ds-danger); */\n.x { color: var(--ds-err); }\n", ".css")).toEqual([
      { line: 2, name: "--ds-err", hasFallback: false },
    ]);
    expect(findTokenDeclarations("/* --ds-ghost: red; */\n:root { --ds-err: red; }\n", ".css")).toEqual(
      new Set(["--ds-err"]),
    );
  });

  it("a stale undeclared-token exception fails the same way a stale hex row does", () => {
    const stale = evaluateUndeclaredTokens([], new Set(["--ds-err"]), [
      {
        file: "src/webview/probe.css",
        values: ["--ds-ghost"],
        reason: "Placeholder long enough to pass the written-reason floor.",
      },
    ]);
    expect(stale.some((v) => v.kind === "stale-exception" && v.value === "--ds-ghost")).toBe(true);

    const nowDeclared = evaluateUndeclaredTokens(
      [{ file: "src/webview/probe.css", line: 1, name: "--ds-err", hasFallback: false }],
      new Set(["--ds-err"]),
      [
        {
          file: "src/webview/probe.css",
          values: ["--ds-err"],
          reason: "Placeholder long enough to pass the written-reason floor.",
        },
      ],
    );
    expect(nowDeclared.some((v) => v.kind === "stale-exception" && v.value === "--ds-err")).toBe(true);
  });

  it("the invented error/success/radius/font names are gone from live rules", () => {
    const banned = ["--ds-danger", "--ds-success", "--ds-radius-lg", "--ds-large", "--tachyon-ui-font", "--tachyon-mono", "--tachyon-font-sans"];
    const src = [
      "src/webview/rich-doc/rich-doc.css",
      "src/webview/task-studio/task-studio.css",
      "src/webview/agent-studio-shell/agent-studio-shell.css",
      "src/webview/plugin-host/plugin-host.css",
      "src/webview/probes/probes.css",
      "src/webview/shared/studio/studio-frame.css",
      "src/webview/shared/design-system.css",
    ]
      .map((file) => fs.readFileSync(path.join(ROOT, file), "utf8"))
      .join("\n");
    const live = findTokenVars(src, ".css").filter((h) => banned.includes(h.name));
    expect(live).toEqual([]);
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
    expect(FIX_HINT).toContain("tokens.css");
    expect(FIX_HINT).toContain("--ds-");
    expect(FIX_HINT).toContain("fallback");
    expect(FIX_HINT).toContain("--ds-err");
  });
});
