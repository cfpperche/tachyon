import { describe, it, expect } from "vitest";
import {
  classifyStoppedTemporaryResidue,
  formatResidueNames,
  partitionStoppedTemporaryResidue,
} from "@tachyon/engine/agents/stoppedTemporaryResidue.js";
import type { SessionRecord } from "@tachyon/engine/resume/SessionLedger.js";

function temp(rec: Partial<SessionRecord> & Pick<SessionRecord, "def">): SessionRecord {
  return {
    cwd: "/tmp/ws",
    updatedAt: "t0",
    instance: { lifetime: "temporary", resumePolicy: "restartable" },
    ...rec,
  };
}

const emptyInput = {
  declaredNames: new Set<string>(),
  presentSessions: new Set<string>(),
};

describe("classifyStoppedTemporaryResidue", () => {
  it("auto-collects kill-parity crash residue (temp, no session, no worktree, not fork, not clean-exit)", () => {
    const rec = temp({ def: { cmd: "pi", kind: "agent", parent: "coord" } });
    expect(classifyStoppedTemporaryResidue("deadchild", rec, emptyInput)).toEqual({
      name: "deadchild",
      disposition: "auto-collect",
      reason: "kill-parity-no-worktree",
    });
  });

  it("keeps a worktree-owned stopped Temporary for human review (legitimate resume survives)", () => {
    const rec = temp({
      def: { cmd: "pi", kind: "agent" },
      worktree: {
        path: "/tmp/ws/.cache/worktrees/x",
        branch: "tachyon/tmp.x",
        baseRef: "main",
        createdAt: "t0",
        tachyonCreatedBranch: true,
      },
      resume: { runtime: "pi", sessionId: "sess-1" },
    });
    expect(classifyStoppedTemporaryResidue("paused", rec, emptyInput)).toEqual({
      name: "paused",
      disposition: "human-review",
      reason: "owned-worktree",
    });
  });

  it("keeps forks and clean-exits for human review", () => {
    expect(
      classifyStoppedTemporaryResidue(
        "forked",
        temp({ def: { cmd: "pi", kind: "agent", fork: true } }),
        emptyInput,
      )?.reason,
    ).toBe("fork");
    expect(
      classifyStoppedTemporaryResidue(
        "clean",
        temp({
          def: { cmd: "pi", kind: "agent" },
          lifecycle: { state: "clean-exited", exitedAt: "t0" },
        }),
        emptyInput,
      )?.reason,
    ).toBe("clean-exited");
  });

  it("ignores Saved, still-present, and def-less rows", () => {
    const tempRec = temp({ def: { cmd: "pi", kind: "agent" } });
    expect(
      classifyStoppedTemporaryResidue("saved", tempRec, {
        declaredNames: new Set(["saved"]),
        presentSessions: new Set(),
      }),
    ).toBeNull();
    expect(
      classifyStoppedTemporaryResidue("live", tempRec, {
        declaredNames: new Set(),
        presentSessions: new Set(["live"]),
      }),
    ).toBeNull();
    expect(
      classifyStoppedTemporaryResidue("deadpane", tempRec, {
        declaredNames: new Set(),
        presentSessions: new Set(["deadpane"]), // remain-on-exit still present
      }),
    ).toBeNull();
    expect(
      classifyStoppedTemporaryResidue(
        "resume-only",
        {
          cwd: "/tmp",
          updatedAt: "t0",
          resume: { runtime: "pi", sessionId: "x" },
          instance: { lifetime: "saved", resumePolicy: "restartable" },
        },
        emptyInput,
      ),
    ).toBeNull();
  });
});

describe("partitionStoppedTemporaryResidue", () => {
  it("splits kill-parity auto-collect from human-review worktree rows", () => {
    const ledger: Array<[string, SessionRecord]> = [
      ["alpha", temp({ def: { cmd: "pi", kind: "agent" } })],
      [
        "beta",
        temp({
          def: { cmd: "pi", kind: "agent" },
          worktree: {
            path: "/wt",
            branch: "b",
            baseRef: "main",
            createdAt: "t0",
            tachyonCreatedBranch: true,
          },
        }),
      ],
      ["gamma", temp({ def: { cmd: "pi", kind: "agent" } })],
    ];
    const { autoCollect, humanReview } = partitionStoppedTemporaryResidue(ledger, emptyInput);
    expect(autoCollect.map((r) => r.name)).toEqual(["alpha", "gamma"]);
    expect(humanReview.map((r) => r.name)).toEqual(["beta"]);
  });
});

describe("formatResidueNames", () => {
  it("quotes up to four names and summarises the rest", () => {
    expect(formatResidueNames(["b", "a"])).toBe("'a', 'b'");
    expect(formatResidueNames(["e", "d", "c", "b", "a"])).toBe("'a', 'b', 'c', 'd', and 1 more");
  });
});
