import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LEASE_DISPOSITION } from "../../src/delivery/types.js";

/**
 * t-cc6495 — every non-terminal lease state has a governed disposition.
 *
 * A lease that reaches a state with no way forward is a stuck delivery: the agent cannot finish,
 * the coordinator cannot free it, and recovery leaves the governed flow for raw git or raw sqlite —
 * the failure t-0cbcbd describes. We have shipped that shape before (t-a9d850, t-8bb9cd).
 *
 * The refusal used to inline `["held", "quarantined"]` while the guard producing it refused EVERY
 * state that is not `free`/`held`, so `pending`, `draining` and `verifying` produced dead ends.
 *
 * The states are read from the TYPE DECLARATION in types.ts, never copied here. A test carrying its
 * own copy of the state list is a mirror: it breaks on every rename and catches no real defect. Read
 * from the source, adding a state without deciding its disposition is what fails — and that is the
 * defect worth catching.
 */

const TYPES = path.resolve(__dirname, "../../src/delivery/types.ts");

/** The `DeliveryLeaseState` union, parsed out of its declaration. */
function declaredStates(): string[] {
  const src = fs.readFileSync(TYPES, "utf8");
  const line = src.split("\n").find((l) => l.includes("export type DeliveryLeaseState"));
  if (!line) throw new Error("DeliveryLeaseState declaration not found — this test reads it, it does not own it");
  return [...line.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
}

describe("lease disposition (t-cc6495)", () => {
  it("declares a disposition for every state the type allows", () => {
    const states = declaredStates();
    expect(states.length).toBeGreaterThan(0);
    // Adding a state to the union without deciding what a caller blocked by it should do fails here.
    expect(Object.keys(LEASE_DISPOSITION).sort()).toEqual([...states].sort());
  });

  it("gives every NON-terminal state either an action or a declared reason to retry", () => {
    for (const [state, d] of Object.entries(LEASE_DISPOSITION)) {
      if (d.kind === "terminal") continue;
      // "nothing to do" must be a decision someone wrote down, not an omission.
      // t-e88c8a stage 1 — "an action" is no longer one of the answers: the operator-invokable
      // Delivery tools are gone. What survives is the property that mattered — a non-terminal state
      // must EXPLAIN itself, whether it clears on its own or has no way forward at all.
      expect(d.why.length, `${state} declares ${d.kind} but explains nothing`).toBeGreaterThan(0);
    }
  });

  it("declares no governed action for held, quarantined or verifying", () => {
    // Not interchangeable: salvage on a live verification would discard a run that may still be
    // legitimately in flight, so a stuck verification is reconciled instead.
    // t-e88c8a stage 1 — salvage and reconcile no longer exist, so the three states that routed to
    // them now declare that no governed action remains. The distinction the old assertion protected
    // (salvage is NOT interchangeable with reconcile) is moot once neither is reachable.
    expect(LEASE_DISPOSITION.held.kind).toBe("unavailable");
    expect(LEASE_DISPOSITION.quarantined.kind).toBe("unavailable");
    expect(LEASE_DISPOSITION.verifying.kind).toBe("unavailable");
  });

  it("treats only free and abandoned as terminal", () => {
    // A terminal lease holds nothing, so there is nothing to dispose of. Marking a state terminal to
    // silence this test would be the way to reintroduce the dead end, so the set is pinned.
    const terminal = Object.entries(LEASE_DISPOSITION)
      .filter(([, d]) => d.kind === "terminal")
      .map(([s]) => s)
      .sort();
    expect(terminal).toEqual(["abandoned", "free"]);
  });

  it("names no Bridge tool at all, since the Delivery surface is retired", () => {
    // The original assertion checked that every named action existed in the Bridge. t-e88c8a stage 1
    // removed the tools, so the guard inverts: no disposition may name one. Keeping it pointed at
    // tools.ts is deliberate — if a later change reintroduces a named action, this fails.
    const tools = fs.readFileSync(path.resolve(__dirname, "../../src/bridge/tools.ts"), "utf8");
    for (const [state, d] of Object.entries(LEASE_DISPOSITION)) {
      expect(d.kind, `${state} names a Bridge action; the Delivery surface is retired`).not.toBe("action");
    }
    for (const retired of ["delivery_salvage", "git_delivery_reconcile"]) {
      expect(tools.includes(`"${retired}"`), `${retired} is back in the Bridge`).toBe(false);
    }
  });
});
