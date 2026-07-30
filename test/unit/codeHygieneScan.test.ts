import { describe, expect, it } from "vitest";
// Plain ESM harness with no declaration surface — same convention as check-source-diffable.mjs.
// @ts-expect-error -- see above
import { extractEntrypoints } from "../../scripts/code-hygiene/scan.mjs";

describe("code-hygiene extractEntrypoints", () => {
  it("collects quoted entryPoints arrays from esbuild-shaped source", () => {
    const src = `
const extension = {
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
};
const cockpit = {
  entryPoints: ["src/webview/cockpit/main.tsx"],
};
const multi = {
  entryPoints: [
    "a.ts",
    'b.ts',
  ],
};
`;
    expect(extractEntrypoints(src)).toEqual([
      "a.ts",
      "b.ts",
      "src/extension.ts",
      "src/webview/cockpit/main.tsx",
    ]);
  });

  it("returns empty when no entryPoints present", () => {
    expect(extractEntrypoints("const x = 1;")).toEqual([]);
  });
});
