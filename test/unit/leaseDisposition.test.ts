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
      if (d.kind === "transitional") {
        expect(d.why.length, `${state} declares transitional but explains nothing`).toBeGreaterThan(0);
      } else {
        expect(d.action, `${state} must name an operator-invokable action`).toBeTruthy();
      }
    }
  });

  it("routes a held or quarantined lease to salvage, and a verifying one to reconcile", () => {
    // Not interchangeable: salvage on a live verification would discard a run that may still be
    // legitimately in flight, so a stuck verification is reconciled instead.
    expect(LEASE_DISPOSITION.held).toEqual({ kind: "action", action: "delivery_salvage" });
    expect(LEASE_DISPOSITION.quarantined).toEqual({ kind: "action", action: "delivery_salvage" });
    expect(LEASE_DISPOSITION.verifying).toEqual({ kind: "action", action: "git_delivery_reconcile" });
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

  it("names only actions the Bridge actually exposes", () => {
    // A disposition pointing at a tool that does not exist is worse than none: it sends the operator
    // somewhere unreachable, which is the dead end wearing a helpful face.
    const tools = fs.readFileSync(path.resolve(__dirname, "../../src/bridge/tools.ts"), "utf8");
    for (const [state, d] of Object.entries(LEASE_DISPOSITION)) {
      if (d.kind !== "action") continue;
      expect(tools.includes(`"${d.action}"`), `${state} points at '${d.action}', absent from the Bridge`).toBe(true);
    }
  });
});
