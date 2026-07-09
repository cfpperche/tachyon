import * as esbuild from "esbuild";
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const watch = process.argv.includes("--watch");

// VS Code's extension host can expose `navigator` as a throwing migration getter. Some bundled deps probe
// `typeof navigator`; in the Node bundles Tachyon never needs browser navigator, so erase it at build time.
const nodeDefines = {
  navigator: "undefined",
};

// spec 342 — the Kit legacy-fallback kill switch (shared/ui/kit/flags.ts): ONE build-time define per
// component with a genuine legacy implementation, flippable per-build with NO call-site change and no
// runtime toggle. `TACHYON_KIT_SELECT=legacy npm run build` ships KitSelect's native-<select> internals
// instead of the vendored Radix Select.
const kitDefines = {
  __TACHYON_KIT_FLAGS__: JSON.stringify({ select: process.env.TACHYON_KIT_SELECT === "legacy" ? "legacy" : "radix" }),
};

// The extension host bundle (Node; vscode external).
const extension = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  define: nodeDefines,
  sourcemap: true,
  logLevel: "info",
};

// spec 265 — the standalone tool LAUNCHER bundle (Node; NO vscode). Copied to .tachyon/bin/_tachyon-tool.js
// and exec'd by a git pre-commit hook with no VS Code running, so it must be self-contained.
const toolLauncher = {
  entryPoints: ["src/toolLauncherEntry.ts"],
  bundle: true,
  outfile: "dist/tool-launcher.cjs",
  platform: "node",
  format: "cjs",
  target: "node20",
  define: nodeDefines,
  sourcemap: false,
  logLevel: "info",
};

// spec 284 — the standalone DATA RESOLVER bundle (Node; NO vscode). Copied to .tachyon/bin/_tachyon-data.js and
// exec'd by a plugin skill with no VS Code running, so it must be self-contained. Sibling of the tool launcher.
const dataResolver = {
  entryPoints: ["src/dataResolverEntry.ts"],
  bundle: true,
  outfile: "dist/data-resolver.cjs",
  platform: "node",
  format: "cjs",
  target: "node20",
  define: nodeDefines,
  sourcemap: false,
  logLevel: "info",
};

// spec 285 — the standalone EXTERNAL-tool resolver bundle (Node; NO vscode). Copied to .tachyon/bin/_tachyon-external.js.
const externalResolver = {
  entryPoints: ["src/externalResolverEntry.ts"],
  bundle: true,
  outfile: "dist/external-resolver.cjs",
  platform: "node",
  format: "cjs",
  target: "node20",
  define: nodeDefines,
  sourcemap: false,
  logLevel: "info",
};

// spec 342 — every "react"-shaped import (Radix's own internals, not just our JSX) resolves to preact's
// compat layer at build time. MUST be on every browser target that can transitively pull in shared/ui/vendor
// or shared/ui/kit (which is now any of them, via esbuild.mjs's shared `sidebar` base below) — a target
// missing this alias bundles a SECOND, uninitialized "react" alongside preact, and Radix's internal hooks
// crash reading a null dispatcher (caught live: Pilot A's plugins bundle crashed with "Cannot read
// properties of null (reading 'useMemo')" before this was on the shared base, not just excalidraw/ui-gate).
const preactCompat = {
  react: "preact/compat",
  "react-dom": "preact/compat",
  "react-dom/client": "preact/compat",
  "react/jsx-runtime": "preact/jsx-runtime",
  "react/jsx-dev-runtime": "preact/jsx-dev-runtime",
};

// spec 237 — the Preact sidebar webview bundle (browser; runs in the webview iframe, never imports vscode).
const sidebar = {
  entryPoints: ["src/webview/sidebar/main.tsx"],
  bundle: true,
  outfile: "dist/webview/sidebar.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
  jsx: "automatic",
  jsxImportSource: "preact",
  minify: !watch,
  sourcemap: true,
  logLevel: "info",
  define: kitDefines,
  alias: preactCompat,
};

