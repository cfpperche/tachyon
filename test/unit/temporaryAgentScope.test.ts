import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { SessionLedger } from "@tachyon/engine/resume/SessionLedger.js";
import {
  closeTemporaryAgentScope,
  readTemporaryAgentScopeIdentity,
  temporaryAgentScopeSupport,
  temporaryAgentScopeUnitName,
  wrapTemporaryAgentScopeCommand,
} from "@tachyon/engine/agents/temporaryAgentScope.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition did not converge before timeout");
}

describe("temporary agent systemd-user process scope (t-6e808e)", () => {
  it("declares the capability unavailable when systemd --user cannot be reached", async () => {
    const support = await temporaryAgentScopeSupport("linux", "/definitely/missing/systemctl");
    expect(support).toMatchObject({ ok: false });
    if (!support.ok) expect(support.reason).toMatch(/systemd --user unavailable/i);
  });

  it.runIf(process.platform === "linux")("kills a detached descendant after reloading its durable identity", async () => {
    const support = await temporaryAgentScopeSupport();
    if (!support.ok) return;

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-agent-scope-test-"));
    dirs.push(root);
    const pidFile = path.join(root, "pid");
    const unit = temporaryAgentScopeUnitName("b349073a", "scope-test");
    const childScript = [
      "const {spawn}=require('node:child_process')",
      "const fs=require('node:fs')",
      "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'})",
      `fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid))`,
      "child.unref()",
    ].join(";");
    const command = wrapTemporaryAgentScopeCommand(unit, `${process.execPath} -e ${JSON.stringify(childScript)}`);
    await execFileAsync("/bin/sh", ["-c", command], { encoding: "utf8" });
    await waitFor(() => fs.existsSync(pidFile));
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).not.toThrow();

    const identity = await readTemporaryAgentScopeIdentity(unit, support.bootId);
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-agent-scope-ledger-"));
    dirs.push(workspace);
    const ledger = new SessionLedger(workspace);
    ledger.record("scope-test", {
      def: { cmd: "codex", kind: "agent" },
      cwd: root,
      instance: { lifetime: "temporary", resumePolicy: "collected", lifecycleHooks: false },
      processScope: identity,
    });
    const reloadedIdentity = new SessionLedger(workspace).get("scope-test")?.processScope;
    expect(reloadedIdentity).toEqual(identity);
    if (reloadedIdentity?.capability === "available") {
      await expect(closeTemporaryAgentScope({ ...reloadedIdentity, invocationId: "0".repeat(32) })).rejects.toThrow(/identity is unknown.*InvocationID drift/i);
      expect(() => process.kill(pid, 0)).not.toThrow();
    }
    await closeTemporaryAgentScope(reloadedIdentity!);
    await waitFor(() => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    });
  }, 15_000);
});
