import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { deliverAgentPaneText } from "../../src/webview/agentPaneDelivery.js";
import { TmuxService, type ExecResult, type SubmitReceipt } from "../../src/tmux/TmuxService.js";
import { looksLikeStrandedSubmittedLine } from "../../src/tmux/TmuxService.js";
import { composerProfileFor } from "../../src/runtime/composerRegion.js";

/**
 * t-2c2384 — Agent pane freeform submit must pass the measured composer profile.
 *
 * Path H (t-a5b186 inventory): without `composer`, sendSubmittedLine falls back to
 * `looksLikeStrandedSubmittedLine`, which only inspects the last meaningful line and cannot
 * see a wrapped draft sitting in a real framed/prompt composer. Path F (`prompt.inject`) already
 * passes the profile; this is the same wiring for the pane freeform door.
 */
describe("t-2c2384 — agent pane freeform submit uses the measured composer", () => {
  it("classifies a wrapping still-staged draft as submit-unconfirmed with the profile", async () => {
    const body = fs.readFileSync(path.join("test/fixtures/claude-composer-wrap/wrapped-staged.text.txt"), "utf8").trim();
    const pane = fs.readFileSync(path.join("test/fixtures/claude-composer-wrap/wrapped-staged.pane.txt"), "utf8");
    // A line long enough that soft-wrap matters for the product panes (pane_width − 4).
    expect(body.length).toBeGreaterThan(100);

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

    await deliverAgentPaneText(
      { sendSubmittedLine, sendKeys: async () => {} },
      "tachyon-h-worker",
      body,
      true,
      "claude",
    );

    expect(sendSubmittedLine).toHaveBeenCalledOnce();
    // Profile reached the primitive — not the bare (session, text) call path H used to take.
    expect(sendSubmittedLine.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ composer: composerProfileFor("claude") }),
    );
    // With the profile, a still-staged wrap is honest unconfirmed — not "submitted".
    expect(receipt).toEqual({ status: "submit-unconfirmed", reason: "still-staged", attempts: 1 });
  });

  it("the legacy last-line heuristic is blind to that same pane — why the bare call site was wrong", async () => {
    const body = fs.readFileSync(path.join("test/fixtures/claude-composer-wrap/wrapped-staged.text.txt"), "utf8").trim();
    const pane = fs.readFileSync(path.join("test/fixtures/claude-composer-wrap/wrapped-staged.pane.txt"), "utf8");
    const plain = pane.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

    // The draft is still in the composer, but the last-line heuristic cannot see it (furniture /
    // wraps under the prompt), so a bare sendSubmittedLine would launder this as submitted.
    expect(looksLikeStrandedSubmittedLine(plain, body)).toBe(false);
  });

  it("stage mode still types without Enter and never asks for a composer profile", async () => {
    const sendSubmittedLine = vi.fn(async () => {});
    const sendKeys = vi.fn(async () => {});

    await deliverAgentPaneText(
      { sendSubmittedLine, sendKeys },
      "tachyon-h-worker",
      "draft only",
      false,
      "claude",
    );

    expect(sendKeys).toHaveBeenCalledWith("tachyon-h-worker", "draft only", false);
    expect(sendSubmittedLine).not.toHaveBeenCalled();
  });
});
