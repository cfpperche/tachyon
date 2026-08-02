import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  RECLAIM_RUNBOOK,
  applyReclaimPlan,
  planVscodeTestReclaim,
  renderInventory,
  renderReclaimPlan,
  type CacheEntry,
  type CacheInventory,
  type CheckoutCache,
  type ReclaimIo,
} from "../../scripts/vscode-test-cache.js";

/**
 * t-3374e2 (SDD 398 D5) — the editor-host cache is the largest measured consumer on this host, and
 * every safety property of reclaiming it is asserted HERE rather than trusted to the CLI.
 *
 * Measured 2026-08-02 across the two checkouts that run the harness: 959,107,072 allocated bytes for
 * `vscode-linux-x64-1.128.0` in the primary checkout and 1,054,625,792 for `vscode-linux-x64-1.131.0`
 * in a live agent worktree — ~1 GiB per checkout, in different versions, which is exactly why the
 * plan's original "keep N in workspace/.vscode-test" cannot see the problem: it looks at one checkout.
 *
 * The owner refused automatic GC ("no GC mechanism for now"), so the property that matters most is
 * negative and is the first test below: NOTHING is deleted without an explicit act. The rest are the
 * refusals the investigation named — a running test, an in-flight download, a version a checkout
 * still needs — each stated as a case a future edit has to keep passing.
 */

const ENTRY = (over: Partial<CacheEntry> & Pick<CacheEntry, "version">): CacheEntry => ({
  name: `vscode-linux-x64-${over.version}`,
  platform: "linux-x64",
  bytes: 1_000_000_000,
  shape: "dir",
  complete: true,
  liveRefs: [],
  ...over,
});

const CHECKOUT = (over: Partial<CheckoutCache> & Pick<CheckoutCache, "path">): CheckoutCache => ({
  cachePath: path.join(over.path, ".vscode-test"),
  cacheExists: true,
  entries: [],
  stateBytes: 0,
  harnessActive: false,
  ...over,
});

const INVENTORY = (over: Partial<CacheInventory>): CacheInventory => ({
  checkouts: [],
  store: { path: "/store", entries: [], sameDevice: true },
  liveProbe: "measured",
  ...over,
});

/** An io that fails loudly on ANY call — the only way to prove a code path touched no disk. */
const forbiddenIo = (): ReclaimIo => ({
  mkdirp: (p) => {
    throw new Error(`mkdirp ${p}`);
  },
  rename: (from, to) => {
    throw new Error(`rename ${from} ${to}`);
  },
  symlink: (target, link) => {
    throw new Error(`symlink ${target} ${link}`);
  },
  unlink: (p) => {
    throw new Error(`unlink ${p}`);
  },
  rmrf: (p) => {
    throw new Error(`rmrf ${p}`);
  },
});

/** Records calls instead of performing them. */
function recordingIo(): { io: ReclaimIo; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    io: {
      mkdirp: (p) => void calls.push(`mkdirp ${p}`),
      rename: (from, to) => void calls.push(`rename ${from} ${to}`),
      symlink: (target, link) => void calls.push(`symlink ${target} ${link}`),
      unlink: (p) => void calls.push(`unlink ${p}`),
      rmrf: (p) => void calls.push(`rmrf ${p}`),
    },
  };
}

/** The measured fleet on 2026-08-02: one superseded version in the primary, the newest in a worktree. */
function measuredFleet(over: { harnessActive?: boolean; liveRefs?: string[] } = {}): CacheInventory {
  return INVENTORY({
    checkouts: [
      CHECKOUT({
        path: "/home/goat/tachyon",
        entries: [ENTRY({ version: "1.128.0", bytes: 959_107_072, liveRefs: over.liveRefs ?? [] })],
        stateBytes: 42_003_039,
      }),
      CHECKOUT({
        path: "/wt/claude",
        harnessActive: over.harnessActive ?? false,
        entries: [ENTRY({ version: "1.131.0", bytes: 1_054_625_792 })],
        stateBytes: 18_510_784,
      }),
    ],
  });
}

