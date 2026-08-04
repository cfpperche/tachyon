#!/usr/bin/env node
/**
 * t-icon — materialize an editor-tab icon under `media/icons/{light,dark}/<name>.svg` from the
 * `@vscode/codicons` source of record.
 *
 * Why a script rather than "copy the file and edit it by hand": `WebviewPanel.iconPath` accepts only a
 * Uri, so the SVG is rendered LITERALLY with no theme context — `fill="currentColor"` collapses to
 * near-black and vanishes on a dark theme (`panelIcon.ts` records the finding). The two hex values below
 * are the substitution that makes a codicon usable as a tab icon, and doing it by hand is how you get a
 * pair that disagrees.
 *
 * Usage (from the repo root):
 *   node scripts/panel-icon.mjs graph inbox dashboard
 *
 * `panelTabIcons.test.ts` fails when a name the product declares has no pair on disk, and names this
 * script in the failure. That is the loop: the test says what is missing, this writes it.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

/** The two colors VS Code uses for its own product icons — a dark fill for light themes, and back. */
const THEME_FILL = { light: "#424242", dark: "#C5C5C5" };

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("usage: node scripts/panel-icon.mjs <codicon-name>...");
  process.exit(2);
}

let wrote = 0;
for (const name of names) {
  const src = `node_modules/@vscode/codicons/src/icons/${name}.svg`;
  if (!existsSync(src)) {
    console.error(`no such codicon: ${name} (looked in ${src})`);
    process.exit(1);
  }
  const svg = readFileSync(src, "utf8");
  if (!svg.includes('fill="currentColor"')) {
    // Every codicon carries exactly one root `fill="currentColor"`. If one ever does not, a silent copy
    // would ship an icon that is invisible on one of the two themes — the failure this file exists for.
    console.error(`${name}: no root fill="currentColor" to substitute — inspect ${src} by hand`);
    process.exit(1);
  }
  for (const [theme, fill] of Object.entries(THEME_FILL)) {
    const out = `media/icons/${theme}/${name}.svg`;
    writeFileSync(out, svg.replace('fill="currentColor"', `fill="${fill}"`));
    console.log(`wrote ${out}`);
    wrote++;
  }
}
console.log(`${wrote} file(s) from @vscode/codicons`);