// spec 238 — the Preact activity-view webview bundle (editor-area panel; never imports vscode).
const activity = {
  ...sidebar,
  entryPoints: ["src/webview/activity/main.tsx"],
  outfile: "dist/webview/activity.js",
};

// spec 245 — the Preact Project Handoff webview bundle (editor-area panel; never imports vscode).
const handoff = {
  ...sidebar,
  entryPoints: ["src/webview/handoff/main.tsx"],
  outfile: "dist/webview/handoff.js",
};

const approval = {
  ...sidebar,
  entryPoints: ["src/webview/approval/main.tsx"],
  outfile: "dist/webview/approval.js",
};

// spec 250 — the Preact Plugins View webview bundle (editor-area panel; never imports vscode).
const plugins = {
  ...sidebar,
  entryPoints: ["src/webview/plugins/main.tsx"],
  outfile: "dist/webview/plugins.js",
};

// spec 279 — the Preact Probes view bundle (converted from inline HTML; editor-area panel, never imports vscode).
const probes = {
  ...sidebar,
  entryPoints: ["src/webview/probes/main.tsx"],
  outfile: "dist/webview/probes.js",
};

// spec 279 — the Preact Inspector view bundle (converted from inline HTML; editor-area panel, never imports vscode).
const inspector = {
  ...sidebar,
  entryPoints: ["src/webview/inspector/main.tsx"],
  outfile: "dist/webview/inspector.js",
};

// spec 279 — the Preact Pin Preview view bundle (converted from inline HTML; read-only, never imports vscode).
const pinPreview = {
  ...sidebar,
  entryPoints: ["src/webview/pin-preview/main.tsx"],
  outfile: "dist/webview/pin-preview.js",
};

// spec 255 — the Preact/Tiptap Pin Studio editor-area webview bundle.
const pinStudio = {
  ...sidebar,
  entryPoints: ["src/webview/pin-studio/main.tsx"],
  outfile: "dist/webview/pin-studio.js",
};

// spec 350 T4 — the Preact Pipeline Studio webview bundle (Phase 1 shell proof, Fake 1). Dev-flag-hidden: no
// command contribution anywhere ships this surface to a real user; it's reachable only via the dev preview
// harness and its own host-side tests.
const pipelineStudio = {
  ...sidebar,
  entryPoints: ["src/webview/pipeline-studio/main.tsx"],
  outfile: "dist/webview/pipeline-studio.js",
};

// spec 350 T5 — the Preact Agent-entity fixture webview bundle (Fake 2, region-composition proof). Test +
// preview route only — no command contribution anywhere ships this surface to a real user.
const agentStudioFixture = {
  ...sidebar,
  entryPoints: ["src/webview/agent-studio-fixture/main.tsx"],
  outfile: "dist/webview/agent-studio-fixture.js",
};

// spec 350 Phase 3 T3 — the Agent Studio (shell) webview bundle: the per-entity, single-document Agent
// studio rendered on the studio shell.
const agentStudioShell = {
  ...sidebar,
  entryPoints: ["src/webview/agent-studio-shell/main.tsx"],
  outfile: "dist/webview/agent-studio-shell.js",
};

// spec 350 Phase 4 Step 1 — the Terminal Studio (shell) webview bundle: terminal kind only.
const terminalStudioShell = {
  ...sidebar,
  entryPoints: ["src/webview/terminal-studio-shell/main.tsx"],
  outfile: "dist/webview/terminal-studio-shell.js",
};

// spec 350 Phase 4 Step 2 — the Command Studio (shell) webview bundle: command kind only.
const commandStudioShell = {
  ...sidebar,
  entryPoints: ["src/webview/command-studio-shell/main.tsx"],
  outfile: "dist/webview/command-studio-shell.js",
};

// spec 350 Phase 4 Step 3 — the Runbook Studio (shell) webview bundle: runbook kind only, with live
// command-catalog referenceData refreshes.
const runbookStudioShell = {
  ...sidebar,
  entryPoints: ["src/webview/runbook-studio-shell/main.tsx"],
  outfile: "dist/webview/runbook-studio-shell.js",
};

