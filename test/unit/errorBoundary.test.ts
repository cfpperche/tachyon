import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * t-668b05 — the ONE catch-all safety net: an uncaught render exception anywhere in a webview's tree
 * used to blank the whole panel to black, since nothing in src/webview ever caught one.
 *
 * Source-scan, not an import-and-call test: `ErrorBoundary.tsx`'s JSX return can't be exercised under
 * this repo's test tooling (the root tsconfig has no `jsx` compiler option, so `tsc --noEmit` refuses
 * to resolve a `.tsx` import from a `.ts` test file at all — TS6142 — and vitest's own bare esbuild
 * transform for the file, absent that option, defaults to `React.createElement`, which throws
 * "React is not defined" the moment the JSX branch actually runs). Matches this repo's established
 * constraint — no DOM/Preact rendering harness anywhere in test/unit.
 *
 * SDD 485 E1 — this file was deleted with Control and is restored deliberately. Three of its four
 * cases were never about Control: they assert the SHARED component's contract, and the component
 * outlived its first consumer. The fourth asserted the wiring in `cockpit/main.tsx`, and repointing
 * it at one replacement app would have been a downgrade — spec 485's own acceptance criterion is
 * "one app failing to render leaves the others working (C2 — per-app error boundary)", which is a
 * claim about ALL of them.
 *
 * So the wiring case is now measured across every app, and the measurement found the criterion is
 * only PARTLY true: 12 of 29 mounts had no boundary at all. Rather than assert a green that isn't
 * there, the gap is named and ratcheted — adopters must wrap the ROOT (a boundary around one inner
 * surface catches less than the panel-blanking case it exists for), and the unprotected list may
 * shrink but never grow.
 */

const MAINS_DIR = "packages/webview-ui/src/webview";
const read = (file: string): string => readFileSync(file, "utf8");

function appMains(): string[] {
  return readdirSync(MAINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${MAINS_DIR}/${entry.name}/main.tsx`)
    .filter((file) => {
      try { readFileSync(file); return true; } catch { return false; }
    })
    .sort();
}

/**
 * Measured 2026-08-04 (SDD 485 E1), reduced by t-cd01bb. These five exclusions are deliberate:
 * each reason stays beside the ratchet entry so a future reader can distinguish a decision from an
 * overlooked product surface.
 */
const UNPROTECTED = [
  // Dev-only spec 350 fixture: failures should stay raw and conspicuous to fixture authors.
  "packages/webview-ui/src/webview/agent-studio-fixture/main.tsx",
  // Dev-only preview: masking a broken development surface with product recovery has no user benefit.
  "packages/webview-ui/src/webview/pipeline-studio/main.tsx",
  // Imperative sandbox host with no Preact tree: plugin faults belong to isolation/relay handling, not this boundary.
  "packages/webview-ui/src/webview/plugin-host/main.tsx",
  // This is the whole navigation app, not an editor panel; replacing it needs a sidebar-wide recovery design.
  "packages/webview-ui/src/webview/sidebar/main.tsx",
  // Dev-only compatibility harness: uncaught failures are the gate's diagnostic output, not a recoverable state.
  "packages/webview-ui/src/webview/ui-gate/main.tsx",
];

function wrapsProductRoot(source: string): boolean {
  const compact = source.replace(/\s+/g, " ");
  return /render\(\s*<ErrorBoundary>/.test(compact)
    // The studio helper owns the render call and lifecycle shell; its caller supplies the complete
    // product subtree. Require the boundary at that outermost caller-supplied component.
    || /mountSingleModeStudio\(\s*\(props\)\s*=>\s*\(\s*<ErrorBoundary>/.test(compact);
}

describe("the shared ErrorBoundary keeps its contract (t-668b05)", () => {
  it("is a Preact class component implementing the error-boundary contract", () => {
    const src = read("packages/webview-ui/src/webview/shared/ErrorBoundary.tsx");
    expect(src).toMatch(/class ErrorBoundary extends Component/);
    expect(src).toMatch(/static getDerivedStateFromError/);
    expect(src).toMatch(/componentDidCatch/);
  });

  // t-668b05 (round-1 code-review finding) — "Try again" merely clearing the caught error does NOT
  // guarantee recovery (the child keeps its own hooks/state across the catch — same element identity,
  // no remount — so if the crash-causing data is still there, the very next render throws again in a
  // loop). Fixed by cloning the child with a fresh `key` on every reset, forcing a genuine remount.
  it("Try again forces a genuine remount (cloneElement with a fresh key), not just clearing the error flag", () => {
    const src = read("packages/webview-ui/src/webview/shared/ErrorBoundary.tsx");
    expect(src).toMatch(/import\s*\{\s*Component,\s*cloneElement,/);
    expect(src).toMatch(/resetGeneration:\s*prev\.resetGeneration \+ 1/);
    expect(src).toMatch(/cloneElement\(this\.props\.children,\s*\{\s*key:\s*resetGeneration\s*\}\)/);
  });

  it("offers Copy details for a screenshot-unfriendly error (name/message/stack, not just the message)", () => {
    const src = read("packages/webview-ui/src/webview/shared/ErrorBoundary.tsx");
    expect(src).toMatch(/error\.stack/);
    expect(src).toMatch(/navigator\.clipboard\?\.writeText/);
  });
});

describe("SDD 485 C2 — per-app error boundary, measured across every app", () => {
  it("wraps the ROOT render in every app that adopts it, not one inner surface", () => {
    const offenders = appMains()
      .filter((file) => read(file).includes("ErrorBoundary"))
      .filter((file) => !wrapsProductRoot(read(file)));
    expect(
      offenders,
      "these import ErrorBoundary but do not wrap the root render — a boundary around one inner " +
      "surface catches strictly less than the whole-panel blanking it exists to prevent",
    ).toEqual([]);
  });

  it("does not grow the list of apps with no boundary at all", () => {
    const unprotected = appMains().filter((file) => !read(file).includes("ErrorBoundary"));
    const added = unprotected.filter((file) => !UNPROTECTED.includes(file));
    expect(
      added,
      `${added.join(", ")} mounts a webview with no error boundary. An uncaught render exception ` +
      "blanks that panel to black. Wrap the root render, as 17 of the apps already do.",
    ).toEqual([]);
  });

  it("keeps the known gap honest — an entry that got fixed must leave the list", () => {
    // Without this the list rots into a lie: a surface could gain a boundary and still be named here
    // as unprotected, and the next reader would not know which entries are real.
    const unprotected = appMains().filter((file) => !read(file).includes("ErrorBoundary"));
    const stale = UNPROTECTED.filter((file) => !unprotected.includes(file));
    expect(stale, `${stale.join(", ")} now has a boundary — remove it from UNPROTECTED`).toEqual([]);
  });
});
