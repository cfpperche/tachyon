import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import {
  installAppZip,
  readInstalledApps,
  validateAppManifest,
  uninstallApp,
} from "@tachyon/engine/apps/index.js";

const roots: string[] = [];

function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-apps-test-"));
  roots.push(root);
  return root;
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "hello-world", title: "Hello world", icon: "icon.svg", entry: "index.html", ...overrides };
}

function writeApp(root: string, directory: string, value: unknown): void {
  const appRoot = path.join(root, ".tachyon", "apps", directory);
  fs.mkdirSync(appRoot, { recursive: true });
  fs.writeFileSync(path.join(appRoot, "app.json"), typeof value === "string" ? value : JSON.stringify(value));
  fs.writeFileSync(path.join(appRoot, "index.html"), "<h1>Hello</h1>");
  fs.writeFileSync(path.join(appRoot, "icon.svg"), "<svg/>");
}

async function zipAt(root: string, entries: Record<string, string>): Promise<string> {
  const zip = new JSZip();
  for (const [name, contents] of Object.entries(entries)) zip.file(name, contents);
  const file = path.join(root, "app.zip");
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  return file;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("app.json validation", () => {
  it.each([
    ["id", { id: "Not Kebab" }],
    ["title", { title: "" }],
    ["icon", { icon: "../icon.svg" }],
    ["entry", { entry: "/index.html" }],
  ])("names the invalid %s field", (field, override) => {
    const root = temp();
    fs.writeFileSync(path.join(root, "index.html"), "ok");
    const result = validateAppManifest(root, manifest(override));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain(`${field}:`);
  });

  it("names entry when the declared file does not exist", () => {
    const result = validateAppManifest(temp(), manifest());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("entry:");
  });
});

describe("installed app catalog", () => {
  it("keeps valid apps when a sibling app.json is corrupt", () => {
    const root = temp();
    writeApp(root, "good", manifest());
    writeApp(root, "broken", "{ definitely not json");

    const result = readInstalledApps(root);
    expect(result.apps.map((app) => app.id)).toEqual(["hello-world"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("broken");
  });

  it("reports an unreadable catalog path instead of throwing", () => {
    const root = temp();
    fs.mkdirSync(path.join(root, ".tachyon"), { recursive: true });
    fs.writeFileSync(path.join(root, ".tachyon", "apps"), "not a directory");
    expect(readInstalledApps(root)).toMatchObject({ apps: [], warnings: [expect.stringContaining("apps")] });
  });
});

describe("zip installation", () => {
  it("installs a valid zip and replaces the same id", async () => {
    const root = temp();
    const first = await zipAt(root, {
      "app.json": JSON.stringify(manifest()), "index.html": "first", "icon.svg": "<svg/>", "obsolete.txt": "old",
    });
    await installAppZip(root, first);
    expect(fs.readFileSync(path.join(root, ".tachyon/apps/hello-world/index.html"), "utf8")).toBe("first");

    const second = await zipAt(root, {
      "app.json": JSON.stringify(manifest({ title: "Updated" })), "index.html": "second", "icon.svg": "<svg/>",
    });
    const installed = await installAppZip(root, second);
    expect(installed.title).toBe("Updated");
    expect(fs.readFileSync(path.join(root, ".tachyon/apps/hello-world/index.html"), "utf8")).toBe("second");
    expect(fs.existsSync(path.join(root, ".tachyon/apps/hello-world/obsolete.txt"))).toBe(false);
  });

  it.each([
    ["missing app.json", { "index.html": "ok", "icon.svg": "<svg/>" }],
    ["corrupt app.json", { "app.json": "{bad", "index.html": "ok", "icon.svg": "<svg/>" }],
    ["missing entry", { "app.json": JSON.stringify(manifest()), "icon.svg": "<svg/>" }],
  ])("rejects %s without leaving an installed or temporary directory", async (_label, entries) => {
    const root = temp();
    const zip = await zipAt(root, entries);
    await expect(installAppZip(root, zip)).rejects.toThrow();
    const apps = path.join(root, ".tachyon", "apps");
    expect(fs.existsSync(path.join(apps, "hello-world"))).toBe(false);
    expect(fs.existsSync(apps) ? fs.readdirSync(apps) : []).toEqual([]);
  });

  it("keeps the previous app intact when a reinstall is invalid", async () => {
    const root = temp();
    const valid = await zipAt(root, {
      "app.json": JSON.stringify(manifest()), "index.html": "original", "icon.svg": "<svg/>",
    });
    await installAppZip(root, valid);
    const invalid = await zipAt(root, {
      "app.json": JSON.stringify(manifest()), "icon.svg": "<svg/>",
    });

    await expect(installAppZip(root, invalid)).rejects.toThrow(/entry:/);
    expect(fs.readFileSync(path.join(root, ".tachyon/apps/hello-world/index.html"), "utf8")).toBe("original");
  });

  it("rejects traversal without writing outside the temporary app directory", async () => {
    const root = temp();
    const zip = await zipAt(root, {
      "app.json": JSON.stringify(manifest()), "index.html": "ok", "icon.svg": "<svg/>", "../escape.txt": "escaped",
    });
    await expect(installAppZip(root, zip)).rejects.toThrow(/path/i);
    expect(fs.existsSync(path.join(root, ".tachyon", "escape.txt"))).toBe(false);
    expect(fs.existsSync(path.join(root, "escape.txt"))).toBe(false);
  });
});

/**
 * 514 — actions an app declares for its own tile.
 *
 * The validation rule is the same one every other field here follows: an error NAMES the field, and a
 * malformed block fails the app rather than being dropped. A tile that quietly lost its actions is
 * indistinguishable from an app that declared none, and that is the failure mode worth refusing.
 */
describe("declared tile actions", () => {
  it("accepts a well-formed list and defaults to none", () => {
    const root = temp();
    fs.writeFileSync(path.join(root, "index.html"), "<h1>x</h1>");
    const withActions = validateAppManifest(root, {
      ...manifest(),
      actions: [{ id: "refresh", label: "Refresh", icon: "sync" }],
    });
    expect(withActions.ok && withActions.app.actions).toEqual([{ id: "refresh", label: "Refresh", icon: "sync" }]);
    const without = validateAppManifest(root, manifest());
    expect(without.ok && without.app.actions).toEqual([]);
  });

  it("refuses the two ids Tachyon contributes itself", () => {
    // `open` and `uninstall` are the product's rows. An app that could declare them would either
    // shadow the default or offer a removal it does not perform.
    const root = temp();
    fs.writeFileSync(path.join(root, "index.html"), "<h1>x</h1>");
    for (const reserved of ["open", "uninstall"]) {
      const result = validateAppManifest(root, { ...manifest(), actions: [{ id: reserved, label: "X", icon: "add" }] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.some((e) => e.includes("reserved"))).toBe(true);
    }
  });

  it("names what is wrong instead of dropping the row", () => {
    const root = temp();
    fs.writeFileSync(path.join(root, "index.html"), "<h1>x</h1>");
    const bad = (actions: unknown) => {
      const result = validateAppManifest(root, { ...manifest(), actions });
      return result.ok ? [] : result.errors;
    };
    expect(bad("nope").some((e) => /actions: when present/.test(e))).toBe(true);
    expect(bad([{ id: "Refresh", label: "R", icon: "sync" }]).some((e) => /actions\[0\]\.id/.test(e))).toBe(true);
    expect(bad([{ id: "refresh", label: "", icon: "sync" }]).some((e) => /actions\[0\]\.label/.test(e))).toBe(true);
    expect(bad([{ id: "refresh", label: "R", icon: "Not A Codicon" }]).some((e) => /actions\[0\]\.icon/.test(e))).toBe(true);
    expect(bad([{ id: "a", label: "A", icon: "add" }, { id: "a", label: "B", icon: "add" }]).some((e) => /more than once/.test(e))).toBe(true);
    expect(bad(Array.from({ length: 13 }, (_, i) => ({ id: `a${i}`, label: "A", icon: "add" }))).some((e) => /at most/.test(e))).toBe(true);
  });
});

describe("uninstallApp", () => {
  it("removes the app's directory and reports what went", () => {
    const ws = temp();
    const appRoot = path.join(ws, ".tachyon", "apps", "hello-world");
    fs.mkdirSync(appRoot, { recursive: true });
    fs.writeFileSync(path.join(appRoot, "app.json"), JSON.stringify(manifest()));
    fs.writeFileSync(path.join(appRoot, "index.html"), "<h1>x</h1>");
    fs.writeFileSync(path.join(appRoot, "icon.svg"), "<svg/>");

    const result = uninstallApp(ws, "hello-world");
    expect(result.removed?.title).toBe("Hello world");
    expect(result.paths).toEqual([appRoot]);
    expect(fs.existsSync(appRoot)).toBe(false);
    expect(readInstalledApps(ws).apps).toEqual([]);
  });

  it("is idempotent — removing what is already gone is the desired state, not an error", () => {
    const ws = temp();
    expect(uninstallApp(ws, "never-installed")).toEqual({ paths: [] });
  });

  it("refuses an id that is not an app id, so no path can be talked into being an app", () => {
    expect(() => uninstallApp(temp(), "../../etc")).toThrow(/not a valid app id/);
  });
});
