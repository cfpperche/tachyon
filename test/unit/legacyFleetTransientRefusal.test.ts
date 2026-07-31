import { describe, expect, it } from "vitest";
import { isTransientLegacyRefusal } from "../../src/agents/legacyFleetGate.js";

/**
 * t-1129e1 — which legacy-fleet refusals can clear themselves.
 *
 * Every extension-host reload leaves the previous build's agent processes alive for a moment. The gate
 * ran once inside that window, refused truthfully, and nothing re-evaluated — so the operator got a red
 * "cannot activate this workspace" card on EVERY reload, naming a fact that had already stopped being
 * true and asking them to stop a fleet that had already stopped itself.
 *
 * The distinction this function draws is the whole fix: a live tmux session can exit on its own, and a
 * persisted row cannot. Waiting on the second kind would only delay a refusal the operator has to act
 * on, so it must not be treated as transient.
 */
const live = { kind: "live-agent-session" as const, name: "claude", detail: "no attestation" };
const ledger = { kind: "ledger-row" as const, name: "grok", detail: "pre-cut row" };
const roster = { kind: "roster-entry" as const, name: "pi", detail: "no profile pointer" };

describe("t-1129e1 — only a live session is worth waiting for", () => {
  it("treats live-session offenders as transient", () => {
    expect(isTransientLegacyRefusal({ ok: false, offenders: [live] })).toBe(true);
    expect(isTransientLegacyRefusal({ ok: false, offenders: [live, { ...live, name: "codex" }] })).toBe(true);
  });

  it("refuses to wait on persisted state, which will be just as present later", () => {
    expect(isTransientLegacyRefusal({ ok: false, offenders: [ledger] })).toBe(false);
    expect(isTransientLegacyRefusal({ ok: false, offenders: [roster] })).toBe(false);
  });

  it("refuses to wait when a persisted offender is MIXED with a transient one", () => {
    // The load-bearing case. `.some()` here instead of `.every()` would make a workspace with a real
    // pre-cut ledger row sit through the whole recheck window before reporting a refusal that was
    // never going to clear — turning a fast, honest refusal into a slow one.
    expect(isTransientLegacyRefusal({ ok: false, offenders: [live, ledger] })).toBe(false);
  });

  it("is never true for a passing gate", () => {
    expect(isTransientLegacyRefusal({ ok: true, offenders: [] })).toBe(false);
    // A refusal with no named offender is not something to wait out either: there is nothing to
    // observe clearing, so waiting would be a pure delay.
    expect(isTransientLegacyRefusal({ ok: false, offenders: [] })).toBe(false);
  });
});
