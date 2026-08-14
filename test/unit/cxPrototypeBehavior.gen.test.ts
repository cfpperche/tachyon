import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { registerTools, type BridgeDeps } from "@tachyon/engine/bridge/tools.js";
import { TaskStore } from "@tachyon/engine/tasks/TaskStore.js";
import { TaskPrototypeStore } from "@tachyon/engine/tasks/TaskPrototypeStore.js";

class FakeMcp {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>>();
  registerTool(name: string, _definition: unknown, handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>) {
    this.handlers.set(name, handler);
  }
}

function tools(root: string, tasks: TaskStore, caller: BridgeDeps["caller"]): FakeMcp {
  const mcp = new FakeMcp();
  registerTools(mcp as never, { workspaceRoot: root, tasks, caller, notify: () => {} } as unknown as BridgeDeps);
  return mcp;
}

async function call(mcp: FakeMcp, name: string, args: Record<string, unknown>) {
  const handler = mcp.handlers.get(name);
  if (!handler) throw new Error(`missing tool ${name}`);
  return handler(args);
}

describe("container-generated delegation behavior", () => {
  it("an agent-authored task prototype is stored as an untrusted draft and only first-party approval can select its immutable anchor", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cx-prototype-bridge-"));
    try {
      const taskStore = new TaskStore(root);
      const task = await taskStore.create({ id: "t-119dc1", title: "UI decision", author: "human", now: "2026-07-09T00:00:00.000Z" });
      const agent = tools(root, taskStore, { kind: "agent", name: "ui-agent" });
      const attached = await call(agent, "attach_task_prototype", { id: task.id, title: "Safe mock", html: "<button>Inspect</button><script>document.body.dataset.ok='yes'</script>" });
      expect(attached.isError).toBeFalsy();
      const attachedView = JSON.parse(attached.content[0]!.text) as { summaries: Array<{ state: string; untrustedAgentAuthored: { author: string } }> };
      expect(attachedView.summaries[0]).toMatchObject({ state: "draft", untrustedAgentAuthored: { author: "ui-agent" } });

      const invalid = await call(agent, "attach_task_prototype", { id: task.id, title: "Egress", html: `<img src="https://example.test/leak">` });
      expect(invalid.isError).toBe(true);
      expect(new TaskPrototypeStore(root, task.id).read().prototypes).toHaveLength(1);

      const legacy = tools(root, taskStore, { kind: "legacy" });
      expect((await call(legacy, "attach_task_prototype", { id: task.id, title: "forged", html: "<p>x</p>" })).isError).toBe(true);
      expect(agent.handlers.has("approve_task_prototype")).toBe(false);
      expect(agent.handlers.has("supersede_task_prototype")).toBe(false);
      expect(agent.handlers.has("reject_task_prototype")).toBe(false);

      const draft = new TaskPrototypeStore(root, task.id).read().prototypes[0]!;
      const flagged = await call(agent, "flag_for_human", { id: task.id, reason: "Review exact bytes", kind: "decision", subject: { type: "task-prototype", prototypeId: draft.id } });
      expect(flagged.isError).toBeFalsy();
      expect(taskStore.get(task.id).awaitingHuman?.subject).toEqual({ type: "task-prototype", prototypeId: draft.id });

      const read = await call(agent, "get_task", { id: task.id });
      const text = read.content[0]!.text;
      const payload = JSON.parse(text) as { prototypes: { summaries: Array<{ untrustedAgentAuthored: { author: string } }>; activeApprovedAnchor?: unknown } };
      expect(payload.prototypes.summaries[0]!.untrustedAgentAuthored.author).toBe("ui-agent");
      expect(payload.prototypes.activeApprovedAnchor).toBeUndefined();
      expect(text).not.toContain("document.body.dataset.ok");

      const store = new TaskPrototypeStore(root, task.id);
      const approved = store.approve(draft.id, { expectUpdatedAt: store.read().updatedAt!, now: "2026-07-09T00:01:00.000Z" });
      expect(approved.approved).toMatchObject({ state: "approved", approvedBy: "human", sha256: draft.sha256 });
      const approvedRead = JSON.parse((await call(agent, "get_task", { id: task.id })).content[0]!.text) as { prototypes: { activeApprovedAnchor: { id: string; sha256: string; path: string; contentIsUntrusted: boolean } } };
      expect(approvedRead.prototypes.activeApprovedAnchor).toEqual({ id: draft.id, sha256: draft.sha256, path: draft.relativePath, contentIsUntrusted: true });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
