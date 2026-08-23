/**
 * 514 slice F — the page storage of an installed app, and the two facts the measurement turned up.
 *
 * Every app tab is created under ONE view type, because VS Code cannot register a serializer for a
 * type it learns about after activation. VS Code's own guidance is that all instances of a webview
 * share an origin, and storage is partitioned per origin — so without this shim two installed apps
 * share one `localStorage`, and uninstalling one could not clear anything.
 *
 * The shim runs in the page, so what is testable here is the string it produces: that the namespace
 * is per app, that the sweep names only foreign `tachyon.app.*` keys, and that a page's own data is
 * never in the sweep's sights.
 */
import { describe, expect, it } from "vitest";
import { appStoragePrefix, storageShim } from "../../apps/vscode-extension/src/webview/userAppStorage.js";

describe("an app's page storage is its own", () => {
  it("namespaces by app id, so two apps cannot collide on a shared origin", () => {
    expect(appStoragePrefix("hello-fleet")).toBe("tachyon.app.hello-fleet.");
    expect(appStoragePrefix("board-extras")).not.toBe(appStoragePrefix("hello-fleet"));
  });

  it("carries the prefix and the installed list into the page", () => {
    const shim = storageShim("hello-fleet", ["hello-fleet", "other-app"]);
    expect(shim).toContain('"tachyon.app.hello-fleet."');
    expect(shim).toContain('["hello-fleet","other-app"]');
  });

  it("replaces BOTH storages — an app that used sessionStorage is no less shared", () => {
    const shim = storageShim("hello-fleet", ["hello-fleet"]);
    expect(shim).toContain('"localStorage"');
    expect(shim).toContain('"sessionStorage"');
  });

  it("sweeps only keys that belong to an app, and only to one that is gone", () => {
    const shim = storageShim("hello-fleet", ["hello-fleet"]);
    // The guard is the pattern plus the membership test: a key that is not `tachyon.app.<id>.` is not
    // ours to delete, and one whose app is still installed is not gone.
    expect(shim).toContain("([a-z0-9-]+)");
    expect(shim).toContain("!INSTALLED.includes(app)");
  });

  it("never lets a storage failure take the page down with it", () => {
    // A webview with storage disabled, a private window, a browser that throws on access: an app's
    // page must still render. Every access in the shim is wrapped for that reason.
    const shim = storageShim("hello-fleet", []);
    expect(shim.match(/catch/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
