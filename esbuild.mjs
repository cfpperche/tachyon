import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertStableBuildSource, resolveEngineReleaseChannel } from "./scripts/engine-release-channel.mjs";

const watch = process.argv.includes("--watch");
const engineReleaseChannel = resolveEngineReleaseChannel();
if (engineReleaseChannel === "stable") assertStableBuildSource();

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function buildStamp() {
  try {
    const commit = git(["rev-parse", "HEAD"]);
    const treeSha = git(["rev-parse", "HEAD^{tree}"]);
    const status = git(["status", "--porcelain", "--untracked-files=no"]);
    return { commit, treeSha, dirty: status.length > 0 };
  } catch {
    return { commit: null, treeSha: null, dirty: true };
  }
}

const buildStampSnapshot = buildStamp();
const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function writeEngineManifest() {
  const manifest = {
    schemaVersion: 1,
    channel: engineReleaseChannel,
    engineVersion: packageVersion,
    protocol: { min: 3, max: 3 },
    entrypoint: "engine-daemon.cjs",
    files: [
      { path: "engine-daemon.cjs", sha256: sha256File("dist/engine/engine-daemon.cjs") },
      { path: "pi-bridge-extension.mjs", sha256: sha256File("dist/engine/pi-bridge-extension.mjs") },
      { path: "media/clipboard-copy.sh", sha256: sha256File("dist/engine/media/clipboard-copy.sh"), executable: true },
    ],
    build: {
      commit: buildStampSnapshot.commit ?? "0".repeat(40),
      treeSha: buildStampSnapshot.treeSha ?? "0".repeat(40),
      workingTreeClean: buildStampSnapshot.commit !== null
        && buildStampSnapshot.treeSha !== null
        && !buildStampSnapshot.dirty,
    },
  };
  writeFileSync("dist/engine/engine-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
}

const engineManifestPlugin = {
  name: "tachyon-engine-manifest",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length === 0
        && existsSync("dist/engine/engine-daemon.cjs")
        && existsSync("dist/engine/pi-bridge-extension.mjs")) writeEngineManifest();
    });
  },
};

