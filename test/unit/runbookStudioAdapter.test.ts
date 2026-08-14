import { describe, it, expect } from "vitest";
import { RunbookStudioAdapter } from "../../src/webview/RunbookStudioAdapter.js";
import { blankRunbookFields } from "../../packages/webview-ui/src/webview/runbook-studio-shell/domain.js";
import type { Workspace } from "@tachyon/engine/workspace/Workspace.js";
import type { StudioSubmit } from "../../src/webview/studioSubmit.js";

type RunbookDef = { steps: string[] };

function fakeWorkspace(opts: { runbooks?: Record<string, RunbookDef>; commands?: Record<string, { cmd: string }>; submitResult?: string[] | undefined } = {}) {
  const runbooks = opts.runbooks ?? {};
  const commands = opts.commands ?? {};
  const submits: StudioSubmit[] = [];
  const ws = {
    config: { runbooks, commands },
    studioDeps: () => ({
      detectClis: async () => [],
      takenNames: () => Object.keys(runbooks),
      commandNames: () => Object.keys(commands),
      defaultCwd: "/ws/root",
      suggestKindForCommand: () => "runbook",
      onSubmit: () => undefined,
    }),
    studioSubmit: (submit: StudioSubmit) => {
      submits.push(submit);
      return opts.submitResult;
    },
  } as unknown as Workspace;
  return { ws, submits };
}

describe("RunbookStudioAdapter", () => {
  it("loads a blank runbook entity with command names in referenceData only", () => {
    const { ws } = fakeWorkspace({ commands: { lint: { cmd: "npm run lint" } } });
    const result = new RunbookStudioAdapter(ws).load(undefined);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.entity).toEqual({ fields: blankRunbookFields() });
    expect(result.referenceData).toEqual({ commandNames: ["lint"] });
    expect(result.entity).not.toHaveProperty("commandNames");
  });

  it("resolves only existing runbook entries through formLogic's fromRunbookDef", () => {
    const { ws } = fakeWorkspace({
      runbooks: { ship: { steps: ["lint", "./deploy.sh"] } },
    });
    const adapter = new RunbookStudioAdapter(ws);
    const loaded = adapter.load("ship");
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok") throw new Error("unreachable");
    expect(loaded.entity).toMatchObject({ name: "ship", fields: { kind: "runbook", steps: "lint\n./deploy.sh" } });
    expect(adapter.load("ghost").status).toBe("not-found");
  });

  it("delegates save to Workspace.studioSubmit with the edit name", async () => {
    const { ws, submits } = fakeWorkspace();
    const patch = { ...blankRunbookFields(), name: "ship", steps: "lint\ntest" };
    const result = await new RunbookStudioAdapter(ws).save("ship", patch);
    expect(result).toEqual({ status: "ok" });
    expect(submits).toEqual([{ state: patch, editingName: "ship" }]);
  });

  it("surfaces studioSubmit validation failures", async () => {
    const { ws } = fakeWorkspace({ submitResult: ["steps: required"] });
    const result = await new RunbookStudioAdapter(ws).save(undefined, { ...blankRunbookFields(), name: "ship" });
    expect(result.status).toBe("error");
    if (result.status !== "error") throw new Error("unreachable");
    expect(result.error).toMatchObject({ code: "validation/runbook-save-failed", source: "validation" });
  });
});
