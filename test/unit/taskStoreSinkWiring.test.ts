import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { wakeTaskAssignee } from "@tachyon/engine/tasks/taskNotificationPolicy.js";
import type { Task } from "@tachyon/shared/tasks/types.js";

/**
 * t-c3c0c2 — the assignee wake-up hangs off `TaskStore`'s mutation sink, and that sink is OPTIONAL.
 *
 * `new TaskStore(root)` is silent and nothing complains. Fixing t-57a00a traded "two paths, one
 * missing the logic" for "one path that can be left unplugged" — the same family as t-b4a799, in a
 * new shape. In production it works only because a single place constructs the store and happens to
 * wire it; that is topology, not construction.
 *
 * Making the option REQUIRED was measured and rejected: `src` has one construction and `test` has 57,
 * so the compiler error would land almost entirely on fixtures that legitimately want no effects.
 * Instead:
 *   - the effect (decision + liveness gate + delivery) is composed ONCE in the policy, so a caller
 *     supplies ports and cannot get the gate wrong — that is the half that already bit us;
 *   - and this guard asserts every `src` construction wires the sink, so a second unplugged one is a
 *     failing test rather than silence.
 *
 * A source scan is the right tool here specifically because the question is "is EVERY construction
 * covered?" — the question a behavioural test cannot ask, and the one t-e73e54's source test failed to
 * ask when it pinned a single function and claimed "in one place".
 */
describe("t-c3c0c2 — every TaskStore in src wires the mutation sink", () => {
  function sourceFiles(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.isFile() && full.endsWith(".ts") ? [full] : [];
    });
  }

  it("no production construction leaves onMutation unplugged", () => {
    const roots = [path.join(process.cwd(), "src"), path.join(process.cwd(), "packages", "engine", "src")];
    const unplugged: string[] = [];
    let constructions = 0;

    for (const file of roots.flatMap(sourceFiles)) {
      const text = fs.readFileSync(file, "utf8");
      for (const match of text.matchAll(/new TaskStore\(/g)) {
        constructions += 1;
        // The options object may span lines; look ahead far enough to clear a realistic wiring block.
        const tail = text.slice(match.index, match.index + 1200);
        if (!/onMutation\s*:/.test(tail)) unplugged.push(`${path.relative(process.cwd(), file)}`);
      }
    }

    // Guard the guard: if the constructor is renamed or the store moves, this must fail loudly rather
    // than pass by matching nothing.
    expect(constructions).toBeGreaterThan(0);
    expect(unplugged).toEqual([]);
  });
});

/**
 * t-c3c0c2 — the liveness gate belongs WITH the decision, not at each call site.
 *
 * It used to live at the Workspace call site. A test harness that wired the sink then re-typed it, the
 * copy omitted the has-session check, and the fake tmux minted a session row for a name that never had
 * one — eighteen unrelated scenarios then read that ghost as a live agent. These assert the composed
 * effect refuses on its own, so no caller has to remember.
 */
describe("t-c3c0c2 — the composed wake refuses a dead or non-agent assignee", () => {
  const base: Task = {
    id: "t-abc123",
    title: "A task",
    status: "triaged",
    author: "human",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const event = { before: base, after: { ...base, assignee: "ada" } };

  it("delivers when the assignee is a live agent", async () => {
    const delivered: string[] = [];

    const wake = await wakeTaskAssignee(event, {
      isLiveAgent: async () => true,
      deliver: async (agent) => { delivered.push(agent); },
    });

    expect(wake?.assignee).toBe("ada");
    expect(delivered).toEqual(["ada"]);
  });

  it("does not deliver when the assignee is not a live agent", async () => {
    const delivered: string[] = [];

    const wake = await wakeTaskAssignee(event, {
      isLiveAgent: async () => false,
      deliver: async (agent) => { delivered.push(agent); },
    });

    expect(wake).toBeUndefined();
    expect(delivered).toEqual([]);
  });

  it("swallows a delivery failure — a task mutation must not fail because a notice did", async () => {
    // The catch is inside the composed effect for the same reason the gate is: left to callers, one
    // caller eventually omits it and a failed notice starts rejecting update_task.
    await expect(wakeTaskAssignee(event, {
      isLiveAgent: async () => true,
      deliver: async () => { throw new Error("tmux is gone"); },
    })).resolves.toBeUndefined();
  });

  it("does not consult liveness when there is nothing to send", async () => {
    // Ordering matters: an edit that wakes nobody must not probe tmux for every task mutation.
    let probed = 0;

    await wakeTaskAssignee({ before: base, after: { ...base, title: "renamed" } }, {
      isLiveAgent: async () => { probed += 1; return true; },
      deliver: async () => {},
    });

    expect(probed).toBe(0);
  });
});
