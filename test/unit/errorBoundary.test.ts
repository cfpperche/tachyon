import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * t-668b05 — the ONE catch-all safety net for Control: an uncaught render exception anywhere in the
 * tree used to blank the whole Cockpit panel to black, since nothing in src/webview ever caught one.
 * Source-scan, not an import-and-call test: `ErrorBoundary.tsx`'s JSX return can't be exercised under
 * this repo's test tooling (the root tsconfig has no `jsx` compiler option, so `tsc --noEmit` refuses
 * to resolve a `.tsx` import from a `.ts` test file at all — TS6142 — and vitest's own bare esbuild
 * transform for the file, absent that option, defaults to `React.createElement`, which throws
 * "React is not defined" the moment the JSX branch actually runs; a per-file `@jsxImportSource preact`
 * pragma in the component file did not change vite's esbuild plugin behavior either). Matches this
 * repo's established constraint — no DOM/Preact rendering test harness anywhere in test/unit; see
 * prototypePreviewSha256Guard.test.ts's own doc comment for the same limitation on a hook-using
 * function component.
 */
describe("ErrorBoundary exists and is wired around Control's render root (t-668b05)", () => {
  it("is a Preact class component implementing the error-boundary contract", () => {
    const src = readFileSync("src/webview/shared/ErrorBoundary.tsx", "utf8");
    expect(src).toMatch(/class ErrorBoundary extends Component/);
    expect(src).toMatch(/static getDerivedStateFromError/);
    expect(src).toMatch(/componentDidCatch/);
  });

  it("wraps the top-level render() call in cockpit/main.tsx, not just one embedded surface", () => {
    const src = readFileSync("src/webview/cockpit/main.tsx", "utf8");
    expect(src).toMatch(/import\s*\{\s*ErrorBoundary\s*\}\s*from\s*"\.\.\/shared\/ErrorBoundary"/);
    expect(src).toMatch(/render\(<ErrorBoundary><Root \/><\/ErrorBoundary>,\s*root\)/);
  });
});
