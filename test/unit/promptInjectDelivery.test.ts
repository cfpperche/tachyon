import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeExtensionCommand } from "@tachyon/engine/engine-service/extensionOperationService.js";
import { APPROVAL_CHANNEL_VSCODE_COMMAND } from "@tachyon/engine/engine-service/extensionOperationChannels.js";
import { TmuxService, type ExecResult, type SubmitReceipt } from "@tachyon/engine/tmux/TmuxService.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("t-344fa6 — prompt.inject submits through the measured composer", () => {
  it("reads the pane at delivery time and classifies a wrapped Interface prompt as still staged", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-prompt-inject-"));
    roots.push(root);
    const body = fs.readFileSync("test/fixtures/codex-composer/wrapped-staged.text.txt", "utf8").trim();
    const pane = fs.readFileSync("test/fixtures/codex-composer/wrapped-staged.pane.txt", "utf8");
    expect(body.length).toBeGreaterThan(148); // measured pane width (152) minus the 4-column chrome
    const promptDir = path.join(root, ".tachyon", "prompts");
    fs.mkdirSync(promptDir, { recursive: true });
    fs.writeFileSync(path.join(promptDir, "wrapped.md"), body, "utf8");

    const exec = vi.fn(async (args: string[]): Promise<ExecResult> => (
      args.includes("capture-pane") ? { stdout: pane, stderr: "" } : { stdout: "", stderr: "" }
    ));
    const tmux = new TmuxService(exec);
    let receipt: SubmitReceipt | undefined;
    const sendSubmittedLine = vi.fn(async (
      session: string,
      text: string,
      options?: Parameters<TmuxService["sendSubmittedLine"]>[2],
    ) => {
      receipt = await tmux.sendSubmittedLine(session, text, { ...options, delayMs: 0, submitRetries: 0 });
      return receipt;
    });
    const probeComposerOccupied = vi.fn(async () => false);
    const workspace = {
      workspaceRoot: root,
      manager: {
        list: async () => [{ name: "worker", kind: "agent", running: true }],
        session: () => "tachyon-worker",
        defOf: () => ({ cmd: "codex" }),
      },
      monitor: { probeComposerOccupied },
      // The cached poll says a draft exists; the delivery-time pane probe is authoritative and clear.
      attentionOf: () => ({ state: "idle", composerOccupied: true, hasStartedTurn: true }),
      tmux: { hasSession: async () => true, sendSubmittedLine },
    };

    const result = await executeExtensionCommand({
      workspace: workspace as never,
      activityLog: {} as never,
      providerObservations: {} as never,
      approvalResolutionChannel: APPROVAL_CHANNEL_VSCODE_COMMAND,
      onViewsChanged: () => {},
    }, {
      action: "prompt.inject",
      agent: "worker",
      templateId: "wrapped",
      expectedSha256: createHash("sha256").update(body, "utf8").digest("hex"),
      submit: true,
    });

    expect(result).toMatchObject({ injected: true, mode: "submit" });
    expect(probeComposerOccupied).toHaveBeenCalledWith("worker");
    expect(sendSubmittedLine).toHaveBeenCalledOnce();
    expect(receipt).toEqual({ status: "submit-unconfirmed", reason: "still-staged", attempts: 1 });
    expect(exec.mock.calls.find(([args]) => args.includes("capture-pane"))?.[0]).toContain("-e");
  });
});
