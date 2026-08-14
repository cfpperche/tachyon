import { OpencodeLaunchPreflight } from "../../src/runtime/adapters/opencodeLaunchPreflight.js";
import { createDefaultLaunchPreflightRegistry } from "../../src/runtime/defaultLaunchPreflight.js";
import type { RuntimeLaunchPreflightPort } from "@tachyon/shared/runtime/launchPreflight.js";

/**
 * `t-0338fc` — the production launch preflight, with the one adapter that EXECUTES a runtime stubbed.
 *
 * OpenCode's adapter reads the runtime's own credential store (`opencode providers list`) because that
 * is the only thing that answers "is this authenticated?" before a credential-free launch quietly
 * succeeds on a fallback model. That makes it correct in production and wrong in a unit test: a suite
 * that inherited it would depend on whichever `opencode` the machine has, or on it being installed —
 * exactly the machine-dependence the canonical verifier's hermeticity forbids (SDD 387).
 *
 * The default stub answers as a credentialed home does, so opencode spawns behave as they did before
 * the gate existed. Pass `text` to exercise the refusal instead. Every other adapter is the real,
 * non-executing one, so an adapter added to production wiring is still exercised here.
 */
export function hermeticLaunchPreflight(
  text = "└  1 credentials",
  overrides: Readonly<Record<string, RuntimeLaunchPreflightPort>> = {},
) {
  return createDefaultLaunchPreflightRegistry({
    opencode: new OpencodeLaunchPreflight(async () => ({ code: 0, text })),
    ...overrides,
  });
}
