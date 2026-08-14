import { describe, expect, it } from "vitest";
import { registerTools } from "@tachyon/engine/bridge/tools.js";
import { resolveActor } from "@tachyon/engine/bridge/callerIdentity.js";
import type { CallerKind, CallerSnapshot } from "@tachyon/engine/bridge/callerIdentity.js";
import {
  PARENT_CWD_REFUSAL,
  PARENT_CWD_RULE,
  parentCwdExitsFor,
  parentCwdRefusalFor,
} from "@tachyon/engine/bridge/spawnContract.js";

/**
 * t-6fe04b — the refusal moves earlier, and starts naming the way out.
 *
 * `parent` and `cwd` were independent optionals, so an incompatible pair type-checked, travelled all
 * the way to the AgentManager, and was refused only at execution — after the caller had composed a
 * whole delegation contract. Worse, the message said only what NOT to do: in the incident behind
 * t-e787dc the caller answered it by writing an absolute path into the child's BRIEFING, which is
 * the least governed outcome available and a direct consequence of a refusal pointing nowhere.
 *
 * t-5f823a — and then the way out it named was one the reader could not take. Measured: an agent
 * caller passing `cwd` with no `parent` got past the Bridge guard (which read the LITERAL parent),
 * had its parent filled in with its own name by spec 351 resolution, and was refused by the manager
 * one step later — quoting the exit it had just used. The rule was never the problem. A message that
 * is false for the caller who reads it most is, and this file now measures from that caller's seat.
 */