// spec 350 Phase 4 Step 4 — the Schedule Studio (shell) webview bundle: schedule kind only, preserving the
// Workspace.studioSubmit scheduler activation side effect on save.
const scheduleStudioShell = {
  ...sidebar,
  entryPoints: ["src/webview/schedule-studio-shell/main.tsx"],
  outfile: "dist/webview/schedule-studio-shell.js",
};

// spec 349 T10 — first-party plugin surface relay. It mounts the opaque-origin plugin iframe, nonce-stamps
// inline plugin scripts, and relays typed messages to the VS Code host.
const pluginHost = {
  ...sidebar,
  entryPoints: ["src/webview/plugin-host/main.tsx"],
  outfile: "dist/webview/plugin-host.js",
};

// spec 335 — the Preact Mission Control board webview bundle (editor-area panel; never imports vscode).
const missionControl = {
  ...sidebar,
  entryPoints: ["src/webview/mission-control/main.tsx"],
  outfile: "dist/webview/mission-control.js",
};

// spec 335 — the Preact Task Detail webview bundle (editor-area panel, one per task id; never imports vscode).
const taskDetail = {
  ...sidebar,
  entryPoints: ["src/webview/task-detail/main.tsx"],
  outfile: "dist/webview/task-detail.js",
};

// spec 339 — the Preact Task Studio editor-area webview bundle (one panel per task id + a new-task
// singleton per workspace; shares the rich-doc editor stack + excalidraw bundle with Pin Studio).
const taskStudio = {
  ...sidebar,
  entryPoints: ["src/webview/task-studio/main.tsx"],
  outfile: "dist/webview/task-studio.js",
};

// spec 256 — Excalidraw as its OWN on-demand bundle. It declares React peers; Tachyon webviews stay
// Preact-only by aliasing those peers at the bundle boundary and loading this file only for sketch editing.
const excalidraw = {
  ...sidebar,
  entryPoints: ["src/webview/pin-studio/excalidraw-entry.tsx"],
  outfile: "dist/webview/excalidraw.js",
  alias: preactCompat,
  define: {
    "process.env.IS_PREACT": "\"true\"",
    "process.env.NODE_ENV": watch ? "\"development\"" : "\"production\"",
  },
};

// spec 238 (inc 16) — mermaid as its OWN on-demand iife bundle (~3MB). NOT loaded with the activity panel;
// the webview injects it as a <script> only when a ```mermaid block first appears, then caches it.
const mermaid = {
  entryPoints: ["src/webview/activity/mermaid-entry.ts"],
  bundle: true,
  outfile: "dist/webview/mermaid.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
  minify: true, // always minified — it's large; sourcemap omitted to keep dist lean
  logLevel: "info",
};

// spec 238 (inc 17) — KaTeX as its OWN on-demand iife bundle (+ its CSS/fonts copied below). Loaded only
// when a math span first appears, like mermaid; no-math chats never fetch it.
const katex = {
  entryPoints: ["src/webview/activity/katex-entry.ts"],
  bundle: true,
  outfile: "dist/webview/katex.js",
  platform: "browser",
  format: "iife",
  target: "es2020",
  minify: true,
  logLevel: "info",
};

// spec 278 — the dev-only preview-harness glue (reads ?view=&fixture=, loads a real webview bundle, injects a
// fixture). Output lives OUTSIDE dist/webview and is excluded from the vsix (.vscodeignore); never shipped.
const preview = {
  ...sidebar,
  entryPoints: ["scripts/webview-preview/preview.ts"],
  outfile: "dist/webview-preview/preview.js",
  format: "esm",
};

// spec 342 — the ui-gate webview bundle: an isolated page for the Radix-under-compat compat gate (T3), built
// with the SAME preact/compat aliases as excalidraw so the gate proves what production actually ships. Never
// shipped in the vsix (dev/CI-only surface, same as `preview`).
const uiGate = {
  ...sidebar,
  entryPoints: ["src/webview/ui-gate/main.tsx"],
  outfile: "dist/webview/ui-gate.js",
  alias: preactCompat,
};

