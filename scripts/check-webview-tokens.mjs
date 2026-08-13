#!/usr/bin/env node
/**
 * t-c8e2bd — raw hex colors and numeric z-index in src/webview/ stop passing in silence.
 *
 * The design system already exists (`src/webview/shared/design-system.css`). This gate is the
 * thing that refuses a new loose value. Existing debt is listed below, each row with a reason;
 * a new distinct hex or a new numeric z-index in an excepted file still fails. Paying a value
 * down means deleting it from the list — a stale row fails the same way an anonymous one does.
 *
 * Hex inside design-system.css is the allowed token source. Missing a token for a color that
 * new code needs means ADDING it there, not adding an exception here. Exception is for what
 * already shipped, not for what is written next.
 *
 * t-ba41a8 — `design-mode-overlay/` is scanned like every other directory. t-f5b467 landed
 * (hex = 0). Leftover numeric z-index is excepted per file with a reason; it is not a skip.
 *
 * One implementation. `scripts/verify-full.mjs` runs it as a static gate;
 * `test/unit/webviewTokenLint.test.ts` imports the same functions.
 *
 * Run directly: `node scripts/check-webview-tokens.mjs`
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SCAN_ROOT = "src/webview";
export const TOKEN_SOURCE = "src/webview/shared/design-system.css";
export const EXTENSIONS = Object.freeze([".css", ".ts", ".tsx", ".js", ".jsx", ".mjs"]);
export const MIN_REASON = 20;

/**
 * Each row is one file's existing hex literals and WHY they are still here.
 * Values are lowercase as they appear (or fold to lowercase). A new distinct
 * value in the same file is a violation. A listed value that is gone is stale.
 */
