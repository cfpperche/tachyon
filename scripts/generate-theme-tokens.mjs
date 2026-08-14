import { readFileSync, writeFileSync } from "node:fs";

const cssPath = "src/webview/shared/tokens.css";
const tsPath = "src/webview/ide-browser-bridge/themeTokens.ts";
const start = "// BEGIN GENERATED TOKEN DEFINITIONS — do not edit; run npm run generate:theme-tokens\n";
const end = "// END GENERATED TOKEN DEFINITIONS\n";

export function extractRootTokens(css) {
  const roots = [...css.matchAll(/:root\s*\{([\s\S]*?)\n\}/g)];
  if (roots.length !== 1) throw new Error(`${cssPath}: expected exactly one :root block, found ${roots.length}`);
  const root = roots[0]?.[1];
  if (!root) throw new Error(`${cssPath}: expected one :root block`);
  const outside = css.replace(roots[0][0], "").replace(/\/\*[\s\S]*?\*\//g, "");
  if (/(--(?:ds|tachyon)-[\w-]+)\s*:/.test(outside)) throw new Error(`${cssPath}: token declaration outside :root`);
  const clean = root.replace(/\/\*[\s\S]*?\*\//g, "");
  return Object.fromEntries(clean.split(";").flatMap((part) => {
    const match = part.match(/(--(?:ds|tachyon)-[\w-]+)\s*:\s*([^;]+)\s*$/);
    return match ? [[match[1], match[2].trim()]] : [];
  }));
}

export function generatedBlock(css) {
  const json = JSON.stringify(extractRootTokens(css), null, 2);
  return `${start}export const TOKEN_DEFINITIONS = ${json} as const;\n${end}`;
}

const current = readFileSync(tsPath, "utf8");
const first = current.indexOf(start);
const last = current.indexOf(end, first);
if (first < 0 || last < 0) throw new Error(`${tsPath}: generated markers are missing`);
const expected = current.slice(0, first) + generatedBlock(readFileSync(cssPath, "utf8")) + current.slice(last + end.length);
if (process.argv.includes("--check")) {
  if (expected !== current) {
    console.error(`${tsPath} is stale; run npm run generate:theme-tokens`);
    process.exitCode = 1;
  }
} else {
  writeFileSync(tsPath, expected);
}
