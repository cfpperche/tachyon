/**
 * t-2d2ce7 — Stop All must reach a session created DURING its own sweep.
 *
 * The bug was measured in the VS Code gate and was timing-dependent there: the same tree passed one
 * run and failed the next, the only difference being that the preceding scenario took 8067ms instead
 * of 6949ms, so a runbook postmortem pane was born a little later and the sweep had already looked
 * past it. A test that reproduces it by racing a real tmux would inherit exactly that flakiness.
 *
 * So these drive the seam DETERMINISTICALLY: a fake tmux that creates its extra session on a chosen
 * enumeration, reproducing "born during the sweep" every single run, with no VS Code, no xvfb and no
 * timing at all.
 *
 * The second group covers the hazard the original report did not name: `sessionStates` returns `null`
 * for an error it could not classify, and every previous caller coerced that into "nothing to kill".
 * For a command whose whole purpose is stopping everything, "I could not tell" must never become
 * "there was nothing".
 */
import { describe, it, expect } from "vitest";
import { sweepSessions, DEFAULT_MAX_PASSES, type SessionSweepPort } from "@tachyon/engine/tmux/sessionSweep.js";

type States = Map<string, { dead: boolean; exitCode?: number }>;

/**
 * A tmux whose session list can change between enumerations — which is the whole scenario.
 * `bornOnRead` is the 1-based enumeration during which the late session appears.
 */
function fakeTmux(opts: {
  initial: string[];
  bornOnRead?: { at: number; session: string };
  nullReads?: number[];
}): SessionSweepPort & { killed: string[]; reads: number } {
  const live = new Set(opts.initial);
  const api = {
    killed: [] as string[],
    reads: 0,
    async sessionStates(prefix: string): Promise<States | null> {
      api.reads += 1;
      if (opts.nullReads?.includes(api.reads)) return null;
      // The late arrival lands AFTER this read has been served, so the pass that is already running
      // cannot see it — exactly how the runbook pane escaped.
      const snapshot: States = new Map();
      for (const s of live) if (s.startsWith(prefix)) snapshot.set(s, { dead: false });
      if (opts.bornOnRead && opts.bornOnRead.at === api.reads) live.add(opts.bornOnRead.session);
      return snapshot;
    },
    async killSession(name: string): Promise<void> {
      api.killed.push(name);
      live.delete(name);
    },
  };
  return api;
}

const PREFIX = "tachyon-a2e81f24-";

