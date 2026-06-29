import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildAssistedInstall, resolveExternalTool } from "../../src/plugins/externalTool.js";
import { serializeLockfile, LOCKFILE_REL_PATH, parseLockfile, type Lockfile } from "../../src/plugins/lockfile.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("buildAssistedInstall (spec 285)", () => {
  it("picks the host PM + its validated install argv", () => {
    const r = buildAssistedInstall({ apt: { argv: ["sudo", "apt-get", "install", "-y", "ffmpeg"] }, brew: { argv: ["brew", "install", "ffmpeg"] } }, { resolve: (n) => (n === "brew" ? "/bin/sh" : null) });
    expect(r).toEqual({ ok: true, pm: "brew", argv: ["/bin/sh", "install", "ffmpeg"] }); // normalized: brew → trusted realpath
  });
  it("fails when no PM is present", () => {
    const r = buildAssistedInstall({ apt: { argv: ["apt-get", "install", "ffmpeg"] } }, { resolve: () => null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no supported package manager/);
  });
  it("fails when the host PM has no declared command", () => {
    const r = buildAssistedInstall({ apt: { argv: ["apt-get", "install", "ffmpeg"] } }, { resolve: (n) => (n === "brew" ? "/bin/sh" : null) });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/no install command declared for the detected package manager 'brew'/);
  });
  it("fails closed when the declared argv doesn't match the PM family (guardrail)", () => {
    const r = buildAssistedInstall({ brew: { argv: ["curl", "evil.sh"] } }, { resolve: (n) => (n === "brew" ? "/bin/sh" : null) });
    expect(r.ok).toBe(false);
  });
});

describe("resolveExternalTool (spec 285 D5)", () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "ext-resolve-"));
    const lf: Lockfile = { schemaVersion: 1, plugins: { tr: { name: "tr", version: "1.0.0", runtimes: ["claude"], targets: [], externalTools: [{ name: "ffmpeg", install: { apt: ["sudo", "apt-get", "install", "-y", "ffmpeg"] }, manual: "get ffmpeg" }] } } };
    fs.mkdirSync(path.join(ws, ".tachyon"), { recursive: true });
    fs.writeFileSync(path.join(ws, LOCKFILE_REL_PATH), serializeLockfile(lf));
  });
  afterEach(() => fs.rmSync(ws, { recursive: true, force: true }));

  it("resolves to a trusted path when the tool is detected", () => {
    const r = resolveExternalTool("tr", "ffmpeg", { workspaceRoot: ws, resolve: () => "/bin/sh" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe("/bin/sh");
  });
  it("fail-closed UNAVAILABLE (with manual guidance) when absent", () => {
    const r = resolveExternalTool("tr", "ffmpeg", { workspaceRoot: ws, resolve: () => null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("UNAVAILABLE");
    expect(r.detail).toMatch(/get ffmpeg/);
  });
  it("fail-closed for an unknown plugin / tool (plugin-scoped)", () => {
    expect((resolveExternalTool("nope", "ffmpeg", { workspaceRoot: ws }) as { code: string }).code).toBe("PLUGIN_NOT_FOUND");
    expect((resolveExternalTool("tr", "nope", { workspaceRoot: ws }) as { code: string }).code).toBe("EXTERNAL_NOT_FOUND");
  });

  it("the external-tool requirement round-trips through the lockfile", () => {
    const lf = parseLockfile(fs.readFileSync(path.join(ws, LOCKFILE_REL_PATH), "utf8")).lockfile!;
    expect(lf.plugins.tr.externalTools?.[0]).toEqual({ name: "ffmpeg", install: { apt: ["sudo", "apt-get", "install", "-y", "ffmpeg"] }, manual: "get ffmpeg" });
  });

  it("spec 289 — resolves via the lockfile's candidate `names` set (runtime path tries the same candidates)", () => {
    const lf: Lockfile = { schemaVersion: 1, plugins: { dg: { name: "dg", version: "1.0.0", runtimes: ["claude"], targets: [], externalTools: [{ name: "chrome", names: ["google-chrome", "chromium"], install: { apt: ["sudo", "apt-get", "install", "-y", "chromium"] }, manual: "install a browser" }] } } };
    fs.writeFileSync(path.join(ws, LOCKFILE_REL_PATH), serializeLockfile(lf));
    // names round-trip through the lock…
    const parsed = parseLockfile(fs.readFileSync(path.join(ws, LOCKFILE_REL_PATH), "utf8")).lockfile!;
    expect(parsed.plugins.dg.externalTools?.[0].names).toEqual(["google-chrome", "chromium"]);
    // …and the runtime resolver tries them: only chromium present → resolves it.
    const r = resolveExternalTool("dg", "chrome", { workspaceRoot: ws, resolve: (n) => (n === "chromium" ? "/bin/sh" : null) });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toBe("/bin/sh");
  });
});
