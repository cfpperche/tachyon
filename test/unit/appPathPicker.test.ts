/**
 * 514 — the file chooser, and the allowlist that made its first version answer nothing.
 *
 * Two subjects, one file, because they are one failure: the picker rendered "No .zip found in " with
 * nothing after it, and the reason was not the disk — the query had been refused before it ever ran.
 * An empty list and a refused query looked identical on screen, which is the bug worth pinning.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browseForAppZip } from "@tachyon/engine/apps/index.js";
import { EXTENSION_COMMAND_ACTIONS, EXTENSION_QUERY_ACTIONS, extensionCommandSchema, extensionQuerySchema } from "@tachyon/engine/runtime-api/extensionOperations.js";
import { breadcrumbSegments, looksLikePath } from "@tachyon/webview-ui/webview/shared/ui/pathPickerModel";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function temp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-picker-"));
  made.push(dir);
  return dir;
}

/** Every `action` literal a union accepts, read out of the schema rather than hand-listed. */
function actionsInUnion(schema: { options: readonly unknown[] }): string[] {
  const out: string[] = [];
  for (const option of schema.options) {
    const shape = (option as { shape?: { action?: { value?: unknown } } }).shape;
    const literal = shape?.action?.value;
    if (typeof literal === "string" && !out.includes(literal)) out.push(literal);
  }
  return out.sort();
}

describe("every action is in the allowlist its RESULT is validated against", () => {
  // BOTH halves, and that is the point. `apps.list` and `apps.zip-candidates` shipped in the query
  // union and not in its list; `app.install` shipped in the command union and not in ITS list. The
  // request parses, the engine answers, and the response is refused on the way back — which reaches
  // the human as "extension command result is invalid", or worse, as an empty catalog.
  //
  // The first version of this test checked queries only, so the command half shipped broken behind a
  // green suite. A guard that covers one of two symmetric lists is a guard that teaches the wrong
  // lesson about which one is safe.
  it("queries: no action parses on the way in and is refused on the way out", () => {
    const declared = new Set<string>(EXTENSION_QUERY_ACTIONS);
    expect(actionsInUnion(extensionQuerySchema).filter((action) => !declared.has(action))).toEqual([]);
  });

  it("commands: no action parses on the way in and is refused on the way out", () => {
    const declared = new Set<string>(EXTENSION_COMMAND_ACTIONS);
    expect(actionsInUnion(extensionCommandSchema).filter((action) => !declared.has(action))).toEqual([]);
  });
});

describe("browseForAppZip", () => {
  it("lists folders before archives, alphabetically, and nothing else", () => {
    const root = temp();
    fs.mkdirSync(path.join(root, "zeta"));
    fs.mkdirSync(path.join(root, "alpha"));
    fs.writeFileSync(path.join(root, "b.zip"), "x");
    fs.writeFileSync(path.join(root, "a.zip"), "x");
    fs.writeFileSync(path.join(root, "notes.txt"), "x");
    fs.mkdirSync(path.join(root, ".hidden"));

    const listing = browseForAppZip(root);
    expect(listing.entries.map((e) => `${e.kind}:${e.name}`))
      .toEqual(["dir:alpha", "dir:zeta", "zip:a.zip", "zip:b.zip"]);
    expect(listing.parent).toBe(path.dirname(root));
  });

  it("says WHY it is empty when a folder cannot be read — 'nothing here' is a different fact", () => {
    const listing = browseForAppZip(path.join(temp(), "does-not-exist"));
    expect(listing.entries).toEqual([]);
    expect(listing.error).toMatch(/ENOENT|no such file/i);
  });

  it("has no parent at the filesystem root, so the picker draws no way up from there", () => {
    expect(browseForAppZip("/").parent).toBeUndefined();
  });
});

describe("the picker's two reading rules", () => {
  it("breadcrumbs name every level with the path that reaches it", () => {
    expect(breadcrumbSegments("/home/goat/tachyon")).toEqual([
      { label: "/", path: "/" },
      { label: "home", path: "/home" },
      { label: "goat", path: "/home/goat" },
      { label: "tachyon", path: "/home/goat/tachyon" },
    ]);
  });

  it("treats a typed value as a PATH only when it looks like one", () => {
    // The filter box is also the address bar; the rule that separates them is the user's own typing.
    expect(looksLikePath("/tmp/apps")).toBe(true);
    expect(looksLikePath("~/Downloads")).toBe(true);
    expect(looksLikePath("hello")).toBe(false);
    expect(looksLikePath("")).toBe(false);
  });
});