export const HEX_EXCEPTIONS = Object.freeze([
  {
    file: "src/webview/activity/activity.css",
    values: [
      "#000", "#0000ff", "#008000", "#0451a5", "#098658", "#1e1e1e", "#267f99",
      "#4daafc", "#4ec97e", "#4ec9b0", "#569cd6", "#6a9955", "#795e26", "#9cdcfe",
      "#a31515", "#af00db", "#b5cea8", "#c586c0", "#cca700", "#ce9178", "#d4d4d4",
      "#dcdcaa", "#f08080", "#f3f3f3", "#fff",
    ],
    reason: "Activity markdown: highlight.js Dark+/Light+ syntax colors have no --ds syntax roles, plus vscode-var fallbacks, mask black, and a lightbox close glyph.",
  },
  {
    file: "src/webview/agent-pane/App.tsx",
    values: [
      "#000000", "#0dbc79", "#11a8cd", "#1e1e1e", "#23d18b", "#2472c8", "#264f78",
      "#29b8db", "#3b8eea", "#4ec9b0", "#569cd6", "#666666", "#aeafad", "#bc3fbc",
      "#c586c0", "#cccccc", "#cd3131", "#d670d6", "#e5e510", "#e5e5e5", "#f14c4c",
      "#f5f543",
    ],
    reason: "xterm.js ANSI 16-color palette plus inject-mark colors; terminal cells are not product chrome and have no --ds equivalent.",
  },
  {
    file: "src/webview/agent-pane/agent-pane.css",
    values: [
      "#007fd4", "#0e639c", "#1e1e1e", "#3794ff", "#3a3d41", "#3c3c3c", "#4ec9b0",
      "#858585", "#cca700", "#cccccc", "#ffffff",
    ],
    reason: "Agent pane cannot load design-system.css (Tachyon Mono breaks xterm metrics); vscode-var fallbacks plus two raw stage-mark teals.",
  },
  {
    file: "src/webview/agent-studio-shell/runtimeLogos.tsx",
    values: ["#005af0", "#09090b", "#14b014", "#6950ef", "#8e75b2", "#d97757", "#fff"],
    reason: "Third-party runtime logo SVG fills (Claude/Codex/Gemini/Grok/OpenCode/Pi artwork), not product chrome.",
  },
  {
    file: "src/webview/board/board.css",
    values: ["#0e70c0"],
    reason: "Accent fallback on the selected-column rule; replace with --ds-accent when the board chrome is next restyled.",
  },
  {
    file: "src/webview/handoff/handoff.css",
    values: ["#1e1e1e", "#4daafc"],
    reason: "Task-checkbox vscode-var fallbacks predating the shared --ds-link / editor-bg tokens on this sheet.",
  },
  {
    file: "src/webview/human-inbox/human-inbox.css",
    values: ["#fff"],
    reason: "QR/image plate background so a dark-on-dark code does not vanish; no --ds inverted-plate token yet — add one to the DS rather than keep extending this.",
  },
  {
    file: "src/webview/ide-browser-bridge/themeTokens.ts",
    values: [
      "#006ab1", "#0078d4", "#007fd4", "#0090f1", "#026ec1", "#0e639c", "#1177bb",
      "#1a85ff", "#1e1e1e", "#252526", "#3794ff", "#388a34", "#3b3b3b", "#3c3c3c",
      "#6c6c6c", "#75beff", "#89d185", "#9d9d9d", "#a1260d", "#bf8803", "#cca700",
      "#cccccc", "#f14c4c", "#f3f3f3", "#fff", "#ffffff",
    ],
    reason: "Host-side vscode-var pick() defaults plus the light/dark tables used when the IDE browser has no theme payload. Not surface CSS; shrink by reading --ds-* once the overlay cutover lands.",
  },
  {
    file: "src/webview/pin-preview/pin-preview.css",
    values: ["#fff"],
    reason: "Sketch-image plate so a transparent PNG does not sit on the editor background; same inverted-plate gap as human-inbox.",
  },
  {
    file: "src/webview/pin-studio/excalidraw-entry.tsx",
    values: ["#ffffff"],
    reason: "Excalidraw export/view default canvas; the vendor scene expects a literal page color, not a --ds token.",
  },
  {
    file: "src/webview/plugins/plugins.css",
    values: ["#fff"],
    reason: "Danger-segment label on --ds-err; should be --ds-btn-fg (or a --ds-on-err token) when this sheet is next touched.",
  },
  {
    file: "src/webview/probes/probes.css",
    values: ["#3fb950", "#4daafc", "#f85149"],
    reason: "vscode testing-icon / charts fallbacks for pass/fail/run counts; map to --ds-ok/--ds-err/--ds-info instead of new literals.",
  },
  {
    file: "src/webview/rich-doc/rich-doc.css",
    values: ["#fff"],
    reason: "Sketch-node plate, same inverted-plate gap as pin-preview; add a DS token rather than another local #fff.",
  },
  {
    file: "src/webview/runtime-config/runtime-config.css",
    values: ["#000", "#cca700"],
    reason: "Shadow mix uses raw black; warning rail uses a vscode-var fallback. Both have --ds-shadow / --ds-warn replacements.",
  },
  {
    file: "src/webview/settings/settings.css",
    values: ["#0002", "#007fd4", "#3ba55d", "#444", "#4443", "#888", "#cca700", "#f14c4c", "#fff"],
    reason: "Settings still carries vscode-var fallbacks and 4-digit alpha hex (#4443/#0002) from the card-template preview; QR plate is the inverted-plate #fff.",
  },
  {
    file: "src/webview/shared/ErrorBoundary.tsx",
    values: ["#5a1d1d", "#a1260d", "#fff"],
    reason: "Inline crash-plate vscode-var fallbacks so a render error stays readable even if the DS sheet failed to load.",
  },
  {
    file: "src/webview/shared/control/CardTemplateBlock.tsx",
    values: ["#4443"],
    reason: "Preview-frame border fallback copied from settings.css's 4-digit panel-border hex; same debt, same replacement (--ds-border).",
  },
  {
    file: "src/webview/shared/engine-workspace.css",
    values: ["#3794ff"],
    reason: "Focus-mix fallback on a workspace chip; --ds-focus is the replacement.",
  },
  {
    file: "src/webview/shared/mermaid-block.css",
    values: ["#007fd4"],
    reason: "Focus-ring vscode-var fallback around the mermaid viewport; --ds-focus is the replacement.",
  },
  {
    file: "src/webview/shared/quick-picker.css",
    values: ["#000", "#1e1e1e"],
    reason: "Font-free picker sheet (cannot load design-system.css) restates the --ds-scrim mix and a dialog fallback hex.",
  },
  {
    file: "src/webview/shared/vscode-theme.css",
    values: ["#007fd4", "#0e639c", "#1e1e1e", "#cccccc", "#f14c4c", "#ffffff"],
    reason: "spec 342 shadcn token-bridge: every chain bottoms out in a literal so a missing vscode theme still renders. Not product chrome; do not add new literals here without a matching --ds token.",
  },
  {
    file: "src/webview/sidebar/sidebar.css",
    values: ["#4fc1ff", "#858585", "#8a8a8a", "#c586c0", "#c8c8c8", "#cca700", "#dcdcaa", "#f14c4c", "#fff"],
    reason: "Sidebar chrome still uses vscode-var fallbacks plus raw peek/focus-source syntax colors (blue/purple/yellow) with no --ds syntax roles.",
  },
]);