// spec 342 — Tailwind v4 build step, OPT-IN per surface (a surface lists itself here to get a compiled CSS
// bundle; a surface not listed is byte-untouched by Tailwind). Each entry compiles at build time via the
// `@tailwindcss/cli` package invoked directly as a Node script — no runtime, no external fetches, no
// tailwind.config.js (v4 is CSS-config-only; preflight-off is a property of the input file, see its header).
const tailwindSurfaces = [
  { input: "src/webview/ui-gate/tailwind.css", output: "dist/webview/ui-gate.tailwind.css" },
  { input: "src/webview/plugins/tailwind.css", output: "dist/webview/plugins.tailwind.css" }, // spec 342 Pilot A
  { input: "src/webview/task-studio/tailwind.css", output: "dist/webview/task-studio.tailwind.css" }, // spec 342 Pilot B
  { input: "src/webview/mission-control/tailwind.css", output: "dist/webview/mission-control.tailwind.css" }, // t-6da5f0 — first t-b0a229 board adoption (KitSelect agent filter)
];
const tailwindCli = fileURLToPath(new URL("./node_modules/@tailwindcss/cli/dist/index.mjs", import.meta.url));

function buildTailwind() {
  for (const { input, output } of tailwindSurfaces) {
    const args = [tailwindCli, "-i", input, "-o", output];
    if (!watch) args.push("--minify");
    execFileSync(process.execPath, args, { stdio: "inherit" });
  }
}

