import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeStatusLineCaptureTransport,
  resolveEffectiveStatusLine,
} from "../../src/runtimeObservability/claudeStatusLineCapture.js";
import {
  ProviderObservationPreferences,
  type ProviderObservationStatePort,
} from "../../src/runtimeObservability/preferences.js";

class MemoryState implements ProviderObservationStatePort {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): void {
    this.values.set(key, structuredClone(value));
  }
}

const roots: string[] = [];

async function harness(options: { nowMs?: number } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-claude-capture-"));
  roots.push(root);
  const home = path.join(root, "home");
  const cwd = path.join(root, "workspace");
  const storage = path.join(root, "global-storage");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(storage, { recursive: true, mode: 0o700 });
  const state = new MemoryState();
  const preferences = new ProviderObservationPreferences(state, () => "1".repeat(32));
  await preferences.configure("claude", {
    state: "granted",
    consent: "explicit-user",
    sources: ["cli"],
  });
  const nowMs = options.nowMs ?? Date.now();
  const transport = new ClaudeStatusLineCaptureTransport(storage, preferences, {
    homeDir: home,
    managedSettingsPaths: [],
    now: () => new Date(nowMs),
  });
  return { root, home, cwd, storage, state, preferences, transport, nowMs };
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runStatusLine(command: string, cwd: string, input: unknown) {
  return spawnSync("/bin/sh", ["-c", command], {
    cwd,
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 5_000,
  });
}

function findFile(root: string, suffix: string): string {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.name.endsWith(suffix)) return child;
    }
  }
  throw new Error(`missing ${suffix}`);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ClaudeStatusLineCaptureTransport", () => {
  it("tees raw stdin to an existing status line while persisting only the quota projection", async () => {
    const h = await harness();
    const prior = path.join(h.root, "prior.cjs");
    fs.writeFileSync(prior, [
      "process.stdin.resume();",
      "process.stdin.on('end', () => process.stdout.write('USER-LINE\\n'));",
    ].join("\n"));
    writeJson(path.join(h.home, ".claude", "settings.json"), {
      statusLine: { type: "command", command: `node '${prior}'`, padding: 2 },
    });
    const setting = h.transport.materialize({
      workspaceRoot: h.cwd,
      agent: "claude-one",
      cwd: h.cwd,
    });
    expect(setting).toMatchObject({ type: "command", padding: 2 });

    const raw = {
      session_id: "MUST_NOT_CROSS_SESSION",
      cwd: "/private/project",
      transcript_path: "/private/transcript.jsonl",
      model: { id: "MUST_NOT_CROSS_MODEL" },
      rate_limits: {
        five_hour: { used_percentage: 31, resets_at: 1_784_077_200, extra: "MUST_NOT_CROSS_EXTRA" },
        seven_day: { used_percentage: 68, resets_at: 1_784_682_000 },
      },
    };
    const run = runStatusLine(setting!.command, h.cwd, raw);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("USER-LINE\n");
    expect(run.stderr).toBe("");

    const captureFile = findFile(h.storage, ".capture.json");
    const onDisk = fs.readFileSync(captureFile, "utf8");
    expect(onDisk).toContain('"five_hour"');
    expect(onDisk).toContain('"seven_day"');
    for (const forbidden of ["MUST_NOT_CROSS", "session_id", "transcript_path", "/private/"]) {
      expect(onDisk).not.toContain(forbidden);
    }
    const capture = await h.transport.readCapture(new AbortController().signal);
    expect(capture).not.toBeNull();
    expect(JSON.parse(String(capture!.json))).toEqual({
      rate_limits: {
        five_hour: { used_percentage: 31, resets_at: 1_784_077_200 },
        seven_day: { used_percentage: 68, resets_at: 1_784_682_000 },
      },
    });
  });

  it("emits no Tachyon text when the user has no prior status-line command", async () => {
    const h = await harness();
    const setting = h.transport.materialize({ workspaceRoot: h.cwd, agent: "claude", cwd: h.cwd });

    const run = runStatusLine(setting!.command, h.cwd, { rate_limits: {} });

    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe("");
    await expect(h.transport.readCapture(new AbortController().signal)).resolves.toMatchObject({
      observedAt: expect.any(String),
    });
  });

  it("preserves Claude's user < project < local scalar precedence", async () => {
    const h = await harness();
    writeJson(path.join(h.home, ".claude", "settings.json"), {
      statusLine: { type: "command", command: "printf user" },
    });
    writeJson(path.join(h.cwd, ".claude", "settings.json"), {
      statusLine: { type: "command", command: "printf project" },
    });
    writeJson(path.join(h.cwd, ".claude", "settings.local.json"), {
      statusLine: { type: "command", command: "printf local", padding: 1 },
    });

    const setting = h.transport.materialize({ workspaceRoot: h.cwd, agent: "claude", cwd: h.cwd });
    const run = runStatusLine(setting!.command, h.cwd, { rate_limits: {} });

    expect(setting?.padding).toBe(1);
    expect(run.stdout).toBe("local");
  });

  it("fails closed for malformed, symlinked, or managed status-line settings", async () => {
    const h = await harness();
    const userSettings = path.join(h.home, ".claude", "settings.json");
    fs.writeFileSync(userSettings, "{broken", "utf8");
    expect(h.transport.materialize({ workspaceRoot: h.cwd, agent: "a", cwd: h.cwd })).toBeUndefined();

    fs.rmSync(userSettings);
    const target = path.join(h.root, "settings-target.json");
    writeJson(target, { statusLine: { type: "command", command: "printf user" } });
    fs.symlinkSync(target, userSettings);
    expect(h.transport.materialize({ workspaceRoot: h.cwd, agent: "b", cwd: h.cwd })).toBeUndefined();

    const managed = path.join(h.root, "managed.json");
    writeJson(managed, { statusLine: { type: "command", command: "printf managed" } });
    expect(resolveEffectiveStatusLine({
      cwd: h.cwd,
      homeDir: h.home,
      managedSettingsPaths: [managed],
    })).toEqual({ ok: false });
  });

  it("does not materialize anything unless the Claude cli source has an explicit grant", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-claude-disabled-"));
    roots.push(root);
    const state = new MemoryState();
    const preferences = new ProviderObservationPreferences(state);
    const transport = new ClaudeStatusLineCaptureTransport(path.join(root, "storage"), preferences, {
      managedSettingsPaths: [],
    });

    expect(transport.materialize({ workspaceRoot: root, agent: "claude", cwd: root })).toBeUndefined();
    expect(fs.existsSync(path.join(root, "storage"))).toBe(false);
  });

  it("fails closed without traversing a symlinked global transport root", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-claude-root-symlink-"));
    roots.push(root);
    const storage = path.join(root, "storage");
    const transportParent = path.join(storage, "runtime-observability-v1");
    const victim = path.join(root, "victim");
    fs.mkdirSync(transportParent, { recursive: true, mode: 0o700 });
    fs.mkdirSync(victim, { mode: 0o700 });
    const victimMarker = path.join(victim, "capture-enabled.json");
    fs.writeFileSync(victimMarker, "KEEP", { mode: 0o600 });
    fs.symlinkSync(victim, path.join(transportParent, "claude-status-line"));
    const state = new MemoryState();
    const preferences = new ProviderObservationPreferences(state, () => "1".repeat(32));
    await preferences.configure("claude", {
      state: "granted",
      consent: "explicit-user",
      sources: ["cli"],
    });

    const transport = new ClaudeStatusLineCaptureTransport(storage, preferences, { managedSettingsPaths: [] });

    expect(transport.materialize({ workspaceRoot: root, agent: "claude", cwd: root })).toBeUndefined();
    await expect(transport.readCapture(new AbortController().signal)).resolves.toBeNull();
    transport.clearProvider("claude");
    expect(fs.readFileSync(victimMarker, "utf8")).toBe("KEEP");
  });

  it("refuses an alternate external Claude config home that could represent another account", async () => {
    const h = await harness();
    const alternate = path.join(h.root, "alternate-claude-account");
    fs.mkdirSync(alternate);

    expect(h.transport.materialize({
      workspaceRoot: h.cwd,
      agent: "claude",
      cwd: h.cwd,
      configHome: alternate,
    })).toBeUndefined();
    expect(fs.existsSync(path.join(h.storage, "runtime-observability-v1"))).toBe(false);

    const tachyonHarness = path.join(h.cwd, ".tachyon", "harness", "claude");
    fs.mkdirSync(tachyonHarness, { recursive: true });
    expect(h.transport.materialize({
      workspaceRoot: h.cwd,
      agent: "claude",
      cwd: h.cwd,
      configHome: tachyonHarness,
    })).toMatchObject({ type: "command" });

    const escapedHarness = path.join(h.cwd, ".tachyon", "harness", "escaped");
    fs.symlinkSync(alternate, escapedHarness);
    expect(h.transport.materialize({
      workspaceRoot: h.cwd,
      agent: "claude",
      cwd: h.cwd,
      configHome: escapedHarness,
    })).toBeUndefined();

    const harnessRoot = path.join(h.cwd, ".tachyon", "harness");
    fs.rmSync(harnessRoot, { recursive: true });
    const redirectedHarness = path.join(h.root, "redirected-harness");
    fs.mkdirSync(path.join(redirectedHarness, "claude"), { recursive: true });
    fs.symlinkSync(redirectedHarness, harnessRoot);
    expect(h.transport.materialize({
      workspaceRoot: h.cwd,
      agent: "claude",
      cwd: h.cwd,
      configHome: path.join(harnessRoot, "claude"),
    })).toBeUndefined();
  });

  it("atomically replaces a planted capture symlink without touching its target", async () => {
    const h = await harness();
    const setting = h.transport.materialize({ workspaceRoot: h.cwd, agent: "claude", cwd: h.cwd });
    const relay = findFile(h.storage, ".relay.json");
    const scopeKey = h.preferences.get("claude")!.scope.key;
    const capture = path.join(
      h.storage,
      "runtime-observability-v1",
      "claude-status-line",
      scopeKey,
      path.basename(relay).replace(/\.relay\.json$/u, ".capture.json"),
    );
    const victim = path.join(h.root, "victim.txt");
    fs.writeFileSync(victim, "KEEP", "utf8");
    fs.symlinkSync(victim, capture);

    expect(runStatusLine(setting!.command, h.cwd, { rate_limits: {} }).status).toBe(0);

    expect(fs.readFileSync(victim, "utf8")).toBe("KEEP");
    expect(fs.lstatSync(capture).isFile()).toBe(true);
    expect(fs.lstatSync(capture).isSymbolicLink()).toBe(false);
  });

  it("ignores expired, future, symlinked, and unbounded capture sets", async () => {
    const now = Date.now();
    const h = await harness({ nowMs: now });
    const setting = h.transport.materialize({ workspaceRoot: h.cwd, agent: "claude", cwd: h.cwd });
    expect(runStatusLine(setting!.command, h.cwd, { rate_limits: {} }).status).toBe(0);
    const capture = findFile(h.storage, ".capture.json");
    const scopeDir = path.dirname(capture);

    const staleTransport = new ClaudeStatusLineCaptureTransport(h.storage, h.preferences, {
      homeDir: h.home,
      managedSettingsPaths: [],
      now: () => new Date(now + 11 * 60_000),
    });
    await expect(staleTransport.readCapture(new AbortController().signal)).resolves.toBeNull();

    fs.rmSync(capture);
    const victim = path.join(h.root, "capture-victim.json");
    fs.writeFileSync(victim, JSON.stringify({ schemaVersion: 1, observedAt: new Date(now).toISOString(), rate_limits: {} }));
    fs.symlinkSync(victim, capture);
    await expect(h.transport.readCapture(new AbortController().signal)).resolves.toBeNull();
    fs.rmSync(capture);

    const body = `${JSON.stringify({ schemaVersion: 1, observedAt: new Date(now).toISOString(), rate_limits: {} })}\n`;
    for (let index = 0; index <= 256; index += 1) {
      const file = path.join(scopeDir, `${index.toString(16).padStart(32, "0")}.capture.json`);
      fs.writeFileSync(file, body, { mode: 0o600 });
    }
    await expect(h.transport.readCapture(new AbortController().signal)).resolves.toBeNull();
  });

  it("bounds retained relays instead of growing transport state per agent forever", async () => {
    const h = await harness();
    for (let index = 0; index < 256; index += 1) {
      expect(h.transport.materialize({
        workspaceRoot: h.cwd,
        agent: `claude-${index}`,
        cwd: h.cwd,
      })).toMatchObject({ type: "command" });
    }

    expect(h.transport.materialize({
      workspaceRoot: h.cwd,
      agent: "claude-over-capacity",
      cwd: h.cwd,
    })).toBeUndefined();
    expect(fs.readdirSync(path.join(
      h.storage,
      "runtime-observability-v1",
      "claude-status-line",
      "relays",
    ))).toHaveLength(256);
  });

  it("cancels reads and revokes capture without breaking an existing user status line", async () => {
    const h = await harness();
    writeJson(path.join(h.home, ".claude", "settings.json"), {
      statusLine: { type: "command", command: "printf USER-LINE" },
    });
    const setting = h.transport.materialize({ workspaceRoot: h.cwd, agent: "claude", cwd: h.cwd });
    expect(runStatusLine(setting!.command, h.cwd, { rate_limits: {} }).stdout).toBe("USER-LINE");
    const capture = findFile(h.storage, ".capture.json");
    const controller = new AbortController();
    controller.abort();

    await expect(h.transport.readCapture(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await h.preferences.configure("claude", { state: "disabled" });
    h.transport.clearProvider("claude");
    expect(fs.existsSync(capture)).toBe(false);

    const afterRevocation = runStatusLine(setting!.command, h.cwd, { rate_limits: {} });
    expect(afterRevocation.status).toBe(0);
    expect(afterRevocation.stdout).toBe("USER-LINE");
    expect(afterRevocation.stderr).toBe("");
    expect(fs.existsSync(capture)).toBe(false);
    expect(findFile(h.storage, ".relay.json")).toBeTruthy();
    await expect(h.transport.readCapture(new AbortController().signal)).resolves.toBeNull();
  });

  it("recovers an interrupted revocation on extension-host restart", async () => {
    const h = await harness();
    writeJson(path.join(h.home, ".claude", "settings.json"), {
      statusLine: { type: "command", command: "printf USER-LINE" },
    });
    const setting = h.transport.materialize({ workspaceRoot: h.cwd, agent: "claude", cwd: h.cwd });
    expect(runStatusLine(setting!.command, h.cwd, { rate_limits: {} }).stdout).toBe("USER-LINE");
    const capture = findFile(h.storage, ".capture.json");
    await h.preferences.configure("claude", { state: "disabled" });

    new ClaudeStatusLineCaptureTransport(h.storage, h.preferences, {
      homeDir: h.home,
      managedSettingsPaths: [],
    });

    expect(fs.existsSync(capture)).toBe(false);
    expect(runStatusLine(setting!.command, h.cwd, { rate_limits: {} })).toMatchObject({
      status: 0,
      stdout: "USER-LINE",
      stderr: "",
    });
    expect(fs.existsSync(capture)).toBe(false);
  });
});
