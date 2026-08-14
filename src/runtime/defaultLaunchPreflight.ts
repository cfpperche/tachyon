import { ClaudeLaunchPreflight } from "./adapters/claudeLaunchPreflight.js";
import { CodexLaunchPreflight } from "./adapters/codexLaunchPreflight.js";
import { GrokLaunchPreflight } from "./adapters/grokLaunchPreflight.js";
import { OpencodeLaunchPreflight } from "./adapters/opencodeLaunchPreflight.js";
import { RuntimeLaunchPreflightRegistry, type RuntimeLaunchPreflightPort } from "@tachyon/shared/runtime/launchPreflight.js";

/**
 * The production launch-preflight wiring, in one place.
 *
 * It lives here rather than inline in `AgentManager` because `t-0338fc` made the set of adapters
 * something tests have to reproduce: the opencode adapter EXECUTES the runtime to read its credential
 * store, so a test harness that inherited the real registry would shell out to whatever `opencode` the
 * machine happens to have — the hermeticity the canonical verifier depends on (SDD 387). Overriding
 * one adapter here keeps the rest of the wiring identical instead of hand-copied and free to drift.
 */
export function createDefaultLaunchPreflightRegistry(
  overrides: Readonly<Record<string, RuntimeLaunchPreflightPort>> = {},
): RuntimeLaunchPreflightRegistry {
  return new RuntimeLaunchPreflightRegistry({
    codex: new CodexLaunchPreflight(),
    claude: new ClaudeLaunchPreflight(),
    // t-85c586 — grok ships a bounded catalog command AND refuses anything outside it, so a pin
    // is authoritatively checkable rather than merely provisional.
    grok: new GrokLaunchPreflight(),
    // t-0338fc — opencode's adapter answers a different question than the others: not "does this
    // model exist" but "is there a credential at all". It is the one runtime measured to answer a
    // credential-free launch with a successful turn on a fallback model, so the launch boundary is
    // the last place that failure is still visible.
    opencode: new OpencodeLaunchPreflight(),
    ...overrides,
  });
}
