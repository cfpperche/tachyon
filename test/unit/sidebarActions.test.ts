import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { actionsFor, primaryActions, moreActions, ACTION_META, type ActionId } from "../../src/sidebar/actions";
import type { AgentVM } from "@tachyon/shared/sidebar/types";

const A = (o: Partial<AgentVM> & { status: AgentVM["status"] }): AgentVM => ({ name: "x", kind: "agent", ...o });

describe("sidebar action matrix (spec 237)", () => {
  it("running → graceful stop + forced kill + restart, no spawn", () => {
    const a = actionsFor(A({ status: "running" }));
    expect(a).toContain("stop"); expect(a).toContain("kill"); expect(a).toContain("restart"); expect(a).not.toContain("spawn");
    expect(a[0]).toBe("activity"); // spec 238 — the cockpit is the primary action for an AI agent with a pane
    expect(a[1]).toBe("probes"); // spec 322 — durable per-agent probe history sits with its sibling record view
    expect(a[2]).toBe("inspect"); // integrated terminal
    expect(a[3]).toBe("openPane"); // t-610355 — first-party agent pane next to it
    expect(primaryActions(A({ status: "running" }))).toEqual(["activity", "inspect", "openPane"]);
    expect(primaryActions(A({ status: "running" }))).not.toContain("stop");
    expect(primaryActions(A({ status: "running" }))).not.toContain("kill");
    expect(moreActions(A({ status: "running" }))).toContain("stop");
    expect(moreActions(A({ status: "running" }))).toContain("kill");
  });

  it("spec 238 — activity is offered for AI agents even without a live pane, but not for terminals", () => {
    expect(primaryActions(A({ status: "running" }))).toContain("activity");
    expect(actionsFor(A({ status: "running", kind: "terminal" }))).not.toContain("activity"); // terminal: no transcript
    expect(actionsFor(A({ status: "stopped" }))).toContain("activity"); // durable history, not tied to a pane
    expect(primaryActions(A({ status: "stopped", resumable: true }))).toEqual(["activity"]);
    expect(actionsFor(A({ status: "stopped", exited: true }))).toContain("activity"); // clean-exit pane has a transcript
  });
  it("crashed → inspect + openPane + reapPane + restart", () => {
    expect(actionsFor(A({ status: "crashed" }))).toEqual(expect.arrayContaining(["inspect", "openPane", "reapPane", "restart"]));
    expect(actionsFor(A({ status: "crashed" }))).not.toContain("stop");
    // t-c515c0 — there is no process to force-kill; what is left is the session tmux still holds.
    expect(actionsFor(A({ status: "crashed" }))).not.toContain("kill");
  });
  it("stopped → spawn; + resume only when resumable; NO inspect/openPane (no pane to open)", () => {
    expect(actionsFor(A({ status: "stopped" }))).toContain("spawn");
    expect(actionsFor(A({ status: "stopped" }))).not.toContain("resume");
    expect(actionsFor(A({ status: "stopped", resumable: true }))).toContain("resume");
    expect(actionsFor(A({ status: "stopped" }))).not.toContain("kill");
    expect(actionsFor(A({ status: "stopped" }))).not.toContain("inspect");
    expect(actionsFor(A({ status: "stopped" }))).not.toContain("openPane");
    expect(primaryActions(A({ status: "stopped" }))).not.toContain("inspect");
    expect(primaryActions(A({ status: "stopped" }))).not.toContain("openPane");
  });
  /**
   * t-9d76b1 established the half that stays: a stop Tachyon ASKED for, which grok answers with 130, is
   * `stopped` and not `crashed`, and the row still has to carry the measured `pane: true` — `hasPane`'s
   * fallback reads "stopped" as "no pane", and without the marker the row would lose the tmux session it
   * still owns. That is a real fix and this test is not permission to undo it.
   *
   * t-c515c0 replaces what that task ALSO asserted here — that the row "keeps its postmortem pane doors"
   * because the pane "still holds the `^C` and the code". Measured over the full scrollback on claude,
   * codex, grok and pi, the pane holds ONE line: tmux's own `Pane is dead (status …)`. The TUI restores
   * the primary screen on the way out. So the doors that promised a transcript are gone, the door that
   * reaps the session stays, and it is named for what it does.
   *
   * It is asserted as an EXACT SET, which is the other half of what went wrong: the assertion this
   * replaces used `arrayContaining`, so it passed green while the row offered `Kill forced` for a
   * process that had already exited. A containment check cannot see a wrong set — only an equality can.
   */
  it("a requested stop offers no pane doors, keeps one door to reap the session, and is NOT a crash", () => {
    const a = A({ status: "stopped", pane: true, sub: "stopped (exit 130)", resumable: true });
    expect(actionsFor(a)).toEqual([
      "activity", "probes", "reapPane",
      "restart", "restartNew", "restartForceNew",
      "resume", "continueTask", "edit", "editYaml", "clone",
    ]);
    expect(primaryActions(a)).toEqual(["activity"]);
    expect(moreActions(a)).toEqual([
      "probes", "reapPane",
      "restart", "restartNew", "restartForceNew",
      "resume", "continueTask", "edit", "editYaml", "clone",
    ]);
    // The pair the owner had to choose between: a stop and a crash must not offer the same repertoire.
    const crashed = A({ status: "crashed", pane: true, resumable: true });
    expect(actionsFor(a)).not.toEqual(actionsFor(crashed));
    expect(actionsFor(crashed)).toContain("inspect"); // its pane DID keep the screen it died on
    expect(actionsFor(a)).not.toContain("inspect");
  });

  /**
   * t-c515c0 — the EXACT set each state offers, stated once, in one place.
   *
   * This exists because containment checks are what let the defect ship. Every assertion about this
   * matrix used `toContain` / `arrayContaining`, so a row could offer a whole extra door — `Kill forced`
   * on an agent that had already exited — with every test green. A set equality is the only shape that
   * fails when the set is WRONG rather than merely incomplete, and it fails just as loudly when someone
   * renames an action instead of removing it.
   *
   * Read it as the answer to "what does a person get on this row?", state by state.
   */
  const PROCESS_PRESUMING: ActionId[] = ["inspect", "openPane", "stop", "kill", "reinjectContinuity", "injectPrompt"];
  const MATRIX: { state: string; vm: AgentVM; all: ActionId[]; inline: ActionId[]; live: boolean }[] = [
    {
      state: "running",
      vm: A({ status: "running" }),
      all: ["activity", "probes", "inspect", "openPane", "stop", "kill", "restart", "restartNew", "restartForceNew", "reinjectContinuity", "injectPrompt", "continueTask", "edit", "editYaml", "clone"],
      inline: ["activity", "inspect", "openPane"],
      live: true,
    },
    {
      // The graceful stop did not land: the process IS still there, so the live repertoire is correct.
      state: "stop-failed",
      vm: A({ status: "stop-failed" }),
      all: ["activity", "probes", "inspect", "openPane", "stop", "kill", "restart", "restartNew", "restartForceNew", "reinjectContinuity", "injectPrompt", "continueTask", "edit", "editYaml", "clone"],
      inline: ["activity", "inspect", "openPane"],
      live: true,
    },
    {
      state: "stopping (graceful stop in flight)",
      vm: A({ status: "stopping" }),
      all: ["activity", "probes"],
      inline: ["activity"],
      live: false,
    },
    {
      // Died without restoring the screen, so its pane still holds what it painted last: doors stay.
      state: "crashed (pane held)",
      vm: A({ status: "crashed", pane: true, resumable: true }),
      all: ["activity", "probes", "inspect", "openPane", "reapPane", "restart", "restartNew", "restartForceNew", "resume", "continueTask", "edit", "editYaml", "clone"],
      inline: ["activity", "inspect", "openPane"],
      live: false,
    },
    {
      // THE ROW THIS TASK IS ABOUT: the human asked for the stop, grok answered 130.
      state: "stopped on request (pane held, exit 130)",
      vm: A({ status: "stopped", pane: true, sub: "stopped (exit 130)", resumable: true }),
      all: ["activity", "probes", "reapPane", "restart", "restartNew", "restartForceNew", "resume", "continueTask", "edit", "editYaml", "clone"],
      inline: ["activity"],
      live: false,
    },
    {
      // Exited 0 and Tachyon already collected the pane: nothing left to reap.
      state: "clean exit, pane collected",
      vm: A({ status: "stopped", exited: true, pane: false, resumable: true }),
      all: ["activity", "probes", "restart", "restartNew", "restartForceNew", "resume", "continueTask", "edit", "editYaml", "clone"],
      inline: ["activity"],
      live: false,
    },
    {
      // Exited 0 but the pane is still standing — reapable, and still not openable.
      state: "clean exit, pane not yet collected",
      vm: A({ status: "stopped", exited: true, pane: true, resumable: true }),
      all: ["activity", "probes", "reapPane", "restart", "restartNew", "restartForceNew", "resume", "continueTask", "edit", "editYaml", "clone"],
      inline: ["activity"],
      live: false,
    },
    {
      // The residue t-c515c0 found: `pane` absent entirely. The old fallback invented one here.
      state: "clean exit, pane unstamped",
      vm: A({ status: "stopped", exited: true }),
      all: ["activity", "probes", "restart", "restartNew", "restartForceNew", "continueTask", "edit", "editYaml", "clone"],
      inline: ["activity"],
      live: false,
    },
    {
      state: "never started / killed (no pane)",
      vm: A({ status: "stopped", resumable: true }),
      all: ["activity", "probes", "spawn", "resume", "continueTask", "edit", "editYaml", "clone"],
      inline: ["activity"],
      live: false,
    },
  ];

  it.each(MATRIX)("exact action set — $state", ({ state, vm, all, inline, live }) => {
    expect(actionsFor(vm), `${state}: full set`).toEqual(all);
    expect(primaryActions(vm), `${state}: inline bar`).toEqual(inline);
    expect(moreActions(vm), `${state}: overflow`).toEqual(all.filter((id) => !inline.includes(id)));
    if (!live) {
      // Nothing that presumes a process survives on a row that has none. Named as a list so a NEW
      // process-presuming action has to be classified here rather than quietly appear on a dead row.
      for (const id of PROCESS_PRESUMING) {
        if (id === "inspect" || id === "openPane") continue; // a crash's pane still has a screen to show
        expect(actionsFor(vm), `${state}: offers ${id} with no process`).not.toContain(id);
      }
    }
  });

  it("t-c515c0 — a dead row never offers Kill forced, on any shape that reaches one", () => {
    for (const vm of MATRIX.filter((m) => !m.live).map((m) => m.vm)) {
      expect(actionsFor(vm)).not.toContain("kill");
      expect(primaryActions(vm)).not.toContain("kill");
      expect(moreActions(vm)).not.toContain("kill");
    }
    // …and the door that replaces it is never offered where there is a process to stop instead.
    for (const vm of MATRIX.filter((m) => m.live).map((m) => m.vm)) {
      expect(actionsFor(vm)).not.toContain("reapPane");
    }
  });

  it("t-c515c0 — reapPane is named and iconed for reaping, not for killing", () => {
    expect(ACTION_META.reapPane.label).not.toMatch(/kill/i);
    expect(ACTION_META.reapPane.icon).not.toMatch(/disconnect|trash/);
    expect(ACTION_META.kill.label).toMatch(/kill/i); // the live row's door keeps saying what it does
  });

  it("clean exit (stopped + exited) → no Open terminal/pane; Activity/Restart/Resume, NOT spawn", () => {
    const a = actionsFor(A({ status: "stopped", exited: true }));
    expect(a).toEqual(expect.arrayContaining(["activity", "restart"]));
    expect(a).not.toContain("inspect");
    expect(a).not.toContain("openPane");
    expect(a).not.toContain("stop");
    expect(a).not.toContain("spawn");
    const inline = primaryActions(A({ status: "stopped", exited: true, resumable: true }));
    expect(inline).toEqual(["activity"]);
    expect(inline).not.toContain("inspect");
    expect(inline).not.toContain("openPane");
    expect(inline).not.toContain("kill");
    expect(moreActions(A({ status: "stopped", exited: true, resumable: true }))).toEqual(expect.arrayContaining(["restart", "resume"]));
    // t-c515c0 — this used to assert `kill`, on the reasoning that "dead pane still exists". It did not:
    // for a CLEAN exit Tachyon collects the pane and stamps `pane: false`, and this shape (no `pane` at
    // all) was reaching the old fallback's `|| !!a.exited` arm and inventing one. A row offering to reap
    // a session that is already gone is the same defect as offering to kill a process that already
    // exited — the guard now says the row has neither door.
    expect(moreActions(A({ status: "stopped", exited: true }))).not.toContain("kill");
    expect(moreActions(A({ status: "stopped", exited: true }))).not.toContain("reapPane");
    expect(actionsFor(A({ status: "stopped", exited: true, resumable: true }))).toContain("resume");
  });
  it("clean exit after auto-clear → Activity/Restart/Resume, no Kill and no Start", () => {
    const a = A({ status: "stopped", exited: true, pane: false, resumable: true, canDismiss: true });
    expect(actionsFor(a)).toEqual(expect.arrayContaining(["activity", "restart", "resume"]));
    // t-e722ce — a declared AI row's removal is Agent Studio → Forget's; the card offers none.
    expect(actionsFor(a)).not.toContain("remove");
    expect(actionsFor(a)).not.toContain("inspect");
    expect(actionsFor(a)).not.toContain("openPane");
    expect(actionsFor(a)).not.toContain("kill");
    expect(actionsFor(a)).not.toContain("spawn");
    expect(primaryActions(a)).toEqual(["activity"]);
    expect(moreActions(a)).toEqual(expect.arrayContaining(["restart", "resume"]));
  });
  it("restart is offered for declared and ad-hoc agents, but only in the overflow menu", () => {
    const declared = A({ status: "running" });
    const adhoc = A({ status: "running", adhoc: true, canDismiss: true });
    expect(actionsFor(declared)).toContain("restart");
    expect(primaryActions(declared)).not.toContain("restart");
    expect(moreActions(declared)).toContain("restart");
    expect(actionsFor(adhoc)).toContain("restart");
    expect(primaryActions(adhoc)).not.toContain("restart");
    expect(moreActions(adhoc)).toContain("restart");
  });
  it("spec 389 — restart variants live in the overflow (no QuickPick): default + new + force-new", () => {
    const a = A({ status: "running" });
    expect(actionsFor(a)).toEqual(expect.arrayContaining(["restart", "restartNew", "restartForceNew"]));
    expect(primaryActions(a)).not.toContain("restart");
    expect(primaryActions(a)).not.toContain("restartNew");
    expect(primaryActions(a)).not.toContain("restartForceNew");
    const more = moreActions(a);
    expect(more).toEqual(expect.arrayContaining(["restart", "restartNew", "restartForceNew"]));
    // Default Restart sits with stop/kill lifecycle cluster; variants follow.
    const i = more.indexOf("restart");
    expect(more.indexOf("restartNew")).toBeGreaterThan(i);
    expect(more.indexOf("restartForceNew")).toBeGreaterThan(more.indexOf("restartNew"));
  });
  it("clean-exit ad-hoc postmortem keeps activity inline and restart in overflow", () => {
    const a = A({ status: "stopped", exited: true, pane: false, resumable: true, adhoc: true, canDismiss: true });
    expect(actionsFor(a)).toEqual(expect.arrayContaining(["activity", "restart", "resume", "remove"]));
    expect(primaryActions(a)).not.toContain("restart");
    expect(primaryActions(a)).toEqual(["activity"]);
    expect(moreActions(a)).toEqual(expect.arrayContaining(["restart", "resume", "remove"]));
  });
  it("stopping → durable-record views + Remove; blocks pane-contending actions while graceful stop is in flight", () => {
    // spec 322 — probes, like activity, reads durable on-disk records and never contends for the pane,
    // so it stays available during a graceful stop.
    expect(actionsFor(A({ status: "stopping" }))).toEqual(["activity", "probes"]);
    expect(actionsFor(A({ status: "stopping", adhoc: true }))).toEqual(["activity", "probes", "remove"]);
    expect(primaryActions(A({ status: "stopping" }))).toEqual(["activity"]);
    expect(moreActions(A({ status: "stopping" }))).toEqual(["probes"]);
  });
  it("stop-failed → live pane actions stay available for retry or forced kill", () => {
    const a = A({ status: "stop-failed" });
    expect(actionsFor(a)).toEqual(expect.arrayContaining(["inspect", "openPane", "stop", "kill", "restart"]));
    expect(primaryActions(a)).toEqual(["activity", "inspect", "openPane"]);
    expect(moreActions(a)).toEqual(expect.arrayContaining(["probes", "stop", "kill", "restart"]));
  });
  it("resume offered on crashed when resumable (mirrors the tree)", () => {
    expect(actionsFor(A({ status: "crashed", resumable: true }))).toContain("resume");
    expect(actionsFor(A({ status: "crashed" }))).not.toContain("resume");
  });
  it("capability gates: fork/promote/worktree", () => {
    expect(actionsFor(A({ status: "running", forkable: true }))).toContain("fork");
    expect(actionsFor(A({ status: "stopped", adhoc: true, kind: "terminal" }))).toContain("promote");
    expect(actionsFor(A({ status: "running", adhoc: true }))).toContain("remove");
    expect(actionsFor(A({ status: "stopped", adhoc: true, canDismiss: true }))).toContain("remove");
    expect(actionsFor(A({ status: "running", worktree: "b" }))).toEqual(expect.arrayContaining(["reviewWorktree", "createPr"]));
    // t-e722ce — the worktree row keeps its READ actions and loses the destructive one.
    expect(actionsFor(A({ status: "running", worktree: "b" }))).not.toContain("removeWorktree" as ActionId);
  });
  it("spec 322 — probes: offered wherever activity is (ai, pane-independent), more-menu only, never terminals", () => {
    expect(actionsFor(A({ status: "running" }))).toContain("probes");
    expect(actionsFor(A({ status: "stopped" }))).toContain("probes"); // durable records, no pane needed
    expect(actionsFor(A({ status: "running", kind: "terminal" }))).not.toContain("probes"); // terminals never launch probes
    expect(primaryActions(A({ status: "running" }))).not.toContain("probes"); // "…" menu only
    expect(moreActions(A({ status: "running" }))).toContain("probes");
  });
  it("spec 381 — injectPrompt is offered for running AI only", () => {
    expect(actionsFor(A({ status: "running", kind: "agent" }))).toContain("injectPrompt");
    expect(actionsFor(A({ status: "idle", kind: "agent" }))).toContain("injectPrompt");
    expect(actionsFor(A({ status: "running", kind: "terminal" }))).not.toContain("injectPrompt");
    expect(actionsFor(A({ status: "stopped", kind: "agent" }))).not.toContain("injectPrompt");
    expect(primaryActions(A({ status: "running", kind: "agent" }))).not.toContain("injectPrompt");
    expect(moreActions(A({ status: "running", kind: "agent" }))).toContain("injectPrompt");
  });

  it("spec 306 — a throttled agent is running-like: keeps reinjectContinuity", () => {
    expect(actionsFor(A({ status: "throttled", kind: "agent" }))).toContain("injectPrompt");
    expect(actionsFor(A({ status: "throttled", kind: "agent" }))).toContain("reinjectContinuity");
    expect(actionsFor(A({ status: "throttled" }))).toContain("stop");
    expect(actionsFor(A({ status: "throttled" }))).toContain("kill");
    expect(actionsFor(A({ status: "throttled" }))).not.toContain("spawn");
  });
  it("management actions always present", () => {
    expect(actionsFor(A({ status: "running" }))).toEqual(expect.arrayContaining(["edit", "clone"]));
  });
  /**
   * t-41117e — Continue task in… is a Saved-Agent-only more-menu action.
   * The webview opens the destination picker; the host never sees continueTask as a command id.
   */
  it("continueTask is offered for saved AI rows, not temporary or terminals", () => {
    expect(actionsFor(A({ status: "running" }))).toContain("continueTask");
    expect(actionsFor(A({ status: "stopped" }))).toContain("continueTask");
    expect(moreActions(A({ status: "running" }))).toContain("continueTask");
    expect(primaryActions(A({ status: "running" }))).not.toContain("continueTask");
    expect(actionsFor(A({ status: "running", adhoc: true }))).not.toContain("continueTask");
    expect(actionsFor(A({ status: "stopped", kind: "terminal" }))).not.toContain("continueTask");
    expect(ACTION_META.continueTask.label).toMatch(/Continue task/i);
  });
  it("ad-hoc agent rows omit declared-only edit actions", () => {
    const actions = actionsFor(A({ status: "running", adhoc: true }));
    expect(actions).toContain("remove");
    expect(actions).not.toContain("promote");
    expect(actions).not.toContain("edit");
    expect(actions).not.toContain("editYaml");
    expect(actions).not.toContain("clone");
    expect(moreActions(A({ status: "running", adhoc: true }))).toContain("remove");
    expect(moreActions(A({ status: "running", adhoc: true }))).not.toContain("promote");
  });

  /**
   * t-7b7701 — promote writes a terminal declaration. The door refuses any other kind, so
   * offering it on a Temporary agent (a fork) was a button that could only fail. A declared
   * terminal is already saved. The label names what the door does, not tachyon.yml.
   */
  it("t-7b7701 — promote is offered only for a Temporary terminal, never for an agent", () => {
    expect(actionsFor(A({ status: "stopped", adhoc: true }))).not.toContain("promote");
    expect(actionsFor(A({ status: "running", adhoc: true }))).not.toContain("promote");
    expect(actionsFor(A({ status: "stopped", adhoc: true, kind: "terminal" }))).toContain("promote");
    expect(actionsFor(A({ status: "running", adhoc: true, kind: "terminal" }))).toContain("promote");
    expect(actionsFor(A({ status: "stopped", kind: "terminal" }))).not.toContain("promote");
    expect(moreActions(A({ status: "stopped", adhoc: true, kind: "terminal" }))).toContain("promote");
    expect(primaryActions(A({ status: "stopped", adhoc: true, kind: "terminal" }))).not.toContain("promote");
    expect(ACTION_META.promote.label).toBe("Save as terminal declaration");
    expect(ACTION_META.promote.label).not.toMatch(/tachyon\.yml/);
  });

  /**
   * `t-4662e9` — renaming an agent belongs to the Agent Form, and to nothing on this surface.
   *
   * The sidebar's Rename invoked `config.agent.rename`, which rewrites the `tachyon.yml` entry, while
   * the Agent Form runs the canonical profile lifecycle — authority re-signing, digest, retiring the
   * old name. One word, two different operations. The ad-hoc row made it plainer: the action was
   * pushed unconditionally, so it offered to rename a declared entity that does not exist.
   *
   * What is asserted is an ABSENCE, which is the kind of fix that regresses silently. Checking every
   * row shape is what makes a future `out.push("rename")` fail here instead of in someone's hands.
   */
  it("offers no rename on any row shape — that operation is the Agent Form's", () => {
    const shapes = [
      A({ status: "running" }),
      A({ status: "running", adhoc: true }),
      A({ status: "stopped" }),
      A({ status: "stopping" }),
      A({ status: "crashed" }),
      A({ status: "running", kind: "terminal" }),
      A({ status: "running", worktree: "feature/x" }),
    ];
    for (const shape of shapes) {
      expect(actionsFor(shape)).not.toContain("rename" as ActionId);
      expect(moreActions(shape)).not.toContain("rename" as ActionId);
      expect(primaryActions(shape)).not.toContain("rename" as ActionId);
    }
  });
  /**
   * t-e722ce — the sidebar offers removal ONLY where Agent Studio cannot.
   *
   * A declared AI agent is backed by a canonical profile, and Agent Studio → Forget now runs the
   * whole cascade for it. Leaving a second button here is what produced the dead end: the card read
   * the ledger, the Forget read the ledger, Control read the registry, and the one that was OFFERED
   * and the one that WORKED were not the same button on the same day.
   *
   * An ad-hoc agent has no canonical profile to forget and a declared terminal has no Studio page,
   * so both keep their door. Asserting the absence AND the presence together is the point: this test
   * fails if someone puts the canonical Remove back, and equally if someone strips the last human
   * door from the rows Studio was never able to serve.
   */
  it("removal is offered only for rows Agent Studio cannot forget", () => {
    for (const a of [
      A({ status: "running", adhoc: true }),
      A({ status: "stopped", adhoc: true, canDismiss: true }),
      A({ status: "running", kind: "terminal" }),
      A({ status: "stopped", kind: "terminal" }),
    ]) {
      const actions = actionsFor(a);
      expect(actions).toContain("remove");
      expect(actions).not.toContain("dismiss");
      expect(actions).not.toContain("delete");
    }
    for (const a of [
      A({ status: "running" }),
      A({ status: "stopped" }),
      A({ status: "stopping" }),
      A({ status: "crashed" }),
      A({ status: "running", worktree: "feature/x" }),
    ]) {
      expect(actionsFor(a)).not.toContain("remove");
      expect(moreActions(a)).not.toContain("remove");
      expect(primaryActions(a)).not.toContain("remove");
    }
  });

  /** t-e722ce — the standalone worktree removal left the surface entirely; it has no row shape. */
  it("offers no standalone worktree removal on any row shape", () => {
    for (const a of [
      A({ status: "running", worktree: "feature/x" }),
      A({ status: "stopped", worktree: "feature/x" }),
      A({ status: "running", worktree: "feature/x", adhoc: true }),
      A({ status: "crashed", worktree: "feature/x" }),
    ]) {
      expect(actionsFor(a)).not.toContain("removeWorktree" as ActionId);
      expect(moreActions(a)).not.toContain("removeWorktree" as ActionId);
    }
  });
  it("primary is capped at 5 and inline+more partition the set with no overlap", () => {
    const a = A({ status: "running", forkable: true, worktree: "b", adhoc: true });
    const prim = primaryActions(a), more = moreActions(a);
    expect(prim.length).toBeLessThanOrEqual(5);
    expect(prim.filter((x) => more.includes(x))).toEqual([]); // disjoint
    expect(new Set([...prim, ...more])).toEqual(new Set(actionsFor(a))); // cover the full set
  });

  it("inline toolbar is read-only only; lifecycle/destructive actions live in overflow for declared and ad-hoc agents", () => {
    const unsafe: ActionId[] = ["stop", "restart", "remove", "resume", "kill", "reapPane", "spawn"];
    for (const a of [
      A({ status: "running", resumable: true }),
      A({ status: "running", resumable: true, adhoc: true, canDismiss: true }),
      A({ status: "stopped", resumable: true }),
      A({ status: "stopped", resumable: true, adhoc: true, canDismiss: true }),
      A({ status: "crashed", resumable: true }),
      A({ status: "crashed", resumable: true, adhoc: true, canDismiss: true }),
    ]) {
      expect(primaryActions(a).filter((id) => !["activity", "inspect", "openPane"].includes(id))).toEqual([]);
      const more = moreActions(a);
      for (const id of unsafe) {
        if (actionsFor(a).includes(id)) expect(more).toContain(id);
      }
    }
  });

  it("fork lives in the 'more' menu, never inline — the quick-actions bar is runtime-uniform", () => {
    const forkable = A({ status: "running", kind: "agent", forkable: true });
    expect(primaryActions(forkable)).not.toContain("fork");
    expect(moreActions(forkable)).toContain("fork");
    // the inline bar is identical whether or not the runtime supports fork
    const plain = A({ status: "running", kind: "agent" });
    expect(primaryActions(forkable)).toEqual(primaryActions(plain));
  });
});

