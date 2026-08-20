import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * t-ad4e9d — textual reachability guard for the Control strings catalog.
 *
 * Method: collect the keys declared as direct properties in `cockpitStrings()` and require a
 * `.key` textual reference in a rendered webview app source file. This deliberately does not claim
 * semantic reachability: destructuring (`const { key } = strings`) and dynamic access
 * (`strings[name]`) escape it, while a `.key` mention in dead code or a comment can satisfy it.
 * Keep those limits explicit if the catalog's access style changes.
 */

const root = path.resolve(__dirname, "../..");
const catalogPath = path.join(root, "apps/vscode-extension/src/webview/controlStrings.ts");
const appRoot = path.join(root, "packages/webview-ui/src/webview");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.[cm]?tsx?$/.test(entry.name) ? [absolute] : [];
  });
}

describe("t-ad4e9d — Control strings reach rendered apps", () => {
  it("does not declare catalog keys with no textual property reference in an app", () => {
    const catalog = fs.readFileSync(catalogPath, "utf8");
    const declared = [...catalog.matchAll(/^\s{4}([A-Za-z_$][\w$]*):\s*t\(/gm)].map((match) => match[1]);
    const appSources = sourceFiles(appRoot)
      .filter((file) => file !== path.join(appRoot, "shared/control/messages.ts"))
      .map((file) => fs.readFileSync(file, "utf8"));

    const unreferenced = declared.filter((key) => {
      const propertyReference = new RegExp(`\\.${key}\\b`);
      return !appSources.some((source) => propertyReference.test(source));
    });

    expect(unreferenced).toEqual([]);
  });
});