class ToolCapture {
  handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>>();
  /** t-d06da3 — the parameter DESCRIPTIONS are agent-facing text too, and one of them carried the lie. */
  schemas = new Map<string, { inputSchema?: Record<string, { description?: string }> }>();
  registerTool(
    name: string,
    schema: unknown,
    handler: (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
  ) {
    this.handlers.set(name, handler);
    this.schemas.set(name, schema as { inputSchema?: Record<string, { description?: string }> });
  }
}

const CALLER_SCOPE = { workspaceId: "w", instanceId: "i" };

function callerFor(kind: CallerKind): CallerSnapshot {
  return kind === "agent" ? { kind, name: "ada" } : { kind };
}

/**
 * A Bridge whose manager only RECORDS the spawn. The point of several tests below is not what the
 * manager would have done but whether it was reached at all: a refusal that arrives here instead of
 * at the entry is the defect, not the fix.
 */
function bridge(kind: CallerKind) {
  const mcp = new ToolCapture();
  const spawned: Record<string, unknown>[] = [];
  registerTools(mcp as never, {
    workspaceRoot: "/repo",
    caller: callerFor(kind),
    notify: () => {},
    manager: {
      spawn: async (_name: string, opts: Record<string, unknown>) => { spawned.push(opts); },
      session: () => "tachyon-helper",
      kindOf: () => "agent",
      isReady: async () => true,
    },
  } as never);
  return { spawn: mcp.handlers.get("spawn_agent")!, spawned };
}

function spawnTool(): (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const mcp = new ToolCapture();
  registerTools(mcp as never, {
    workspaceRoot: "/repo",
    caller: { kind: "agent", name: "ada" },
    // Deliberately no agent manager wiring: the point is that the refusal lands BEFORE anything
    // downstream is needed. A test that had to build a workspace to see it would be proving the
    // opposite of what this task fixed.
  } as never);
  return mcp.handlers.get("spawn_agent")!;
}

/** Every tool name the Bridge actually registers, from the same registration this file already drives. */
function liveToolNames(): Set<string> {
  const mcp = new ToolCapture();
  registerTools(mcp as never, { workspaceRoot: "/repo", caller: { kind: "agent", name: "ada" } } as never);
  return new Set(mcp.handlers.keys());
}

/** A delegation contract good enough to pass the spec 246 gate, so nothing else can be the refusal. */
const CONTRACT = {
  task: "carry out the delegated change",
  context: "the worktree and the failing test are described here",
  constraints: "do not push, do not merge",
  done_when: "the focused test passes",
};

const CALLER_KINDS: CallerKind[] = ["agent", "human", "master", "external", "legacy"];

describe("t-6fe04b — spawn_agent refuses parent+cwd at the entry", () => {
  it("refuses the pair before composing anything", async () => {
    const result = await spawnTool()({ name: "helper", cmd: "codex", parent: "ada", cwd: "/somewhere" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("cannot combine parent with cwd");
  });

  describe("the message names the governed alternative", () => {
    it("names a way out, not just a prohibition", async () => {
      // A legacy caller: the one remaining Bridge caller that can both carry a parent and be
      // unparented, and therefore the one the caller-neutral rendering is actually addressed to.
      const { spawn } = bridge("legacy");
      const result = await spawn({ name: "helper", cmd: "codex", parent: "ada", cwd: "/somewhere", ...CONTRACT });

      // The whole reason the refusal moved: a caller who is only told "don't" invents a way around.
      expect(result.content[0]?.text).toContain("spawn without parent");
      expect(result.content[0]?.text).toContain("declare it in tachyon.yml");
    });

    /**
     * t-e88c8a — this assertion used to read `toContain("delivery_join")`, and that is exactly how a
     * dead pointer survived three stages of removing the Delivery machinery: deleting the tool left
     * the assertion passing, because the assertion pinned the refusal against ITSELF.
     *
     * So the guard now pins it against the LIVE registration. Any tool-shaped name the refusal
     * mentions must be a tool the Bridge actually registers. `spawn_agent` passes because it exists;
     * `delivery_join` would fail today, which is the whole point.
     *
     * t-5f823a — every rendering, not just the caller-neutral one: the per-caller variants are more
     * text on the same surface, and a dead pointer would be no less dead for being addressed to one
     * kind of caller.
     */
    it("never names a tool the Bridge does not register", () => {
      const registered = liveToolNames();
      for (const text of [PARENT_CWD_REFUSAL, ...CALLER_KINDS.map((kind) => parentCwdRefusalFor(kind))]) {
        const mentioned = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];

        expect(mentioned.length).toBeGreaterThan(0); // a refusal that names nothing cannot point anywhere
        expect(mentioned.filter((name) => !registered.has(name))).toEqual([]);
      }
    });

    it("is the SAME sentence the manager-level guard throws", () => {
      // Two refusals for one rule must not disagree about the way out. The guard stays — it is the
      // complete one — and this is its earlier, friendlier half.
      expect(PARENT_CWD_REFUSAL).toContain("cannot combine parent with cwd");
      // t-5f823a — the exits differ per caller; the RULE may not. Whatever a caller hears, it is
      // hearing the same prohibition, so no caller can conclude the rule does not apply to it.
      for (const kind of CALLER_KINDS) expect(parentCwdRefusalFor(kind)).toContain(PARENT_CWD_RULE);
    });
  });

  /**
   * t-5f823a — a consequence of refusing on the RESOLVED parent, recorded because it changes an
   * error a caller can see. A human/master caller cannot claim agent identity at all, so passing
   * `parent` is refused by identity resolution before the pairing is ever considered. Previously the
   * pair jumped that queue and answered with the cwd rule, which told the caller the pairing was the
   * problem when the parent alone would have been refused just as hard. The deeper refusal wins.
   */
  it("answers a human caller's explicit parent with the identity refusal, not the cwd rule", async () => {
    const { spawn } = bridge("human");

    const result = await spawn({ name: "helper", cmd: "codex", parent: "ada", cwd: "/somewhere", ...CONTRACT });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("master_claim_denied");
  });

  it("leaves a spawn that states only one of them alone", async () => {
    // Neither field is being deprecated; only the incompatible pair is refused. For a caller that
    // CAN be unparented, cwd alone still reaches the manager and is applied there.
    const { spawn, spawned } = bridge("human");
    const cwdOnly = await spawn({ name: "helper", cmd: "codex", cwd: "/somewhere", ...CONTRACT });

    expect(cwdOnly.content[0]?.text ?? "").not.toContain("cannot combine parent with cwd");
    expect(spawned[0]?.cwd).toBe("/somewhere");
    expect(spawned[0]?.parent).toBeUndefined();
  });
});

/**
 * t-5f823a — the refusal, read from the seat of the caller who receives it most.
 *
 * Every test above drives the Bridge, but only ever asserted things a human caller could verify.
 * The last one used to assert that a cwd-only spawn is NOT refused here — and it passed for an
 * agent caller too, because the refusal simply arrived later, from the AgentManager. Measuring one
 * step short of the failure is how a message that cannot be obeyed looked correct for two fixes in
 * a row.
 */
describe("t-5f823a — the refusal an AGENT caller receives", () => {
  it("refuses a cwd-only spawn at the Bridge, instead of letting the manager do it a step later", async () => {
    const { spawn, spawned } = bridge("agent");

    const result = await spawn({ name: "helper", cmd: "codex", cwd: "/elsewhere", ...CONTRACT });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("cannot combine parent with cwd");
    // The measured defect: this spawn used to reach the manager carrying parent="ada" — the caller's
    // own name, filled in by spec 351 resolution — and be refused there for a pairing the caller
    // never wrote. If this array is non-empty again, the guard is back to reading the literal parent.
    expect(spawned).toEqual([]);
  });

  it("does not tell an agent to do the one thing its identity model forbids", async () => {
    const { spawn } = bridge("agent");

    const result = await spawn({ name: "helper", cmd: "codex", cwd: "/elsewhere", ...CONTRACT });

    expect(result.content[0]?.text).not.toContain("spawn without parent");
    expect(result.content[0]?.text).toContain("spec 351");
  });

  /**
   * The pin that makes the rest of this file non-circular, and the direct generalization of the
   * lesson from 7351a74d: a message may name an exit only if the mechanism that decides
   * reachability actually grants it. There, the mechanism was `registerTools`. Here it is
   * `resolveActor` — the single function that decides whether an omitted `parent` becomes nothing
   * (the exit exists) or becomes the caller (the exit is a lie).
   *
   * Change the resolver so agents may spawn unparented, and this test tells you the message is now
   * understating what an agent can do. Change the message without the resolver, and it tells you the
   * message is overstating it. Neither direction can pass by editing prose alone.
   */
  it("offers the unparented exit to exactly the callers the identity resolver lets be unparented", () => {
    for (const kind of CALLER_KINDS) {
      const resolved = resolveActor({ caller: callerFor(kind), declared: undefined, registry: undefined, scope: CALLER_SCOPE });
      const canBeUnparented = resolved.ok && resolved.name === undefined;

      expect(parentCwdExitsFor(kind).includes("unparented-spawn"), `caller kind '${kind}'`).toBe(canBeUnparented);
    }
    // Guards the guard: if every kind answered the same way the loop would prove nothing, which is
    // precisely the vacuous shape that let `delivery_join` survive three removals.
    expect(new Set(CALLER_KINDS.map((kind) => parentCwdExitsFor(kind).includes("unparented-spawn"))).size).toBe(2);
  });

  /** The enumerated exits and the rendered prose must not drift: an exit nobody prints is not offered. */
  it("prints every exit it enumerates, and enumerates every exit it prints", () => {
    for (const kind of CALLER_KINDS) {
      const text = parentCwdRefusalFor(kind);
      const offersUnparented = parentCwdExitsFor(kind).includes("unparented-spawn");

      expect(text.includes("spawn without parent"), `caller kind '${kind}'`).toBe(offersUnparented);
      expect(text).toContain("declare it in tachyon.yml");
    }
  });

  /**
   * The other half of "only the pair is refused": an agent activating a DECLARED agent supplies no
   * lineage (ownership comes from the roster, not from the requester), so its cwd is honored. This
   * is the door the agent-facing message points at, and it is checked here so the message cannot
   * quietly become as unreachable as the one it replaced.
   */
  it("still honors cwd for an agent activating a declared Saved Agent", async () => {
    const { spawn, spawned } = bridge("agent");

    const result = await spawn({ name: "reviewer", cwd: "/repo/worktrees/reviewer" });

    expect(result.isError).toBeFalsy();
    expect(spawned[0]?.cwd).toBe("/repo/worktrees/reviewer");
    expect(spawned[0]?.parent).toBeUndefined();
  });
});

/**
 * t-d06da3 — the exit the refusal could not offer, because the door it names was welded shut.
 *
 * `worktree:true` was refused outright for a Temporary AI agent, with a message naming "declare the
 * agent in tachyon.yml" (an edit per delegation) and "spawn top-level" (impossible for an agent, for
 * exactly the reason t-5f823a measured one refusal over). So a coordinator that wanted an isolated
 * child had no door at all, and the containment it could still reach — running the child inside its
 * OWN worktree — is strictly less contained than the thing being refused.
 *
 * These pin the lift the same way t-5f823a pinned the earlier one: against the mechanism that decides
 * reachability, never against the prose. For the unparented exit that mechanism is `resolveActor`; for
 * this one it is the `spawn_agent` handler itself, so the test asks the handler.
 */
describe("t-d06da3 — a delegated child may ask for its own worktree", () => {
  it("lets an agent's parented child ask for isolation, and passes it through", async () => {
    const { spawn, spawned } = bridge("agent");

    const result = await spawn({ name: "helper", cmd: "codex", worktree: true, ...CONTRACT });

    expect(result.isError).toBeFalsy();
    // Both halves matter: refusing this was the defect, and dropping `worktree` on the way to the
    // manager would be the "ignored, not refused" promise t-6fe04b already caught this door making.
    expect(spawned[0]).toMatchObject({ parent: "ada", worktree: true });
  });

  it("offers worktree:true to exactly the callers this door lets ask for it", async () => {
    for (const kind of CALLER_KINDS) {
      const { spawn, spawned } = bridge(kind);

      const result = await spawn({ name: "helper", cmd: "codex", worktree: true, ...CONTRACT });
      const granted = !result.isError && spawned[0]?.worktree === true;

      expect(parentCwdExitsFor(kind).includes("isolate-in-own-worktree"), `caller kind '${kind}'`).toBe(granted);
    }
  });

  /**
   * The cwd refusal is the surviving one, and until now every exit it named was heavy: inherit (give
   * up on isolation) or edit workspace config first. It now names the direct one, and this asserts the
   * NAME is there for every caller that reaches the refusal — all of whom are, by construction, making
   * a Temporary AI spawn, since only such a spawn can carry a resolved `parent`.
   */
  it("names the isolated exit in the refusal that survives", async () => {
    const { spawn } = bridge("agent");

    const result = await spawn({ name: "helper", cmd: "codex", cwd: "/elsewhere", ...CONTRACT });

    expect(result.content[0]?.text).toContain("worktree:true");
    for (const kind of CALLER_KINDS) expect(parentCwdRefusalFor(kind)).toContain("worktree:true");
  });

  /**
   * The lie did not only live in the refusal. `spawn_agent`'s own `worktree` parameter told every
   * reader the flag was "REFUSED, not ignored" for a Temporary AI agent and pointed at the same
   * unreachable "spawn top-level" — and a parameter description is read BEFORE the call, by the
   * caller deciding whether to make it at all. Pinned against `resolveActor` like its sibling: an
   * agent can never be unparented, so no agent-facing text on this door may send it that way.
   */
  it("never tells an agent to go top-level — not in the refusal, and not in the parameter that did", () => {
    const mcp = new ToolCapture();
    registerTools(mcp as never, { workspaceRoot: "/repo", caller: { kind: "agent", name: "ada" } } as never);
    const worktreeParam = mcp.schemas.get("spawn_agent")?.inputSchema?.worktree?.description ?? "";
    const resolved = resolveActor({ caller: callerFor("agent"), declared: undefined, registry: undefined, scope: CALLER_SCOPE });

    expect(resolved.ok && resolved.name).toBe("ada"); // the mechanism: an agent's spawn is always parented
    expect(worktreeParam.length).toBeGreaterThan(0); // a parameter that describes nothing cannot be checked
    for (const text of [worktreeParam, parentCwdRefusalFor("agent")]) {
      expect(text).not.toContain("top-level");
      expect(text).not.toContain("spawn without parent");
    }
  });
});