/**
 * Numeric z-index already on disk. New numbers fail even if they happen to match
 * a declared --ds-z-* value — the scale is the token name, not the integer.
 */
export const Z_INDEX_EXCEPTIONS = Object.freeze([
  {
    file: "src/webview/activity/activity.css",
    values: [2, 5, 20, 30, 50],
    reason: "Sticky chrome (2), jump chip (5), share menu (20), type menu (30), lightbox (50) predate --ds-z-popover/--ds-z-toast; replace with those tokens when this sheet is next touched.",
  },
  {
    file: "src/webview/board/board.css",
    values: [40],
    reason: "Menu backdrop sits at the dialog layer but uses the raw 40 instead of --ds-z-dialog.",
  },
  {
    file: "src/webview/handoff/handoff.css",
    values: [2],
    reason: "Sticky header local stacking; --ds-z-popover is the named replacement when the sheet is next touched.",
  },
  {
    file: "src/webview/plugins/plugins.css",
    values: [20, 30],
    reason: "Consent scrim (20) and busy toast (30) predate --ds-z-dialog / --ds-z-toast.",
  },
  {
    file: "src/webview/rich-doc/rich-doc.css",
    values: [3, 5, 20],
    reason: "Toolbar (3), slash menu (5), sketch modal (20) are local stacking; modal should be --ds-z-dialog, the rest --ds-z-popover or a documented local layer.",
  },
  {
    file: "src/webview/runtime-config/runtime-config.css",
    values: [100],
    reason: "Runtime picker popover used 100 — above every declared token. Next touch should be --ds-z-popover or --ds-z-overlay, not another integer.",
  },
  {
    file: "src/webview/shared/studio/studio-frame.css",
    values: [3],
    reason: "Sticky studio header local stacking; same 3 as task-detail / rich-doc toolbars.",
  },
  {
    file: "src/webview/sidebar/sidebar.css",
    values: [2, 30, 40],
    reason: "Row actions (2), command palette (30), menu backdrop (40) predate the --ds-z-* names.",
  },
  {
    file: "src/webview/task-detail/task-detail.css",
    values: [2, 3],
    reason: "Prototype watermark (2) and header (3) local stacking, copied into task-studio.",
  },
  {
    file: "src/webview/task-studio/task-studio.css",
    values: [2, 3],
    reason: "Same prototype watermark/header pair as task-detail; keep the two lists in lockstep until both use tokens.",
  },
  {
    file: "src/webview/design-mode-overlay/App.tsx",
    values: [1, 2],
    reason: "Local stacking inside the overlay shadow (markup editor = 1, panel/badges = 2). --ds-z-popover is 20 and names product chrome, not an internal 1; using it here would be a lie.",
  },
  {
    file: "src/webview/design-mode-overlay/App.tsx",
    values: [2147483646],
    reason: "Hover outline (#tachyon-dm-root). After t-f5b467 this node lives in the shadow; the integer is leftover page-max from when it competed in the light DOM. Product --ds-z-* (20/40/50/60) cannot name that layer.",
  },
  {
    file: "src/webview/design-mode-overlay/styles.ts",
    values: [3],
    reason: "Markup-active editor is raised above the shadow chrome (1/2) with a local 3. Same case as App.tsx 1/2: not a product popover/dialog/toast/overlay.",
  },
  {
    file: "src/webview/design-mode-overlay/styles.ts",
    values: [2147483647],
    reason: ":host stacks above the entire third-party page. The product --ds-z-* scale describes our chrome, not a page we do not control.",
  },
  {
    file: "src/webview/design-mode-overlay/main.tsx",
    values: [2147483647],
    reason: "host.style.zIndex assignment — the second door of the same :host layer (styles.ts). Still the third-party page, still not a --ds-z-* token.",
  },
]);