describe("vscode-test cache reclaim — nothing is deleted without an explicit act (t-3374e2)", () => {
  it("refuses to touch the disk when the plan is not confirmed", () => {
    const plan = planVscodeTestReclaim(measuredFleet());
    expect(plan.actions.some((a) => a.frees > 0)).toBe(true); // non-vacuous: there IS something to delete

    const result = applyReclaimPlan(plan, { confirm: false, io: forbiddenIo() });

    expect(result.applied).toEqual([]);
    expect(result.freedBytes).toBe(0);
    expect(result.refused).toMatch(/--confirm/);
  });

  it("plans nothing at all when the live-process probe could not run", () => {
    const plan = planVscodeTestReclaim(INVENTORY({ ...measuredFleet(), liveProbe: "unavailable" }));

    expect(plan.actions).toEqual([]);
    expect(plan.freesBytes).toBe(0);
    expect(plan.retained.every((r) => r.state === "unverified")).toBe(true);
  });

  it("executes only what the plan listed, in order, once confirmed", () => {
    const plan = planVscodeTestReclaim(measuredFleet());
    const { io, calls } = recordingIo();

    const result = applyReclaimPlan(plan, { confirm: true, io });

    expect(result.refused).toBeUndefined();
    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(plan.actions);
    expect(result.freedBytes).toBe(plan.freesBytes);
    // Every retire deletes the pooled payload and drops the links that pointed at it.
    expect(calls.filter((c) => c.startsWith("rmrf"))).toEqual(["rmrf /store/vscode-linux-x64-1.128.0"]);
  });
});

describe("vscode-test cache reclaim — the refusals the investigation named (t-3374e2)", () => {
  it("never plans a payload a live process is holding", () => {
    const plan = planVscodeTestReclaim(measuredFleet({ liveRefs: ["pid 4242 exe /home/goat/tachyon/.vscode-test/vscode-linux-x64-1.128.0/code"] }));

    expect(plan.actions.some((a) => a.from.includes("/home/goat/tachyon/.vscode-test"))).toBe(false);
    const retained = plan.retained.find((r) => r.checkout === "/home/goat/tachyon");
    expect(retained?.state).toBe("in-use");
    expect(retained?.reason).toMatch(/pid 4242/);
  });

  it("never plans an in-flight download (no is-complete marker)", () => {
    const inv = INVENTORY({
      checkouts: [
        CHECKOUT({ path: "/wt/a", entries: [ENTRY({ version: "1.131.0", complete: false })] }),
        CHECKOUT({ path: "/wt/b", entries: [ENTRY({ version: "1.131.0" })] }),
      ],
    });

    const plan = planVscodeTestReclaim(inv);

    expect(plan.actions.some((a) => a.from.startsWith("/wt/a/"))).toBe(false);
    expect(plan.retained.find((r) => r.checkout === "/wt/a")?.state).toBe("incomplete");
  });

  it("does not mutate a checkout whose harness is running", () => {
    const plan = planVscodeTestReclaim(measuredFleet({ harnessActive: true }));

    expect(plan.actions.some((a) => a.checkout === "/wt/claude")).toBe(false);
    expect(plan.retained.find((r) => r.checkout === "/wt/claude")?.state).toBe("harness-active");
  });

  it("never retires a POOLED payload a live process is executing", () => {
    // Once a version is shared, the running editor host shows up on the store path, not the
    // checkout's: /proc/<pid>/exe follows the symlink. The checkout looks idle; the store does not.
    const inv = INVENTORY({
      checkouts: [
        CHECKOUT({ path: "/wt/a", entries: [ENTRY({ version: "1.128.0", shape: "store-link", bytes: 0 })] }),
        CHECKOUT({ path: "/wt/b", entries: [ENTRY({ version: "1.131.0", shape: "store-link", bytes: 0 })] }),
      ],
      store: {
        path: "/store",
        sameDevice: true,
        entries: [
          { name: "vscode-linux-x64-1.128.0", platform: "linux-x64", version: "1.128.0", bytes: 900, liveRefs: ["pid 7 exe /store/vscode-linux-x64-1.128.0/code"] },
          { name: "vscode-linux-x64-1.131.0", platform: "linux-x64", version: "1.131.0", bytes: 100, liveRefs: [] },
        ],
      },
    });

    const plan = planVscodeTestReclaim(inv);

    expect(plan.actions).toEqual([]);
    expect(plan.freesBytes).toBe(0);
    expect(plan.notes.join(" ")).toMatch(/pid 7/);
  });

  it("never touches a symlink Tachyon did not create", () => {
    const inv = INVENTORY({
      checkouts: [CHECKOUT({ path: "/wt/a", entries: [ENTRY({ version: "1.131.0", shape: "other-link", bytes: 0 })] })],
    });

    const plan = planVscodeTestReclaim(inv);

    expect(plan.actions).toEqual([]);
    expect(plan.retained[0]?.state).toBe("foreign-link");
  });

  it("keeps the newest version and never leaves a checkout without one", () => {
    const plan = planVscodeTestReclaim(measuredFleet());

    const retired = plan.actions.filter((a) => a.kind === "retire").map((a) => a.version);
    expect(retired).toEqual(["1.128.0"]);
    // The newest is linked into the checkout that loses its own copy, BEFORE the retire.
    const linkIdx = plan.actions.findIndex((a) => a.kind === "link" && a.checkout === "/home/goat/tachyon");
    const retireIdx = plan.actions.findIndex((a) => a.kind === "retire");
    expect(linkIdx).toBeGreaterThanOrEqual(0);
    expect(linkIdx).toBeLessThan(retireIdx);
    expect(plan.actions[linkIdx]?.version).toBe("1.131.0");
  });

  it("retires nothing when the only pooled version is the newest one", () => {
    const inv = INVENTORY({
      checkouts: [
        CHECKOUT({ path: "/wt/a", entries: [ENTRY({ version: "1.131.0", bytes: 1_000 })] }),
        CHECKOUT({ path: "/wt/b", entries: [ENTRY({ version: "1.131.0", bytes: 1_000 })] }),
      ],
    });

    const plan = planVscodeTestReclaim(inv);

    expect(plan.actions.some((a) => a.kind === "retire")).toBe(false);
    // The duplicate copy still goes: one payload, two checkouts pointing at it.
    expect(plan.actions.map((a) => a.kind)).toEqual(["adopt", "dedupe"]);
    expect(plan.freesBytes).toBe(1_000);
  });

  it("honours --keep so an older version can be held back deliberately", () => {
    const inv = INVENTORY({
      checkouts: [
        CHECKOUT({ path: "/wt/a", entries: [ENTRY({ version: "1.131.0", bytes: 10 })] }),
        CHECKOUT({ path: "/wt/b", entries: [ENTRY({ version: "1.128.0", bytes: 20 })] }),
      ],
    });

    expect(planVscodeTestReclaim(inv, { keep: 2 }).actions.some((a) => a.kind === "retire")).toBe(false);
    expect(planVscodeTestReclaim(inv, { keep: 1 }).actions.filter((a) => a.kind === "retire")).toHaveLength(1);
  });

  it("refuses to pool across a filesystem boundary rather than copying a gigabyte", () => {
    const inv = INVENTORY({
      checkouts: [CHECKOUT({ path: "/wt/a", entries: [ENTRY({ version: "1.131.0" })] })],
      store: { path: "/other-fs/store", entries: [], sameDevice: false },
    });

    const plan = planVscodeTestReclaim(inv);

    expect(plan.actions).toEqual([]);
    expect(plan.notes.join(" ")).toMatch(/filesystem/i);
  });
});

