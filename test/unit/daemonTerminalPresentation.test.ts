import { describe, expect, it } from "vitest";
import {
  DaemonTerminalPresentation,
  type TerminalRestoreEntry,
  type TerminalUiRequest,
} from "@tachyon/engine/workspace/TerminalPresentation.js";

/**
 * `t-9b5acb` — what the engine restores when an editor shell attaches, and what it must not.
 *
 * `DaemonTerminalPresentation` is the engine-side answer to "which agents should be showing a tab".
 * It is the only record that survives a window reload, because Tachyon's attach terminals are created
 * `isTransient` — VS Code deliberately does not revive them, so if this map is wrong the human either
 * loses a tab they had open or gets back one they closed. The second is the t-b88106 defect wearing a
 * different hat, and nothing covered this layer before.
 *
 * These are characterization tests: the behavior is already correct. They exist because the correct
 * behavior is one `entries.delete` away from silently inverting, and the failure would only show up in
 * a real editor host after a reload — the most expensive place to find it.
 */

function harness() {
  const sent: TerminalUiRequest[] = [];
  let stored: TerminalRestoreEntry[] = [];
  const manifest = {
    read: () => stored,
    write: (entries: TerminalRestoreEntry[]) => { stored = entries; },
  };
  const make = () => new DaemonTerminalPresentation({ manifest }, async (request) => { sent.push(request); });
  /** Let the dispatch queue empty; identical in-flight intents are deliberately collapsed. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { sent, manifest, make, settle, storedNow: () => stored };
}

const ALIVE = async () => true;

describe("t-9b5acb — a tab the human closed does not come back", () => {
  it("does not restore an agent whose surface was closed, even though its session is still alive", async () => {
    const { sent, make } = harness();
    const presentation = make();
    presentation.open("reviewer", "tachyon-abc-reviewer");
    expect(presentation.has("reviewer")).toBe(true);

    presentation.close("reviewer");
    expect(presentation.has("reviewer")).toBe(false);

    // A live session is exactly the case that tempts a restore: the agent is still working. Being
    // alive is not a reason to reopen a window the human shut.
    await presentation.restoreOpen(ALIVE);
    sent.length = 0;
    presentation.replay();
    expect(sent).toEqual([]);
  });

  it("survives a reload: an open surface IS restored, so the close above is a decision and not an inability", async () => {
    const { sent, make, manifest } = harness();
    const before = make();
    before.open("reviewer", "tachyon-abc-reviewer");

    // A new engine instance reading the same manifest — what a reload actually produces.
    const after = make();
    expect(after.has("reviewer")).toBe(true);
    expect(manifest.read()).toHaveLength(1);

    await after.restoreOpen(ALIVE);
    sent.length = 0;
    after.replay();
    expect(sent.map((request) => [request.kind, request.agent])).toEqual([["terminal.present", "reviewer"]]);
  });

  it("does not restore an agent whose session died while no shell was attached", async () => {
    // The intent outlived the agent. Presenting it would attach a tab to a session that is gone.
    const { sent, make } = harness();
    const presentation = make();
    presentation.open("reviewer", "tachyon-abc-reviewer");

    const reloaded = make();
    await reloaded.restoreOpen(async () => false);
    sent.length = 0;
    reloaded.replay();
    expect(sent).toEqual([]);
  });

  it("keeps one entry per agent, so a re-open after a session change cannot resurrect the old surface", async () => {
    const { sent, make, settle } = harness();
    const presentation = make();
    presentation.open("reviewer", "tachyon-abc-reviewer-1");
    presentation.open("reviewer", "tachyon-abc-reviewer-2");
    // Drain first: a present that is still in flight suppresses an identical one, so replaying before
    // the queue empties would prove dedup rather than the entry set. (Measured while writing this —
    // the assertion failed with an empty send until the drain was added.)
    await settle();

    await presentation.restoreOpen(ALIVE);
    sent.length = 0;
    presentation.replay();
    expect(sent.map((request) => request.session)).toEqual(["tachyon-abc-reviewer-2"]);
  });

  it("refuses a close aimed at a session it is no longer showing", () => {
    // Restart replaces a session id. A close carrying the OLD id must not delete the entry for the new
    // one, or a relaunch would lose the surface it was supposed to preserve.
    const { make } = harness();
    const presentation = make();
    presentation.open("reviewer", "tachyon-abc-reviewer-2");
    presentation.close("reviewer", "tachyon-abc-reviewer-1");
    expect(presentation.has("reviewer")).toBe(true);
  });
});