/**
 * `t-4662e9` — the surface is gone all the way down, not just hidden from the row.
 *
 * Removing the action alone would leave `tachyon.renameAgentItem` contributed in package.json with no
 * caller. That is the exact shape this task exists to delete: the command was ALREADY unreachable
 * from the palette (`when: false`), so the sidebar was its only entrance, and a contributed command
 * nobody can invoke is the second inconsistent surface wearing a different hat.
 */
describe("t-4662e9 — rename is not reachable from the sidebar surface at any layer", () => {
  const repoRoot = process.cwd();
  const read = (file: string) => fs.readFileSync(path.join(repoRoot, file), "utf8");

  it("declares no rename action and no label for one", () => {
    expect(Object.keys(ACTION_META)).not.toContain("rename");
    // The label mattered as much as the action: it is what the menu rendered.
    expect(JSON.stringify(ACTION_META)).not.toContain("Rename");
  });

  it("contributes no rename command, palette entry, or localized title", () => {
    const manifest = JSON.parse(read("package.json")) as {
      contributes: { commands: { command: string }[]; menus: Record<string, { command: string }[]> };
    };
    expect(manifest.contributes.commands.map((c) => c.command)).not.toContain("tachyon.renameAgentItem");
    for (const [menu, items] of Object.entries(manifest.contributes.menus)) {
      expect(items.map((i) => i.command), `${menu} still lists it`).not.toContain("tachyon.renameAgentItem");
    }
    // A stale %command.renameAgentItem% key would survive silently in both locales.
    for (const nls of ["package.nls.json", "package.nls.pt-br.json"]) {
      expect(Object.keys(JSON.parse(read(nls)) as Record<string, string>), nls).not.toContain("command.renameAgentItem");
    }
  });

  it("registers no handler and leaves the sidebar command map without a rename entry", () => {
    expect(read("src/extension.ts")).not.toContain('registerCommand("tachyon.renameAgentItem"');
    expect(read("src/webview/SidebarPrototype.ts")).not.toContain("tachyon.renameAgentItem");
  });

  it("keeps the runtime-api operation, which is a separate contract with its own service", () => {
    // Deliberately NOT removed: `config.agent.rename` is a declared EXTENSION_COMMAND_ACTIONS entry
    // served by extensionOperationService, reachable by API clients that never had a sidebar.
    // Asserting it stays keeps a later cleanup from mistaking this task for permission to drop it.
    expect(read("packages/engine/src/runtime-api/extensionOperations.ts")).toContain("config.agent.rename");
    expect(read("packages/engine/src/engine-service/extensionOperationService.ts")).toContain("config.agent.rename");
  });
});
