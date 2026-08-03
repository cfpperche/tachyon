import { describe, it, expect } from "vitest";
import { ROUTES } from "../../scripts/webview-preview/routes.js";
import { VALIDATIONS } from "../../src/webview/validations/messages.js";
import type { ValidationsViewModel } from "../../src/webview/validations/viewModel.js";

// t-e61439 — the 12th Control tab (Validations) had no preview fixture, so agent visual QA could never see
// it render. This locks in: the cockpit route carries a `validations` fixture, its model resolves to the
// "validations" section, and makeMessage injects a validations envelope (built via the shared constructor,
// never a hand-rolled string literal) carrying a non-empty, representative queue.

describe("cockpit validations fixture (t-e61439)", () => {
  it("the cockpit route declares a `validations` fixture", () => {
    const r = ROUTES.cockpit;
    expect(Object.keys(r.fixtures)).toContain("validations");
  });

  it("the validations fixture's model resolves to section \"validations\"", () => {
    const fx = ROUTES.cockpit.fixtures.validations;
    expect(fx).toBeTruthy();
    const model = fx!.vm as { section?: string };
    expect(model.section).toBe("validations");
  });

  it("makeMessage for the validations fixture injects init + model + a VALIDATIONS envelope", () => {
    const fx = ROUTES.cockpit.fixtures.validations!;
    const msgs = ROUTES.cockpit.makeMessage(fx.vm) as Array<{ type: string; vm?: unknown }>;
    expect(msgs.map((m) => m.type)).toEqual(["init", "model", VALIDATIONS]);

    const validationsMsg = msgs.find((m) => m.type === VALIDATIONS);
    expect(validationsMsg).toBeTruthy();
    const vm = validationsMsg!.vm as ValidationsViewModel;
    expect(vm.validations.length).toBeGreaterThan(0);
  });

  it("the injected VM is a REPRESENTATIVE queue — not an empty state", () => {
    const fx = ROUTES.cockpit.fixtures.validations!;
    const msgs = ROUTES.cockpit.makeMessage(fx.vm) as Array<{ type: string; vm?: unknown }>;
    const vm = msgs.find((m) => m.type === VALIDATIONS)!.vm as ValidationsViewModel;

    const statuses = new Set(vm.validations.map((v) => v.status));
    expect(statuses.has("pending"), "queue must include at least one open/pending item").toBe(true);
    expect(statuses.has("closed"), "queue must include at least one closed item").toBe(true);

    const executors = new Set(vm.validations.map((v) => v.executor));
    expect(executors.has("human"), "queue must include a human executor").toBe(true);
    expect(executors.has("agent") || executors.has("either"), "queue must include a non-human executor").toBe(true);

    const priorities = new Set(vm.validations.map((v) => v.priority));
    expect(priorities.size, "queue must carry mixed priorities").toBeGreaterThan(1);
  });

  it("other cockpit fixtures are unaffected — no extra section-specific message leaks in", () => {
    const r = ROUTES.cockpit;
    // SDD 485 C5 — was the `mission` fixture, which went with the Board's Control renderer. Fleet is the
    // same check on the same premise: a section that pushes no validations must not receive one.
    const fleetMsgs = r.makeMessage(r.fixtures.fleet!.vm) as Array<{ type: string }>;
    expect(fleetMsgs.some((m) => m.type === VALIDATIONS)).toBe(false);
  });
});