describe("vscode-test cache reclaim — reported bytes say WHERE they came back (t-3374e2 D7)", () => {
  it("names WSL on every line that reports reclaimed bytes", () => {
    const plan = planVscodeTestReclaim(measuredFleet());
    const reports = [renderReclaimPlan(plan, { confirm: false }), renderReclaimPlan(plan, { confirm: true }), renderInventory(measuredFleet())];

    for (const report of reports) {
      // A "claim" is a line that states a number of bytes AND attributes it to freeing/reclaiming.
      // That is the surface constraint 4 of t-3374e2 governs: a byte figure somebody could read as
      // space they got back. Descriptive sizes ("this payload is N bytes") are not claims.
      const claims = report.split("\n").filter((line) => /\b(frees|freed|reclaim\w*)\b/i.test(line) && /\d[\d,]*\s+bytes/.test(line));
      expect(claims.length).toBeGreaterThan(0); // non-vacuous
      for (const line of claims) expect(line).toMatch(/WSL/);
    }
  });

  it("says the Windows VHDX does not shrink, and points at the runbook that explains it", () => {
    const report = renderReclaimPlan(planVscodeTestReclaim(measuredFleet()), { confirm: false });

    expect(report).toMatch(/VHDX/);
    expect(report).toContain(RECLAIM_RUNBOOK);
  });

  it("points at a runbook that actually exists", () => {
    expect(fs.existsSync(path.resolve(__dirname, "../..", RECLAIM_RUNBOOK))).toBe(true);
  });
});

describe("D7 runbook separates the two targets, with a Microsoft source (t-3374e2)", () => {
  const runbook = (): string => fs.readFileSync(path.resolve(__dirname, "../..", RECLAIM_RUNBOOK), "utf8");

  it("states that freeing bytes in WSL does not shrink the VHDX", () => {
    const text = runbook();
    expect(text).toMatch(/VHDX/);
    expect(text).toMatch(/ext4/);
    expect(text).toMatch(/do not automatically reduce in size when you delete files/i);
  });

  it("names the host-side commands and cites Microsoft for them", () => {
    const text = runbook();
    expect(text).toMatch(/wsl(\.exe)? --shutdown/);
    expect(text).toMatch(/compact vdisk|Optimize-VHD/);
    expect(text).toMatch(/https:\/\/learn\.microsoft\.com\//);
  });

  it("says Tachyon does not automate the host step", () => {
    expect(runbook()).toMatch(/does not automate|never automates|not automated/i);
  });
});
