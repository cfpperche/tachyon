import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentManager } from "../../src/agents/AgentManager.js";
import { SessionLedger } from "../../src/resume/SessionLedger.js";
import { TmuxService, workspaceHash, type ExecResult } from "../../src/tmux/TmuxService.js";
import { parseConfig } from "../../src/config/loadConfig.js";

/**
 * SDD 482 slice 0 — ratified decision 5: runtime lineage is durable for Saved agents too.
 *
 * Before this, `SessionLedger` stripped `def.parent` from every DECLARED record on write, and
 * `rehydrateFromLedger` skipped config-owned rows entirely — two independent reasons a Saved agent's
 * parent could not survive an extension-host reload, while a Temporary agent's already did. The
 * asymmetry was real, was mis-stated in the first draft of the SDD, and the human resolved it toward
 * symmetry.
 *
 * The other half of that decision is equally load-bearing and is asserted here too: lineage must not
 * become `declaredOwner`. They are separate edges and neither is derived from the other.
 */
const HASH = workspaceHash("/ws-lineage");
const dirs: string[] = [];

function fakeTmux(): TmuxService {
  return new TmuxService(async (): Promise<ExecResult> => ({ stdout: "", stderr: "" }));
}

function workspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-lineage-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("Saved agent lineage durability (SDD 482, decision 5)", () => {
  it("a declared child's runtime parent survives a reload", async () => {
    const ws = workspace();
    const ledger = new SessionLedger(ws);
    const { config } = parseConfig("agents:\n  boss:\n    cmd: claude\n  child:\n    cmd: claude\n");

    // A Saved (declared) child that really was spawned by `boss`.
    ledger.record("child", {
      def: { cmd: "claude", kind: "agent", parent: "boss" },
      cwd: ws,
      declared: true,
    });

    // The parent must still be ON DISK: the write path used to strip it for declared rows.
    expect(ledger.all().get("child")?.def?.parent).toBe("boss");

    // A fresh manager with empty in-memory lineage — the state right after an extension-host reload.
    const reloaded = new AgentManager({
      tmux: fakeTmux(), wsHash: HASH, workspaceRoot: ws,
      getConfig: () => config, ledger,
    });
    await reloaded.rehydrateFromLedger();

    // And it must be READ BACK: rehydrate used to skip config-owned rows before reaching lineage.
    expect(reloaded.parentOf("child")).toBe("boss");
  });

  it("config still owns a declared agent's definition — only the lineage comes from the ledger", async () => {
    const ws = workspace();
    const ledger = new SessionLedger(ws);
    const { config } = parseConfig("agents:\n  boss:\n    cmd: claude\n  child:\n    cmd: claude\n");
    // A stale command on the ledger row must NOT become the declared agent's definition.
    ledger.record("child", {
      def: { cmd: "stale-command-from-the-ledger", kind: "agent", parent: "boss" },
      cwd: ws,
      declared: true,
    });

    const reloaded = new AgentManager({
      tmux: fakeTmux(), wsHash: HASH, workspaceRoot: ws,
      getConfig: () => config, ledger,
    });
    await reloaded.rehydrateFromLedger();

    expect(reloaded.parentOf("child")).toBe("boss");
    // The definition still resolves from config, not from the ledger row.
    expect(JSON.stringify(config?.agents.child)).not.toContain("stale-command-from-the-ledger");
  });

  it("lineage is still not declaredOwner: a temporary child keeps working exactly as before", async () => {
    const ws = workspace();
    const ledger = new SessionLedger(ws);
    const { config } = parseConfig("agents:\n  boss:\n    cmd: claude\n");
    ledger.record("temp", {
      def: { cmd: "claude", kind: "agent", parent: "boss" },
      cwd: ws,
      declared: false,
    });

    const reloaded = new AgentManager({
      tmux: fakeTmux(), wsHash: HASH, workspaceRoot: ws,
      getConfig: () => config, ledger,
    });
    await reloaded.rehydrateFromLedger();

    expect(reloaded.parentOf("temp")).toBe("boss");
    // `declaredOwner` is derived from `subagents` in the config and is untouched by any of this —
    // no config here declares `subagents`, so nothing may have invented an ownership edge.
    expect(config?.declaredOwner).toEqual({});
  });

  it("a self-referential parent is not restored as lineage", async () => {
    const ws = workspace();
    const ledger = new SessionLedger(ws);
    const { config } = parseConfig("agents:\n  loop:\n    cmd: claude\n");
    ledger.record("loop", { def: { cmd: "claude", kind: "agent", parent: "loop" }, cwd: ws, declared: true });

    const reloaded = new AgentManager({
      tmux: fakeTmux(), wsHash: HASH, workspaceRoot: ws,
      getConfig: () => config, ledger,
    });
    await reloaded.rehydrateFromLedger();

    expect(reloaded.parentOf("loop")).toBeUndefined();
  });
});