mkdirSync("dist/webview", { recursive: true });
buildTailwind();
copyFileSync("src/config/tachyon.schema.json", "dist/tachyon.schema.json");
copyFileSync("node_modules/@vscode/codicons/dist/codicon.css", "dist/webview/codicon.css");
copyFileSync("src/webview/shared/design-system.css", "dist/webview/design-system.css"); // spec 252 — shared webview design system
copyFileSync("src/webview/shared/vscode-theme.css", "dist/webview/vscode-theme.css"); // spec 342 — shadcn/vendor token bridge (ONE shared source; see its header)
// spec 345 — Tachyon-owned webview fonts live in their own subtree so KaTeX/Excalidraw can continue owning
// dist/webview/fonts directly without filename collisions or unclear provenance.
rmSync("dist/webview/fonts/tachyon", { recursive: true, force: true });
cpSync("src/webview/shared/fonts/tachyon", "dist/webview/fonts/tachyon", { recursive: true });
copyFileSync("src/webview/sidebar/sidebar.css", "dist/webview/sidebar.css"); // spec 274 — sidebar styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/handoff/handoff.css", "dist/webview/handoff.css"); // spec 280 — handoff styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/approval/approval.css", "dist/webview/approval.css");
copyFileSync("src/webview/rich-doc/rich-doc.css", "dist/webview/rich-doc.css"); // spec 339 — entity-neutral rich-doc editor styles (shared by pin-studio + task-studio + the dev preview harness)
copyFileSync("src/webview/pin-studio/pin-studio.css", "dist/webview/pin-studio.css"); // spec 280 — pin-studio styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/task-studio/task-studio.css", "dist/webview/task-studio.css"); // spec 339 — task-studio styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/mission-control/mission-control.css", "dist/webview/mission-control.css"); // spec 335 — Mission Control board styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/task-detail/task-detail.css", "dist/webview/task-detail.css"); // spec 335 — Task Detail styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/plugins/plugins.css", "dist/webview/plugins.css"); // spec 278 — plugins styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/activity/activity.css", "dist/webview/activity.css"); // spec 278 — activity styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/probes/probes.css", "dist/webview/probes.css"); // spec 279 — probes styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/inspector/inspector.css", "dist/webview/inspector.css"); // spec 279 — inspector styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/pin-preview/pin-preview.css", "dist/webview/pin-preview.css"); // spec 279 — pin-preview styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/shared/studio/studio-frame.css", "dist/webview/studio-frame.css"); // spec 350 — the studio shell's chrome (shared by any studio built on it + the dev preview harness)
copyFileSync("src/webview/pipeline-studio/pipeline-studio.css", "dist/webview/pipeline-studio.css"); // spec 350 T4 — Pipeline Studio (Fake 1) domain-region styles
copyFileSync("src/webview/agent-studio-fixture/agent-studio-fixture.css", "dist/webview/agent-studio-fixture.css"); // spec 350 T5 — Agent-entity fixture (Fake 2) domain-region styles
copyFileSync("src/webview/agent-studio-shell/agent-studio-shell.css", "dist/webview/agent-studio-shell.css"); // spec 350 Phase 3 T3 — Agent Studio (shell) domain-region styles
copyFileSync("src/webview/terminal-studio-shell/terminal-studio-shell.css", "dist/webview/terminal-studio-shell.css"); // spec 350 Phase 4 Step 1 — Terminal Studio (shell) domain-region styles
copyFileSync("src/webview/command-studio-shell/command-studio-shell.css", "dist/webview/command-studio-shell.css"); // spec 350 Phase 4 Step 2 — Command Studio (shell) domain-region styles
copyFileSync("src/webview/runbook-studio-shell/runbook-studio-shell.css", "dist/webview/runbook-studio-shell.css"); // spec 350 Phase 4 Step 3 — Runbook Studio (shell) domain-region styles
copyFileSync("src/webview/schedule-studio-shell/schedule-studio-shell.css", "dist/webview/schedule-studio-shell.css"); // spec 350 Phase 4 Step 4 — Schedule Studio (shell) domain-region styles
copyFileSync("src/webview/plugin-host/plugin-host.css", "dist/webview/plugin-host.css"); // spec 349 T10 — plugin UI relay shell
copyFileSync("node_modules/@vscode/codicons/dist/codicon.ttf", "dist/webview/codicon.ttf");
// KaTeX stylesheet + fonts (the CSS references fonts/ relatively → keep them adjacent under dist/webview).
copyFileSync("node_modules/katex/dist/katex.min.css", "dist/webview/katex.min.css");
cpSync("node_modules/katex/dist/fonts", "dist/webview/fonts", { recursive: true });
// Excalidraw package layouts differ by version:
// - 0.18.x ships dist/prod/index.css + dist/prod/fonts.
// - 0.17.x injects styles from JS and lazy-loads dist/excalidraw-assets/* chunks/fonts.
const excalidrawCss = "node_modules/@excalidraw/excalidraw/dist/prod/index.css";
const excalidrawFonts = "node_modules/@excalidraw/excalidraw/dist/prod/fonts";
const excalidrawAssets = "node_modules/@excalidraw/excalidraw/dist/excalidraw-assets";
if (existsSync(excalidrawCss)) {
  copyFileSync(excalidrawCss, "dist/webview/excalidraw.css");
} else {
  writeFileSync("dist/webview/excalidraw.css", "/* Excalidraw injects its styles from the JS bundle in this package layout. */\n");
}
if (existsSync(excalidrawFonts)) {
  cpSync(excalidrawFonts, "dist/webview/fonts", { recursive: true });
}
if (existsSync(excalidrawAssets)) {
  rmSync("dist/webview/excalidraw-assets", { recursive: true, force: true });
  cpSync(excalidrawAssets, "dist/webview/excalidraw-assets", { recursive: true });
}

const targets = [extension, toolLauncher, dataResolver, externalResolver, sidebar, activity, handoff, approval, plugins, probes, inspector, pinPreview, pinStudio, missionControl, taskDetail, taskStudio, pipelineStudio, agentStudioFixture, agentStudioShell, terminalStudioShell, commandStudioShell, runbookStudioShell, scheduleStudioShell, pluginHost, excalidraw, mermaid, katex, preview, uiGate];
if (watch) {
  const ctxs = await Promise.all(targets.map((c) => esbuild.context(c)));
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all(targets.map((c) => esbuild.build(c)));
}
