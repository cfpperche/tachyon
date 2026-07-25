import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import JSZip from "jszip";
// The packaging scripts are plain ESM and have no separate declaration surface.
// @ts-expect-error -- exercising the real audit the release path runs is the point.
import { checkPackagedArtifact } from "../../scripts/vsix-artifact.mjs";

/**
 * t-1f425c — the dogfood↔product registry had one open row: nothing unpacked the release candidate to
 * enumerate its true contents. Release 0.56.102 crashed on activation because the engine manifest
 * promised a file the ship boundary pruned, and the only thing that would have caught it was a manual
 * unzip somebody happened to run. These tests hold the replacement honest: the audit must REFUSE each
 * of those shapes, not merely pass a healthy artifact.
 */

/** `unzip` is what the audit itself shells out to, so a machine without it cannot run the audit at
 *  all. The zip is WRITTEN with jszip rather than a `zip` binary: this host has none, and a fixture
 *  that silently skips is the same false green this whole change exists to remove. */
function unzipOk(): boolean {
  try { execFileSync("unzip", ["-v"], { stdio: "ignore" }); return true; } catch { return false; }
}

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const sha = (b: string) => crypto.createHash("sha256").update(b).digest("hex");

/** Build a miniature but REAL vsix: a zip with extension/dist and an engine manifest. */
async function makeVsix(opts: {
  distFiles?: Record<string, string>;
  manifestFiles?: Array<{ path: string; sha256?: string }>;
  engineFiles?: Record<string, string>;
  omitManifest?: boolean;
  /** Extra archive entries, keyed by their full in-archive path (e.g. a shipped node_module). */
  extraFiles?: Record<string, string>;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vsix-audit-test-"));
  dirs.push(root);
  const dist = opts.distFiles ?? { "dist/extension.js": "MAIN BUNDLE" };
  const engine = opts.engineFiles ?? { "engine-daemon.cjs": "DAEMON" };

  const zip = new JSZip();
  for (const [rel, body] of Object.entries(dist)) zip.file(`extension/${rel}`, body);
  for (const [rel, body] of Object.entries(engine)) zip.file(`extension/dist/engine/${rel}`, body);
  if (!opts.omitManifest) {
    const files = opts.manifestFiles ?? Object.entries(engine).map(([p, body]) => ({ path: p, sha256: sha(body) }));
    zip.file("extension/dist/engine/engine-manifest.json", JSON.stringify({ schemaVersion: 1, files }));
  }

  for (const [rel, body] of Object.entries(opts.extraFiles ?? {})) zip.file(rel, body);

  const vsix = path.join(root, "fixture.vsix");
  fs.writeFileSync(vsix, await zip.generateAsync({ type: "nodebuffer" }));
  const claims = Object.fromEntries(Object.entries(dist).map(([rel, body]) => [rel, sha(body)]));
  return { vsix, claims };
}

describe.skipIf(!unzipOk())("packaged artifact audit (t-1f425c)", () => {
  it("accepts an artifact whose contents match every claim", async () => {
    const { vsix, claims } = await makeVsix();
    const r = checkPackagedArtifact(vsix, claims);
    expect(r.problems).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checked).toBeGreaterThan(0); // a check that inspected nothing is not a pass
  });

  it("REFUSES when a claimed dist file is absent from the vsix", async () => {
    const { vsix, claims } = await makeVsix();
    const r = checkPackagedArtifact(vsix, { ...claims, "dist/webview/cockpit.js": sha("never packaged") });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/ABSENT from the vsix: dist\/webview\/cockpit\.js/);
  });

  it("REFUSES when a packaged file's bytes differ from the claim", async () => {
    const { vsix, claims } = await makeVsix();
    const tampered = { ...claims, "dist/extension.js": sha("A DIFFERENT BUNDLE") };
    const r = checkPackagedArtifact(vsix, tampered);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/bytes differ from the claim: dist\/extension\.js/);
  });

  it("REFUSES when the engine manifest promises a file the vsix does not contain (the 0.56.102 crash)", async () => {
    const { vsix, claims } = await makeVsix({
      engineFiles: { "engine-daemon.cjs": "DAEMON" },
      manifestFiles: [{ path: "engine-daemon.cjs", sha256: sha("DAEMON") }, { path: "app.js.map", sha256: sha("PRUNED") }],
    });
    const r = checkPackagedArtifact(vsix, claims);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/promises a file the vsix does not contain: dist\/engine\/app\.js\.map/);
  });

  it("REFUSES when the engine manifest hash disagrees with the packaged bytes", async () => {
    const { vsix, claims } = await makeVsix({
      engineFiles: { "engine-daemon.cjs": "DAEMON" },
      manifestFiles: [{ path: "engine-daemon.cjs", sha256: sha("SOMETHING ELSE") }],
    });
    const r = checkPackagedArtifact(vsix, claims);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/hash mismatch: dist\/engine\/engine-daemon\.cjs/);
  });

  it("REFUSES a source map shipped inside the engine payload", async () => {
    const { vsix, claims } = await makeVsix({ engineFiles: { "engine-daemon.cjs": "DAEMON", "engine-daemon.cjs.map": "MAP" } });
    const r = checkPackagedArtifact(vsix, claims);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/source map inside the engine payload/);
  });

  it("REFUSES engine claims with no engine manifest to keep them honest", async () => {
    const { vsix, claims } = await makeVsix({ omitManifest: true });
    const r = checkPackagedArtifact(vsix, { ...claims, "dist/engine/engine-daemon.cjs": sha("DAEMON") });
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/no engine-manifest\.json/);
  });

  // The caller passes claims ONLY when they came from the vsix's own embedded record. On the fallback
  // path the claims describe the workspace tree, and comparing them would flag a legitimate
  // difference. With no claims the artifact-only checks must still run — otherwise "no claims" would
  // become a way to ship anything.
  it("still enforces the manifest promise when there are no claims to compare", async () => {
    const { vsix } = await makeVsix({
      engineFiles: { "engine-daemon.cjs": "DAEMON" },
      manifestFiles: [{ path: "engine-daemon.cjs", sha256: sha("DAEMON") }, { path: "gone.map", sha256: sha("PRUNED") }],
    });
    const r = checkPackagedArtifact(vsix, {});
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/promises a file the vsix does not contain: dist\/engine\/gone\.map/);
  });

  it("still refuses a shipped source map when there are no claims to compare", async () => {
    const { vsix } = await makeVsix({ engineFiles: { "engine-daemon.cjs": "DAEMON", "engine-daemon.cjs.map": "MAP" } });
    const r = checkPackagedArtifact(vsix, {});
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/source map inside the engine payload/);
  });

  // t-09a462 — an `external` require is a promise about runtime. node-pty was declared, marked
  // external, required and never packaged; the audit above could not see it, because a node_module is
  // in neither the dist claims nor the engine manifest.
  it("REFUSES a bundle that requires a package the vsix does not contain", async () => {
    const { vsix, claims } = await makeVsix({ distFiles: { "dist/extension.js": `require("node-pty");` } });
    const r = checkPackagedArtifact(vsix, claims);
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/requires 'node-pty' at runtime but the vsix does not contain it/);
  });

  it("accepts the same bundle once the package ships with it", async () => {
    const { vsix, claims } = await makeVsix({
      distFiles: { "dist/extension.js": `require("node-pty");` },
      extraFiles: { "extension/node_modules/node-pty/package.json": `{"name":"node-pty"}` },
    });
    const r = checkPackagedArtifact(vsix, claims);
    expect(r.problems).toEqual([]);
  });

  it("REFUSES a file that is not a readable archive instead of reporting success", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vsix-audit-bad-"));
    dirs.push(root);
    const notAZip = path.join(root, "broken.vsix");
    fs.writeFileSync(notAZip, "this is not a zip");
    const r = checkPackagedArtifact(notAZip, {});
    expect(r.ok).toBe(false);
    expect(r.problems.join("\n")).toMatch(/cannot unpack/);
  });
});