// VS Code's extension host can expose `navigator` as a throwing migration getter. Some bundled deps probe
// `typeof navigator`; in the Node bundles Tachyon never needs browser navigator, so erase it at build time.
const nodeDefines = {
  navigator: "undefined",
  __TACHYON_BUILD__: JSON.stringify(buildStampSnapshot),
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

// spec 382 — standalone workspace engine.  The Extension Host stages this immutable bundle outside the
// extension-version directory, then the Linux user-service manager owns its lifetime across reloads.
// The manifest plugin hashes the exact emitted daemon and its only runtime media dependency.
const engineDaemon = {
  entryPoints: ["src/engine-service/daemonMain.ts"],
  bundle: true,
  outfile: "dist/engine/engine-daemon.cjs",
  platform: "node",
  format: "cjs",
  target: "node20",
  define: nodeDefines,
  sourcemap: false,
  logLevel: "info",
  plugins: [engineManifestPlugin],
};

// spec 399 — self-contained Pi extension loaded additively by every Tachyon-spawned Pi agent.
// It runs inside Pi, not the engine, but ships in the authenticated immutable engine bundle so its
// path survives extension upgrades and never depends on project/global Pi configuration.
const piBridgeExtension = {
  entryPoints: ["src/pi-bridge-extension/index.ts"],
  bundle: true,
  outfile: "dist/engine/pi-bridge-extension.mjs",
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: false,
  logLevel: "info",
  plugins: [engineManifestPlugin],
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

// t-610705 (SDD 410 Phase C.2) — the standalone Activity bundle was retired: it's a Control
// subroute now (src/webview/activity/App.tsx stays, lazy-imported by cockpit/App.tsx via CSS
// co-load). activity.css is still copied below — Cockpit.ts co-loads it.

// t-610705 (SDD 410 Phase C.3) — the standalone Project Handoff bundle was retired: it's a Control
// section now (src/webview/handoff/App.tsx stays, lazy-imported by cockpit/App.tsx via CSS
// co-load). handoff.css is still copied below — Cockpit.ts co-loads it.

const approval = {
  ...sidebar,
  entryPoints: ["src/webview/approval/main.tsx"],
  outfile: "dist/webview/approval.js",
};

// spec 250 — the Preact Plugins View webview bundle (editor-area panel; never imports vscode).

// t-610705 (SDD 410 Phase C.2) — the standalone Probes bundle was retired: it's a Control subroute
// now (src/webview/probes/App.tsx stays, lazy-imported by cockpit/App.tsx via CSS co-load).
// probes.css is still copied below — Cockpit.ts co-loads it.

// t-610705 (SDD 410 Phase B #5) — the standalone Inspector bundle was retired: the tmux Server
// Inspector is a cockpit-only section now (src/webview/inspector/App.tsx stays, lazy-imported by
// cockpit/App.tsx via CSS co-load). inspector.css is still copied below — Cockpit.ts co-loads it.

// t-b5dcae — the Engine/Bridge Control Inspector POC bundle was removed as dead code: its host
// (ControlInspector.ts) had zero importers and its webview app (src/webview/control-inspector/*)
// was only reachable from that host and the dev-preview harness. The real domain logic
// (src/control-inspector/model.ts) survives — Cockpit's own Engine tab uses it directly.

// POC — Tachyon Cockpit desktop shell (editor sysadmin; t-fe52f0 frente 1; no mobile).
// spec 410 — ESM + code-splitting so section bodies can lazy-import without bloating eager cockpit.js.
// emits dist/webview/cockpit.js + dist/webview/chunks/cockpit-*.js
const cockpit = {
  ...sidebar,
  entryPoints: ["src/webview/cockpit/main.tsx"],
  entryNames: "cockpit",
  chunkNames: "chunks/cockpit-[name]-[hash]",
  outdir: "dist/webview",
  splitting: true,
  format: "esm",
};
delete cockpit.outfile;

// spec 279 — the Preact Pin Preview view bundle (converted from inline HTML; read-only, never imports vscode).
const pinPreview = {
  ...sidebar,
  entryPoints: ["src/webview/pin-preview/main.tsx"],
  outfile: "dist/webview/pin-preview.js",
};

// t-610705 (SDD 410 Phase D, D3) — the standalone Pin Studio bundle (spec 255) was retired: Pin
// Studio is a cockpit-only studio route now (src/webview/pin-studio/App.tsx stays, lazy-imported by
// cockpit/App.tsx via CSS co-load, same as command/terminal/runbook/schedule/agent/task before it).
// pin-studio.css is still emitted below — Cockpit.ts co-loads it.

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

// t-610705 (SDD 410 Phase D, D0/D1a/D1b) — the standalone Command/Terminal/Runbook/Schedule/Agent
// Studio (shell) bundles were retired: they're Control routes now (studio-new/studio-edit, studio:
// "command"/"terminal"/"runbook"/"schedule"/"agent" — studios-routes-design.md; cockpit.js
// lazy-imports each shell's App.tsx directly). Each shell's own copyFileSync call below stays
// (Control still co-loads those stylesheets) — only the standalone entry point/bundle is gone.

// spec 349 T10 — first-party plugin surface relay. It mounts the opaque-origin plugin iframe, nonce-stamps
// inline plugin scripts, and relays typed messages to the VS Code host.
const pluginHost = {
  ...sidebar,
  entryPoints: ["src/webview/plugin-host/main.tsx"],
  outfile: "dist/webview/plugin-host.js",
};

// t-610705 (SDD 410 Phase B #6) — the standalone Mission Control bundle was retired: the Board is a
// cockpit-only section (src/webview/mission-control/App.tsx stays, lazy-imported by cockpit/App.tsx
// via CSS co-load). Both mission-control CSS files are still emitted below — Cockpit.ts co-loads them.

// t-610705 (SDD 410 Phase C.1) — the standalone Task Detail bundle was retired: Task Detail is a
// cockpit-only subroute now (src/webview/task-detail/App.tsx stays, lazy-imported by cockpit/App.tsx
// via CSS co-load). task-detail.css is still emitted below — Cockpit.ts co-loads it.

// t-610705 (SDD 410 Phase D, D2) — the standalone Task Studio bundle was retired: Task Studio is a
// cockpit-only studio route now (src/webview/task-studio/App.tsx stays, lazy-imported by
// cockpit/App.tsx via CSS co-load, same as command/terminal/runbook/schedule/agent before it).

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
  { input: "src/webview/agent-studio-shell/tailwind.css", output: "dist/webview/agent-studio-shell.tailwind.css" }, // t-2278bc — KitDropdown for Soul secondary actions
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
// spec 382 — never leave the retired Extension-Host proxy in a reused build directory or VSIX.
rmSync("dist/persistent-bridge-daemon.cjs", { force: true });
rmSync("dist/engine", { recursive: true, force: true });
mkdirSync("dist/engine/media", { recursive: true });
copyFileSync("media/clipboard-copy.sh", "dist/engine/media/clipboard-copy.sh");
buildTailwind();
copyFileSync("src/config/tachyon.schema.json", "dist/tachyon.schema.json");
copyFileSync("node_modules/@vscode/codicons/dist/codicon.css", "dist/webview/codicon.css");
copyFileSync("src/webview/shared/design-system.css", "dist/webview/design-system.css"); // spec 252 — shared webview design system
copyFileSync("src/webview/shared/mermaid-block.css", "dist/webview/mermaid-block.css"); // spec 374 — Mermaid block + read-only nav (Activity/Handoff/Task Detail)
copyFileSync("src/webview/shared/vscode-theme.css", "dist/webview/vscode-theme.css"); // spec 342 — shadcn/vendor token bridge (ONE shared source; see its header)
// spec 345 — Tachyon-owned webview fonts live in their own subtree so KaTeX/Excalidraw can continue owning
// dist/webview/fonts directly without filename collisions or unclear provenance.
rmSync("dist/webview/fonts/tachyon", { recursive: true, force: true });
cpSync("src/webview/shared/fonts/tachyon", "dist/webview/fonts/tachyon", { recursive: true });
copyFileSync("src/webview/sidebar/sidebar.css", "dist/webview/sidebar.css"); // spec 274 — sidebar styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/handoff/handoff.css", "dist/webview/handoff.css"); // spec 280 — handoff styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/approval/approval.css", "dist/webview/approval.css");
copyFileSync("src/webview/validations/validations.css", "dist/webview/validations.css");
copyFileSync("src/webview/rich-doc/rich-doc.css", "dist/webview/rich-doc.css"); // spec 339 — entity-neutral rich-doc editor styles (shared by pin-studio + task-studio + the dev preview harness)
copyFileSync("src/webview/pin-studio/pin-studio.css", "dist/webview/pin-studio.css"); // spec 280 — pin-studio styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/task-studio/task-studio.css", "dist/webview/task-studio.css"); // spec 339 — task-studio styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/mission-control/mission-control.css", "dist/webview/mission-control.css"); // spec 335 — Mission Control board styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/task-detail/task-detail.css", "dist/webview/task-detail.css"); // spec 335 — Task Detail styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/runtime-ops/runtime-ops.css", "dist/webview/runtime-ops.css"); // spec 367 — Runtime Ops bottom-panel styles
copyFileSync("src/webview/plugins/plugins.css", "dist/webview/plugins.css"); // spec 278 — plugins styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/activity/activity.css", "dist/webview/activity.css"); // spec 278 — activity styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/probes/probes.css", "dist/webview/probes.css"); // spec 279 — probes styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/inspector/inspector.css", "dist/webview/inspector.css"); // spec 279 — inspector styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/cockpit/cockpit.css", "dist/webview/cockpit.css"); // Cockpit desktop POC
copyFileSync("src/webview/pin-preview/pin-preview.css", "dist/webview/pin-preview.css"); // spec 279 — pin-preview styles (shared by the webview + the dev preview harness)
copyFileSync("src/webview/shared/studio/studio-frame.css", "dist/webview/studio-frame.css"); // spec 350 — the studio shell's chrome (shared by any studio built on it + the dev preview harness)
copyFileSync("src/webview/pipeline-studio/pipeline-studio.css", "dist/webview/pipeline-studio.css"); // spec 350 T4 — Pipeline Studio (Fake 1) domain-region styles
copyFileSync("src/webview/agent-studio-fixture/agent-studio-fixture.css", "dist/webview/agent-studio-fixture.css"); // spec 350 T5 — Agent-entity fixture (Fake 2) domain-region styles
copyFileSync("src/webview/agent-studio-shell/agent-studio-shell.css", "dist/webview/agent-studio-shell.css"); // spec 350 Phase 3 T3 — Agent Studio (shell) domain-region styles
// t-610705 (Phase D, D0/D1a) — these four studio-shell stylesheets are co-loaded by Control now
// (Cockpit.ts), not a standalone bundle's own entry point; the standalone .js targets are gone.
copyFileSync("src/webview/terminal-studio-shell/terminal-studio-shell.css", "dist/webview/terminal-studio-shell.css");
copyFileSync("src/webview/command-studio-shell/command-studio-shell.css", "dist/webview/command-studio-shell.css");
copyFileSync("src/webview/runbook-studio-shell/runbook-studio-shell.css", "dist/webview/runbook-studio-shell.css");
copyFileSync("src/webview/schedule-studio-shell/schedule-studio-shell.css", "dist/webview/schedule-studio-shell.css");
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

const targets = [extension, toolLauncher, dataResolver, externalResolver, engineDaemon, piBridgeExtension, sidebar, approval, cockpit, pinPreview, pipelineStudio, agentStudioFixture, pluginHost, excalidraw, mermaid, katex, preview, uiGate];
if (watch) {
  const ctxs = await Promise.all(targets.map((c) => esbuild.context(c)));
  await Promise.all(ctxs.map((c) => c.watch()));
} else {
  await Promise.all(targets.map((c) => esbuild.build(c)));
}
