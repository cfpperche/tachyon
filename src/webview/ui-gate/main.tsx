import { render } from "preact";

// spec 342 — the compat-gate webview entry. The compiled Tailwind CSS (dist/webview/ui-gate.tailwind.css,
// produced by the esbuild.mjs Tailwind step) is linked directly in the HTML shell, NOT imported here — an
// `import "./tailwind.css"` would make esbuild bundle the raw `@import "tailwindcss/..."` source itself as a
// SECOND, un-minified, preflight-including CSS output, defeating the point of the dedicated CLI step. T1 scaffolds the pipeline (esbuild entry + Tailwind build +
// preact/compat aliases); T3 replaces this placeholder with the five vendored components under test, each
// exercised by a browser-level check in test/browser/uiGate.test.ts.
function Root() {
  return <div id="gate-root">ui-gate: pipeline scaffold (T1) — vendored components land in T3</div>;
}

render(<Root />, document.getElementById("root")!);