const HEX_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
const Z_CSS_RE = /z-index\s*:\s*([^;}\n]+)/gi;
const Z_JS_RE = /\bzIndex\s*:\s*([^,}\n]+)/g;
const Z_ASSIGN_RE = /\.zIndex\s*=\s*(?:["'](\d[\d_]*)["']|(\d[\d_]*))/g;

export function maskComments(src, ext) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const two = src.slice(i, i + 2);
    if (two === "//" && ext !== ".css") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (two === "/*") {
      out += "  ";
      i += 2;
      while (i < n && src.slice(i, i + 2) !== "*/") {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    out += src[i];
    i++;
  }
  return out;
}

function lineOf(src, idx) {
  let line = 1;
  for (let i = 0; i < idx; i++) if (src[i] === "\n") line++;
  return line;
}

export function findHexLiterals(src, ext = ".css") {
  const code = maskComments(src, ext);
  const hits = [];
  HEX_RE.lastIndex = 0;
  let m;
  while ((m = HEX_RE.exec(code))) {
    hits.push({ line: lineOf(src, m.index), value: m[0].toLowerCase() });
  }
  return hits;
}

function parseNumericZ(raw) {
  const t = raw.trim();
  if (/^var\(\s*--ds-z-[\w-]+/.test(t)) return null;
  const num = t.match(/^(\d[\d_]*)\b/);
  if (!num) return null;
  return Number(num[1].replace(/_/g, ""));
}

export function findNumericZIndex(src, ext = ".css") {
  const code = maskComments(src, ext);
  const hits = [];
  for (const re of [Z_CSS_RE, Z_JS_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code))) {
      const value = parseNumericZ(m[1]);
      if (value === null) continue;
      hits.push({ line: lineOf(src, m.index), value });
    }
  }
  // t-ba41a8 — `el.style.zIndex = "2147483647"` is the same numeric door as `zIndex:`.
  // A scanner that only reads the property form lets the host assignment stay silent.
  Z_ASSIGN_RE.lastIndex = 0;
  let assign;
  while ((assign = Z_ASSIGN_RE.exec(code))) {
    const raw = assign[1] ?? assign[2];
    hits.push({ line: lineOf(src, assign.index), value: Number(raw.replace(/_/g, "")) });
  }
  return hits;
}

/** `--ds-z-*` integers declared on :root in the token file. */
export function declaredZScale(tokenCss) {
  const scale = new Map();
  const root = tokenCss.match(/:root\s*\{([\s\S]*?)\n\}/);
  const body = root ? root[1] : tokenCss;
  const re = /--ds-z-([\w-]+)\s*:\s*(\d+)\s*;/g;
  let m;
  while ((m = re.exec(body))) scale.set(`--ds-z-${m[1]}`, Number(m[2]));
  return scale;
}

export function sourceFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules") continue;
      sourceFiles(full, acc);
    } else if (e.isFile() && EXTENSIONS.includes(path.extname(e.name))) {
      acc.push(full);
    }
  }
  return acc;
}

