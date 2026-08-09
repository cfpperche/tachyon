import { describe, expect, it } from "vitest";
import {
  collectNeedsFor,
  COLLECT_EVERYTHING,
  buildSectionsModel,
  type WorkspaceBundle,
} from "../../src/sections/model.js";

/**
 * t-af3eef — navigation used to block on a serial collect of the whole world.
 *
 * Measured on `main`: `collect` looped over workspaces serially and awaited five engine round-trips
 * inside each — `engineLogHealth`, `tmux.health`, `companion.status`, `worktrees.classified`,
 * `deliveries.classified`. Two of those were real work: the classified worktree read walks every
 * managed checkout, of which this repo had 17, and it grows with the fleet. Opening a Task Detail
 * paid for all of it, across every workspace, before a single pixel could change.
 *
 * t-e88c8a retired `deliveries.classified` with the Deliveries tab, leaving one expensive slice.
 * `SectionCollectNeeds` stays an object anyway — the shape is what makes the next one a one-liner.
 *
 * The fix is not a cache — that would add a second source of truth about the world. It is asking for
 * less: a view collects the slices it reads. These tests pin WHICH views read what, and pin the
 * distinction that makes skipping safe — absent is "not collected", never "none exist".
 */

const bundle = (over: Partial<WorkspaceBundle> = {}): WorkspaceBundle => ({
  control: {
    folderName: "demo",
    workspaceRoot: "/ws",
    wsHash: "h1",
    bridgeUrl: "http://127.0.0.1:1",
    identity: null,
    agents: { total: 0, running: 0 },
    authConfigured: "unknown",
    notes: [],
  } as WorkspaceBundle["control"],
  agents: [],
  approvals: [],
  ...over,
});

describe("t-af3eef — a view collects only what it reads", () => {
  describe("which sections need the expensive classified reads", () => {
    it.each([
      ["overview", true],
      ["worktrees", true],
    ] as const)("%s", (section, worktrees) => {
      expect(collectNeedsFor(section)).toEqual({ worktrees });
    });

    it.each(["engine", "fleet", "inbox", "approvals", "mission", "validations"] as const)(
      "%s needs neither — this is the latency the report was about",
      (section) => {
        expect(collectNeedsFor(section)).toEqual({ worktrees: false });
      },
    );

    it("treats an unknown section as needing nothing rather than everything", () => {
      // Fail cheap, not expensive: a section nobody listed cannot make navigation slow by default.
      expect(collectNeedsFor("some-future-section")).toEqual({ worktrees: false });
    });

    it("still has a way to ask for everything, for the diagnostics dump", () => {
      expect(COLLECT_EVERYTHING).toEqual({ worktrees: true });
    });
  });

  describe("absent means not collected, never none", () => {
    it("reports the slice as not collected when no bundle carried it", () => {
      const model = buildSectionsModel([bundle()], { section: "mission" });

      expect(model.worktreesCollected).toBe(false);
      expect(model.worktrees).toEqual([]);
    });

    it("reports it as collected when a bundle carried it, even if it was genuinely empty", () => {
      // The case the flag exists for: an empty list that IS an answer must not read like a skip.
      const model = buildSectionsModel([bundle({ worktrees: [] })], { section: "worktrees" });

      expect(model.worktreesCollected).toBe(true);
      expect(model.worktrees).toEqual([]);
    });

    it("counts only what was actually collected", () => {
      const collected = buildSectionsModel(
        [bundle({ worktrees: [{ path: "/w", branch: "b", folder: "demo", wsHash: "h1", status: "active" } as never] })],
        { section: "worktrees" },
      );

      expect(collected.worktreesCollected).toBe(true);
      expect(collected.overview.worktreesActive).toBe(1);
    });
  });
});
