import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DefaultDenyHostActionPolicy,
  ReloadTransactionStore,
  ensureDefaultExternalPolicy,
  hostActionPolicyPaths,
  loadPinnedExternalPolicy,
  type HostActionExecutionEnvelope,
} from "../../../src/host-action/index.js";
import { VsCodeHostActionAdapter } from "../../../src/agent-vscode/hostActionAdapter.js";
import { VSCODE_RELOAD_WINDOW_CAPABILITY, vscodeReloadWindowDescriptorHash } from "../../../src/agent-vscode/reloadCapability.js";

describe("host-action P1b reload transaction and external policy", () => {
  it("loads reloadWindow from an out-of-workspace policy and fails closed on hash drift", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "host-action-policy-"));
    try {
      const paths = hostActionPolicyPaths(path.join(dir, "global-storage"));
      await expect(loadPinnedExternalPolicy(paths)).resolves.toBeInstanceOf(DefaultDenyHostActionPolicy);

      await ensureDefaultExternalPolicy({
        paths,
        version: "reload-window-v1",
        capabilities: [VSCODE_RELOAD_WINDOW_CAPABILITY],
        allowedAgents: ["claude"],
      });
      const policy = await loadPinnedExternalPolicy(paths);
      expect(policy.capabilityFor("reloadWindow")).toMatchObject({
        id: "vscode.reloadWindow.v1",
        command: "workbench.action.reloadWindow",
      });
      expect(policy.authorize({
        caller: { kind: "agent", name: "claude" },
        delegatedBy: [],
        spec: VSCODE_RELOAD_WINDOW_CAPABILITY,
        args: { value: {}, canonical: "{}", hash: "h" },
      })).toEqual({ ok: true });
      expect(await readFile(paths.pinPath, "utf8")).toMatch(/^[0-9a-f]{64}\n$/);
      expect(vscodeReloadWindowDescriptorHash()).toMatch(/^[0-9a-f]{64}$/);

      await writeFile(paths.policyPath, `${JSON.stringify({ version: "tampered", capabilities: [], allowedAgents: ["claude"] })}\n`);
      const drifted = await loadPinnedExternalPolicy(paths);
      expect(drifted.capabilityFor("reloadWindow")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("recovers reload transactions as verified, wrong-host, failed-return, or result_unknown", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "host-action-reload-"));
    try {
      const file = path.join(dir, "pending.json");
      const store = new ReloadTransactionStore(file);
      const current = { host_instance_id: "host", workspace_id: "ws", extension_build_id: "build", session_epoch: 2 };

      await store.begin({ actionId: "act-ok", command: "workbench.action.reloadWindow", bundle: { ...current, session_epoch: 1 }, deadlineMs: 1000, now: 10 });
      await expect(store.recover({ current, healthOk: true, now: 20 })).resolves.toMatchObject({ actionId: "act-ok", state: "reattached_verified" });

      await store.begin({ actionId: "act-wrong", command: "workbench.action.reloadWindow", bundle: { ...current, host_instance_id: "other", session_epoch: 1 }, deadlineMs: 1000, now: 10 });
      await expect(store.recover({ current, healthOk: true, now: 20 })).resolves.toMatchObject({ state: "returned_wrong_host" });

      await store.begin({ actionId: "act-late", command: "workbench.action.reloadWindow", bundle: { ...current, session_epoch: 1 }, deadlineMs: 1, now: 10 });
      await expect(store.recover({ current, healthOk: true, now: 20 })).resolves.toMatchObject({ state: "failed_to_return" });

      await store.begin({ actionId: "act-unknown", command: "workbench.action.reloadWindow", bundle: { ...current, session_epoch: 2 }, deadlineMs: 1000, now: 10 });
      await expect(store.recover({ current, healthOk: true, now: 20 })).resolves.toMatchObject({ state: "result_unknown" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("agent-vscode adapter persists before executeCommand and rejects non-reload envelopes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "host-action-adapter-"));
    try {
      const commands: string[] = [];
      const store = new ReloadTransactionStore(path.join(dir, "pending.json"));
      const adapter = new VsCodeHostActionAdapter(
        { executeCommand: async (command) => { commands.push(command); } },
        store,
        () => ({ host_instance_id: "host", workspace_id: "ws", extension_build_id: "build", session_epoch: 1 }),
      );
      const envelope: HostActionExecutionEnvelope = {
        actionId: "act-dispatch",
        action: "reloadWindow" as never,
        command: "workbench.action.reloadWindow",
        canonicalArgs: "{}",
        argsHash: "args",
        specId: "vscode.reloadWindow.v1",
        descriptorHash: "descriptor",
        decision: {
          requested_by: { kind: "agent", name: "claude" },
          delegated_by: [],
          policy_version: "v1",
          policy_hash: "policy",
          spec_id: "vscode.reloadWindow.v1",
          descriptor_hash: "descriptor",
          validated_args_hash: "args",
          executor_adapter: "agent-vscode",
        },
      };

      await expect(adapter.execute(envelope)).resolves.toMatchObject({ state: "disconnected", receipt: "reload-dispatched:act-dispatch" });
      expect(commands).toEqual(["workbench.action.reloadWindow"]);
      await expect(store.readPending()).resolves.toMatchObject({ action_id: "act-dispatch" });

      await expect(adapter.execute({ ...envelope, actionId: "act-bad", command: "workbench.action.terminal.new" })).rejects.toMatchObject({
        code: "adapter_failed",
      });
      expect(commands).toEqual(["workbench.action.reloadWindow"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