function hexKey(v) {
  return String(v).toLowerCase();
}

function zKey(v) {
  return Number(v);
}

function evaluateKind(hits, exceptions, kind) {
  const byFile = new Map();
  for (const h of hits) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file).push(h);
  }
  const excByFile = new Map();
  const violations = [];
  for (const row of exceptions) {
    if (typeof row.reason !== "string" || row.reason.trim().length < MIN_REASON) {
      violations.push({
        kind: "anonymous-exception",
        rule: kind,
        file: row.file,
        message: `${row.file}: ${kind} exception has no written reason (min ${MIN_REASON} chars)`,
      });
    }
    if (!excByFile.has(row.file)) excByFile.set(row.file, new Set());
    const set = excByFile.get(row.file);
    for (const v of row.values) set.add(kind === "hex" ? hexKey(v) : zKey(v));
  }

  for (const [file, fileHits] of byFile) {
    const allowed = excByFile.get(file) ?? new Set();
    const found = new Set(fileHits.map((h) => (kind === "hex" ? hexKey(h.value) : zKey(h.value))));
    for (const value of found) {
      if (!allowed.has(value)) {
        const where = fileHits
          .filter((h) => (kind === "hex" ? hexKey(h.value) : zKey(h.value)) === value)
          .map((h) => `${h.line}`)
          .slice(0, 4)
          .join(", ");
        violations.push({
          kind: "new-value",
          rule: kind,
          file,
          value,
          message: `${file}:${where} — ${kind} ${value} is not in the declared exception list`,
        });
      }
    }
    for (const value of allowed) {
      if (!found.has(value)) {
        violations.push({
          kind: "stale-exception",
          rule: kind,
          file,
          value,
          message: `${file} — ${kind} exception ${value} is gone; delete it from the list so the debt shrinks`,
        });
      }
    }
  }

  for (const [file, allowed] of excByFile) {
    if (byFile.has(file)) continue;
    for (const value of allowed) {
      violations.push({
        kind: "stale-exception",
        rule: kind,
        file,
        value,
        message: `${file} — ${kind} exception ${value} is gone; delete it from the list so the debt shrinks`,
      });
    }
  }
  return violations;
}

export function scanRepo(root = ROOT) {
  const tokenRel = TOKEN_SOURCE;
  const files = sourceFiles(path.join(root, SCAN_ROOT));
  const hexHits = [];
  const zHits = [];
  for (const full of files) {
    const rel = path.relative(root, full).split(path.sep).join("/");
    const ext = path.extname(full);
    const src = fs.readFileSync(full, "utf8");
    if (rel !== tokenRel) {
      for (const h of findHexLiterals(src, ext)) hexHits.push({ file: rel, ...h });
    }
    for (const h of findNumericZIndex(src, ext)) zHits.push({ file: rel, ...h });
  }
  return [
    ...evaluateKind(hexHits, HEX_EXCEPTIONS, "hex"),
    ...evaluateKind(zHits, Z_INDEX_EXCEPTIONS, "z-index"),
  ];
}

export const FIX_HINT =
  "New hex belongs in src/webview/shared/design-system.css as a --ds-* token, not as a literal and not as an exception. " +
  "New stacking belongs on --ds-z-popover / --ds-z-dialog / --ds-z-toast / --ds-z-overlay. " +
  "Exceptions are only for values that already shipped — each row needs its own reason.";

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = scanRepo();
  if (violations.length > 0) {
    process.stderr.write(`check:webview-tokens — ${violations.length} violation(s):\n`);
    for (const v of violations) process.stderr.write(`  ${v.message}\n`);
    process.stderr.write(`\n${FIX_HINT}\n`);
    process.exit(1);
  }
  process.stdout.write("check:webview-tokens ok\n");
}