describe("t-2d2ce7 — a session born during the sweep is still killed", () => {
  it("catches the late arrival instead of leaving it alive", async () => {
    // The measured shape: the runbook pane appears while the first enumeration is in flight.
    const tmux = fakeTmux({
      initial: [`${PREFIX}echoer`, `${PREFIX}flaky`],
      bornOnRead: { at: 1, session: `${PREFIX}doomed-1` },
    });
    const result = await sweepSessions(tmux, PREFIX);

    expect(result.killed).toContain(`${PREFIX}doomed-1`);
    expect(result.converged, "sweep reported done while something was still alive").toBe(true);
  });

  it("stops as soon as one pass is clean, rather than burning the whole budget", async () => {
    const tmux = fakeTmux({ initial: [`${PREFIX}a`], bornOnRead: { at: 1, session: `${PREFIX}late` } });
    const result = await sweepSessions(tmux, PREFIX);
    expect(result.killed.sort()).toEqual([`${PREFIX}a`, `${PREFIX}late`]);
    expect(result.converged).toBe(true);
    expect(result.passes).toBeLessThan(DEFAULT_MAX_PASSES);
  });

  it("does NOT claim a session born after its last confirming read — the honest limit", async () => {
    // Worth stating rather than leaving implicit, because I first wrote this test asserting the
    // opposite and it failed. `bornOnRead: 2` puts the session into existence AFTER the read that
    // found nothing left, i.e. after this Stop All has finished. No bounded operation can promise
    // to kill something created after it stopped looking — that is a new session, not a survivor.
    // The guarantee this fix actually provides is the one above: born while work is still in flight.
    const tmux = fakeTmux({ initial: [`${PREFIX}a`], bornOnRead: { at: 2, session: `${PREFIX}after` } });
    const result = await sweepSessions(tmux, PREFIX);
    expect(result.killed).toEqual([`${PREFIX}a`]);
    expect(result.converged).toBe(true);
  });

  it("never kills the same session twice, however many passes it takes", async () => {
    const tmux = fakeTmux({ initial: [`${PREFIX}a`, `${PREFIX}b`], bornOnRead: { at: 1, session: `${PREFIX}c` } });
    const result = await sweepSessions(tmux, PREFIX);
    expect(new Set(result.killed).size).toBe(result.killed.length);
  });

  it("only touches its own prefix, so one workspace's Stop All cannot reach another's", async () => {
    // This is the t-05097f isolation, and it must survive the fix: the sweep is prefix-scoped and
    // nothing here widens it.
    const tmux = fakeTmux({ initial: [`${PREFIX}mine`, "tachyon-OTHERWS-theirs", "tachyon-ctl-a2e81f24"] });
    const result = await sweepSessions(tmux, PREFIX);
    expect(result.killed).toEqual([`${PREFIX}mine`]);
  });

  it("gives up in a BOUNDED way when something is genuinely respawning, and says it did not finish", async () => {
    // A session that comes back every time must not spin here forever — but the caller has to learn
    // that Stop All did not actually stop everything, rather than infer success from a return.
    const live = new Set([`${PREFIX}immortal`]);
    const tmux: SessionSweepPort = {
      async sessionStates(prefix) {
        const m: States = new Map();
        for (const s of live) if (s.startsWith(prefix)) m.set(s, { dead: false });
        return m;
      },
      async killSession(name) { live.delete(name); live.add(name); /* instantly back */ },
    };
    const result = await sweepSessions(tmux, PREFIX, { maxPasses: 3 });
    expect(result.converged).toBe(false);
    expect(result.passes).toBe(3);
  });

  it("runs onKill for every session it kills, including the late one", async () => {
    // AgentManager's per-agent bookkeeping rides on this; a late session that skipped it would leave
    // lineage and transcript state behind.
    const tmux = fakeTmux({ initial: [`${PREFIX}a`], bornOnRead: { at: 1, session: `${PREFIX}late` } });
    const seen: string[] = [];
    await sweepSessions(tmux, PREFIX, { onKill: (s) => { seen.push(s); } });
    expect(seen.sort()).toEqual([`${PREFIX}a`, `${PREFIX}late`]);
  });
});

describe("t-2d2ce7 — an unreadable tmux is not an empty one", () => {
  it("retries an ambiguous read instead of concluding there was nothing to kill", async () => {
    // `sessionStates` returns null for an error it could not classify — distinct from the empty map
    // it returns for a confirmed-absent server. The old callers erased that distinction with
    // `?? new Map()`, which silently turned a tmux hiccup into a no-op Stop All.
    const tmux = fakeTmux({ initial: [`${PREFIX}survivor`], nullReads: [1] });
    const result = await sweepSessions(tmux, PREFIX);
    expect(result.killed).toEqual([`${PREFIX}survivor`]);
    expect(result.converged).toBe(true);
  });

  it("does NOT report convergence when every read was ambiguous", async () => {
    // Nothing was killed and nothing is known. Reporting success here would be the worst answer
    // available: the operator believes the machine is stopped when it may not be.
    const tmux = fakeTmux({ initial: [`${PREFIX}unknown`], nullReads: [1, 2, 3, 4, 5] });
    const result = await sweepSessions(tmux, PREFIX);
    expect(result.killed).toEqual([]);
    expect(result.converged).toBe(false);
  });

  it("treats a confirmed-empty read as done, which is the only evidence that counts", async () => {
    const tmux = fakeTmux({ initial: [] });
    const result = await sweepSessions(tmux, PREFIX);
    expect(result).toMatchObject({ killed: [], converged: true, passes: 1 });
  });
});
