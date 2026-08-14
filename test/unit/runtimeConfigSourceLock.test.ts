import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sourceLockPath, withRuntimeConfigSourceLock } from "../../apps/vscode-extension/src/runtimeConfig/sourceLock.js";
import { applyGrokRuntimeConfigChange } from "../../apps/vscode-extension/src/runtimeConfig/grokInventory.js";
import { applyClaudeRuntimeConfigChange } from "../../apps/vscode-extension/src/runtimeConfig/claudeInventory.js";

/**
 * t-ce83a2 — regression for a lock that excluded nothing.
 *
 * Found in review: both adapters released the lock in a `finally` that unlinked it unconditionally,
 * so the caller that LOST the race deleted the winner's lock on its way out. The tests below are
 * written as the reviewer proved it — A holds, B loses, and the question is whether A's lock is
 * still there — plus the trap that the obvious fix introduces, which is an orphan nobody can clear.
 */
const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-runtime-config-lock-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const ALIVE = { isHolderAlive: () => true };
const DEAD = { isHolderAlive: () => false };

describe("Runtime Config source lock", () => {
  it("does not let the loser of the race delete the winner's lock", () => {
    const root = tempRoot();
    const file = path.join(root, "config.toml");
    const lock = sourceLockPath(file);

    withRuntimeConfigSourceLock(file, () => {
      // B arrives while A is inside the critical section and is refused...
      expect(() => withRuntimeConfigSourceLock(file, () => "must not run", ALIVE))
        .toThrow(/save is in progress/);
      // ...and A's lock is still A's. This is the exact assertion that failed before the fix.
      expect(fs.existsSync(lock)).toBe(true);
    }, ALIVE);

    // The owner's release does remove it.
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("recovers a lock orphaned by a save that died, instead of wedging forever", () => {
    const root = tempRoot();
    const file = path.join(root, "config.toml");
    const lock = sourceLockPath(file);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(lock, "424242\n");

    // The holder is gone, so the orphan is stolen once and the save proceeds.
    expect(withRuntimeConfigSourceLock(file, () => "ran", DEAD)).toBe("ran");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("treats a stale unreadable holder as an orphan rather than a permanent block", () => {
    const root = tempRoot();
    const file = path.join(root, "config.toml");
    const lock = sourceLockPath(file);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(lock, "not-a-pid");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);

    expect(withRuntimeConfigSourceLock(file, () => "ran")).toBe("ran");
  });

  it("keeps refusing while the holder is alive, and names the file to clear", () => {
    const root = tempRoot();
    const file = path.join(root, "config.toml");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(sourceLockPath(file), "424242\n");

    expect(() => withRuntimeConfigSourceLock(file, () => "must not run", ALIVE))
      .toThrow(new RegExp(sourceLockPath(file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("releases the lock even when the body throws", () => {
    const root = tempRoot();
    const file = path.join(root, "config.toml");
    expect(() => withRuntimeConfigSourceLock(file, () => { throw new Error("boom"); })).toThrow("boom");
    expect(fs.existsSync(sourceLockPath(file))).toBe(false);
  });

  it("stamps the holder pid so another process can judge liveness", () => {
    const root = tempRoot();
    const file = path.join(root, "config.toml");
    withRuntimeConfigSourceLock(file, () => {
      expect(Number.parseInt(fs.readFileSync(sourceLockPath(file), "utf8").trim(), 10)).toBe(process.pid);
    });
  });

  /**
   * Second-pass review residual R1: releasing by PATH would delete whatever sits there, which is the
   * original defect one level down. If our lock is taken from us while we work, the file belongs to
   * somebody else and must survive our exit.
   */
  it("leaves a foreign lock alone when ours was taken from us mid-body", () => {
    const root = tempRoot();
    const file = path.join(root, "config.toml");
    const lock = sourceLockPath(file);

    withRuntimeConfigSourceLock(file, () => {
      // Somebody else now owns the path (stolen, or cleared and re-taken).
      fs.writeFileSync(lock, "424242\n");
    });

    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.readFileSync(lock, "utf8").trim()).toBe("424242");
  });

  /**
   * Second-pass review residual R2: `open` then `write` are two steps, so a lock can be observed
   * before its pid is stamped. Reading that as "crashed" robs a holder that is mid-create.
   */
  it("does not steal a lock that is merely unstamped yet", () => {
    const root = tempRoot();
    const file = path.join(root, "config.toml");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(sourceLockPath(file), ""); // created, not yet stamped

    expect(() => withRuntimeConfigSourceLock(file, () => "must not run", DEAD))
      .toThrow(/save is in progress/);
  });

  it("still recovers an unstamped lock once it is old enough to be a crash", () => {
    const root = tempRoot();
    const file = path.join(root, "config.toml");
    const lock = sourceLockPath(file);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(lock, "");
    // Age it past the grace window: a create that never stamped is a create that died.
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);

    expect(withRuntimeConfigSourceLock(file, () => "ran", DEAD)).toBe("ran");
  });

  /**
   * Publication must never overwrite a holder. `link` fails on an existing target, which is why it
   * is used instead of `rename` — the stamp has to become visible without replacing anybody.
   */
  it("never overwrites an existing holder when publishing", () => {
    const root = tempRoot();
    const file = path.join(root, "config.toml");
    const lock = sourceLockPath(file);
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(lock, "424242\n");

    expect(() => withRuntimeConfigSourceLock(file, () => "must not run", ALIVE))
      .toThrow(/save is in progress/);
    expect(fs.readFileSync(lock, "utf8").trim()).toBe("424242");
  });

  /**
   * The lock is linked into place already stamped, so no competitor can observe it empty, and the
   * temp it was written through must not survive.
   */
  it("publishes an already-stamped lock and leaves no temp behind", () => {
    const root = tempRoot();
    const file = path.join(root, "config.toml");

    withRuntimeConfigSourceLock(file, () => {
      expect(fs.readFileSync(sourceLockPath(file), "utf8").trim()).toBe(String(process.pid));
      expect(fs.readdirSync(root).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
    });
    expect(fs.readdirSync(root).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  /**
   * `link` needs filesystem support. Where it is missing the weaker `open(wx)` path takes over, and
   * an untested fallback is the one that breaks in the field — so it is driven here, including the
   * property that still matters most: it must not overwrite a holder either.
   */
  it("falls back to exclusive create where link is unsupported, still without overwriting a holder", () => {
    const root = tempRoot();
    const file = path.join(root, "config.toml");
    const lock = sourceLockPath(file);
    const unsupported = Object.assign(new Error("no hard links here"), { code: "ENOSYS" });
    const linkSync = vi.spyOn(fs, "linkSync").mockImplementation(() => { throw unsupported; });
    try {
      withRuntimeConfigSourceLock(file, () => {
        expect(fs.readFileSync(lock, "utf8").trim()).toBe(String(process.pid));
      });
      expect(fs.existsSync(lock)).toBe(false);
      expect(fs.readdirSync(root).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);

      fs.writeFileSync(lock, "424242\n");
      expect(() => withRuntimeConfigSourceLock(file, () => "must not run", ALIVE))
        .toThrow(/save is in progress/);
      expect(fs.readFileSync(lock, "utf8").trim()).toBe("424242");
    } finally {
      linkSync.mockRestore();
    }
  });

  it("refuses a Grok save while another holds the lock, and leaves that lock alone", () => {
    const root = tempRoot();
    const home = path.join(root, "grok-home");
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "config.toml"), '[models]\ndefault = "grok-4.5"\n');
    const lock = sourceLockPath(path.join(home, "config.toml"));
    fs.writeFileSync(lock, "424242\n");

    expect(() => applyGrokRuntimeConfigChange({
      workspaceRoot: root,
      grokHome: home,
      documentId: "grok-global-config",
      expectedRevision: undefined,
      changes: [{ kind: "setting", key: "models.default", value: "grok-build" }],
      lock: ALIVE,
    })).toThrow(/save is in progress/);
    expect(fs.existsSync(lock)).toBe(true);
    // The refused save changed nothing.
    expect(fs.readFileSync(path.join(home, "config.toml"), "utf8")).toContain('default = "grok-4.5"');
  });

  it("refuses a Claude save while another holds the lock, and leaves that lock alone", () => {
    const root = tempRoot();
    const home = path.join(root, "home");
    const file = path.join(home, ".claude", "settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);
    const lock = sourceLockPath(file);
    fs.writeFileSync(lock, "424242\n");

    expect(() => applyClaudeRuntimeConfigChange({
      workspaceRoot: root,
      homeDir: home,
      documentId: "claude-global-settings",
      expectedRevision: undefined,
      changes: [{ kind: "setting", key: "theme", value: "light" }],
      lock: ALIVE,
    })).toThrow(/save is in progress/);
    expect(fs.existsSync(lock)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toContain('"theme": "dark"');
  });
});
