/**
 * 514/515 — the file chooser, and the allowlist that made its first version answer nothing.
 *
 * Two subjects, one file, because they are one failure: the picker rendered "No .zip found in " with
 * nothing after it, and the reason was not the disk — the query had been refused before it ever ran.
 * An empty list and a refused query looked identical on screen, which is the bug worth pinning.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browseForZip, findZipCandidates, zipSearchRoots } from "@tachyon/engine/files/zipPicker.js";
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

describe("browseForZip", () => {
  it("lists folders before archives, alphabetically, and nothing else", () => {
    const root = temp();
    fs.mkdirSync(path.join(root, "zeta"));
    fs.mkdirSync(path.join(root, "alpha"));
    fs.writeFileSync(path.join(root, "b.zip"), "x");
    fs.writeFileSync(path.join(root, "a.zip"), "x");
    fs.writeFileSync(path.join(root, "notes.txt"), "x");
    fs.mkdirSync(path.join(root, ".hidden"));

    const listing = browseForZip(root);
    expect(listing.entries.map((e) => `${e.kind}:${e.name}`))
      .toEqual(["dir:alpha", "dir:zeta", "zip:a.zip", "zip:b.zip"]);
    expect(listing.parent).toBe(path.dirname(root));
  });

  it("says WHY it is empty when a folder cannot be read — 'nothing here' is a different fact", () => {
    const listing = browseForZip(path.join(temp(), "does-not-exist"));
    expect(listing.entries).toEqual([]);
    expect(listing.error).toMatch(/ENOENT|no such file/i);
  });

  it("has no parent at the filesystem root, so the picker draws no way up from there", () => {
    expect(browseForZip("/").parent).toBeUndefined();
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

/**
 * 514 — the candidate set OUR picker filters, instead of the editor's file dialog.
 *
 * The scan is deliberately not a filesystem browser: it is bounded in depth and count, skips the trees
 * every project carries, and orders newest-first because the archive someone just built is the one they
 * mean. What it must never do is hang or explode on a real machine, which is what these pin.
 */
describe("findZipCandidates", () => {
  it("finds archives across roots, newest first, and ignores everything that is not a zip", () => {
    const root = temp();
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(root, "a", "old.zip"), "x");
    fs.writeFileSync(path.join(root, "a", "b", "new.zip"), "x");
    fs.writeFileSync(path.join(root, "a", "notes.txt"), "x");
    fs.utimesSync(path.join(root, "a", "old.zip"), new Date("2026-01-01"), new Date("2026-01-01"));
    fs.utimesSync(path.join(root, "a", "b", "new.zip"), new Date("2026-08-01"), new Date("2026-08-01"));

    const found = findZipCandidates([root]);
    expect(found.map((c) => c.name)).toEqual(["new.zip", "old.zip"]);
    expect(found[0]!.dir).toBe(path.join(root, "a", "b"));
  });

  it("skips the noisy trees and stops at the depth cap, so a big checkout cannot stall the picker", () => {
    const root = temp();
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "vendored.zip"), "x");
    const deep = path.join(root, "1", "2", "3", "4", "5", "6", "7");
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, "buried.zip"), "x");

    const names = findZipCandidates([root]).map((c) => c.name);
    expect(names).not.toContain("vendored.zip");
    expect(names).not.toContain("buried.zip");
  });

  it("survives a symlink loop — a hang here is a picker that never opens", () => {
    const root = temp();
    fs.mkdirSync(path.join(root, "here"), { recursive: true });
    fs.writeFileSync(path.join(root, "here", "app.zip"), "x");
    fs.symlinkSync(root, path.join(root, "here", "back"));
    expect(findZipCandidates([root]).map((c) => c.name)).toEqual(["app.zip"]);
  });

  it("names the places it looked, because an empty picker has to say where it searched", () => {
    const roots = zipSearchRoots("/ws", "/home/someone", "/tmp");
    expect(roots).toEqual(["/ws", "/home/someone/Downloads", "/home/someone/Desktop", "/tmp"]);
  });
});
