import { describe, expect, it } from "vitest";
import { registerTools } from "../../src/bridge/tools.js";
import { renderPrimer } from "../../src/bridge/primer.js";
import { hostFallbackLine } from "../../src/workspace/GatedCompletionMonitor.js";

/**
 * t-8b8315 — a removed tool keeps giving orders through the text that named it.
 *
 * Removing the Delivery machinery took three stages, and each one grepped for MODULES and SYMBOLS.
 * None grepped for the tool NAME inside strings, so `verify_task` went on being announced to every
 * agent from the spawn primer and to every human from the idle-agent fallback line, months after
 * the handler behind it stopped existing. A reader cannot tell a live instruction from a fossil:
 * both are just prose the product emitted on purpose.
 *
 * t-e88c8a already produced one instance of this (`delivery_join` in PARENT_CWD_REFUSAL) and
 * 7351a74d fixed it by pinning that one message against the LIVE registration. This file
 * generalizes that guard, because a fix that protects a single string protects a single string:
 * the next tool removal would have to remember to come here, which is precisely the remembering
 * that failed three times already.
 *
 * The rule: any text Tachyon emits to an agent or a human may name a tool only if the Bridge
 * actually registers it. Deleting a tool then breaks this test, which is the point.
 */

class ToolCapture {
  handlers = new Map<string, unknown>();
  registerTool(name: string, _schema: unknown, handler: unknown) {
    this.handlers.set(name, handler);
  }
}

/** Every tool name the Bridge actually registers — the same registration the product serves. */
function liveToolNames(): Set<string> {
  const mcp = new ToolCapture();
  registerTools(mcp as never, { workspaceRoot: "/repo", caller: { kind: "agent", name: "ada" } } as never);
  return new Set(mcp.handlers.keys());
}

/**
 * snake_case words are the tool-shaped tokens. This deliberately over-matches: a non-tool snake_case
 * word appearing in emitted prose would fail here, and the honest fix is to rephrase the prose
 * rather than to widen the allowlist — emitted text that reads like a tool name IS the hazard,
 * whether or not the author meant it as one.
 */
function toolShapedNames(text: string): string[] {
  return text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
}

function assertNamesOnlyLiveTools(text: string, surface: string): void {
  const registered = liveToolNames();
  const dead = [...new Set(toolShapedNames(text))].filter((name) => !registered.has(name));
  expect(dead, `${surface} names ${dead.join(", ")}, which the Bridge does not register`).toEqual([]);
}

describe("t-8b8315 — emitted text never names a tool the Bridge does not register", () => {
  describe("the spawn primer", () => {
    /**
     * The primer is the worst surface to carry a dead pointer, and the reason is frequency: it is
     * not a rare error path, it is the opening of EVERY brief. The retired text told the agent that
     * `verify_task` would check a fixed oracle, so the agent budgeted care around a verifier that
     * could never run.
     */
    it("names only live tools, for a parented child", () => {
      const { primer, beforeFinishing } = renderPrimer({
        agentName: "helper",
        parent: "ada",
        verify: { full: "npm run verify:full", typecheck: "npm run typecheck" },
      });

      assertNamesOnlyLiveTools(primer, "the spawn primer");
      assertNamesOnlyLiveTools(beforeFinishing, "the before-finishing block");
    });

    it("names only live tools, for a top-level agent with no spawner", () => {
      const { primer, beforeFinishing } = renderPrimer({ agentName: "solo" });

      assertNamesOnlyLiveTools(primer, "the spawn primer (no spawner)");
      assertNamesOnlyLiveTools(beforeFinishing, "the before-finishing block (no spawner)");
    });

    /**
     * Guards the guard. If the primer ever stopped naming any tool at all, every assertion above
     * would pass vacuously — the same self-referential failure that let `delivery_join` survive.
     */
    it("still names at least one tool, so the check above cannot pass vacuously", () => {
      const { beforeFinishing } = renderPrimer({ agentName: "helper", parent: "ada" });

      expect(toolShapedNames(beforeFinishing).length).toBeGreaterThan(0);
    });
  });

  describe("the host fallback line", () => {
    /**
     * This line fires when an agent has gone quiet without ringing the doorbell — the moment a human
     * is already unsure what happened. Handing them a tool that does not exist spends their next
     * move on discovering that, which is worse than handing them nothing.
     */
    it("names only live tools for a gated child", () => {
      const line = hostFallbackLine({
        agent: "helper",
        deliveryId: "d-1",
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        ageMs: 10 * 60_000,
        evidence: "beyond-base",
      });

      assertNamesOnlyLiveTools(line, "the gated-child fallback line");
    });

    it("names only live tools for an assigned agent", () => {
      const line = hostFallbackLine({
        agent: "helper",
        deliveryId: "d-1",
        headSha: "a".repeat(40),
        baseSha: "b".repeat(40),
        ageMs: 10 * 60_000,
        evidence: "verified-since",
      });

      assertNamesOnlyLiveTools(line, "the assigned-agent fallback line");
    });
  });
});
