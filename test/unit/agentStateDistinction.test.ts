import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { statusOf } from "../../src/sidebar/agentModel.js";
import type { AgentStatus } from "../../src/sidebar/types.js";

/**
 * t-0d689f — a live process is not a working agent.
 *
 * Measured 2026-07-27: the Bridge reported `attention: idle` for claude-opus5-2 and claude-opus5-4
 * while the sidebar drew them the same green as the agents that were actually producing output.
 * The state machine was never wrong — `statusOf` already separates idle from running. What collapsed
 * was the DOT: `done` (idle + unseen) was a filled ok dot with a 1px translucent ring, which at 7px
 * is the same silhouette as `running`.
 *
 * So these tests guard two things that must not drift apart: the state machine keeps its meanings,
 * and every state a human can see stays distinguishable by something other than a shade.
 */

const RAW = { name: "a", running: true, dead: false, crashed: false, cmd: "claude" };

function css(): string {
  return fs.readFileSync(path.resolve(__dirname, "..", "..", "src/webview/sidebar/sidebar.css"), "utf8");
}

/** The declarations of one `.sdot.<status>` rule, whitespace-normalised. */
function dotRule(status: string): string {
  const text = css();
  const start = text.indexOf(`.sdot.${status} `) >= 0 ? text.indexOf(`.sdot.${status} `) : text.indexOf(`.sdot.${status}\n`);
  expect(start, `no .sdot.${status} rule`).toBeGreaterThan(-1);
  const open = text.indexOf("{", start);
  const close = text.indexOf("}", open);
  return text.slice(open + 1, close).replace(/\s+/g, " ").trim();
}

describe("t-0d689f agent state is legible", () => {
  describe("state machine (unchanged — a live process is not `working`)", () => {
    it.each([
      ["idle attention with nobody watching yet", { attention: "idle", unseen: true }, "done"],
      ["idle attention already seen", { attention: "idle", unseen: false }, "idle"],
      ["needs input", { attention: "needs-input", unseen: false }, "needs"],
      ["throttled", { attention: "throttled", unseen: false }, "throttled"],
      ["actually producing output", { attention: "working", unseen: false }, "running"],
      ["no attention signal at all", { attention: undefined, unseen: false }, "running"],
    ] as const)("%s → %s", (_label, input, expected) => {
      expect(statusOf(RAW, input.attention, input.unseen)).toBe(expected);
    });

    it("never calls a stopped or crashed process working, whatever attention says", () => {
      expect(statusOf({ ...RAW, running: false }, "working", false)).toBe("stopped");
      expect(statusOf({ ...RAW, dead: true }, "working", false)).toBe("stopped");
      expect(statusOf({ ...RAW, dead: true, crashed: true }, "working", false)).toBe("crashed");
    });

    it("follows a turn ending and starting again", () => {
      // working → (turn ends, unread) done → (human looks) idle → (new turn) running
      expect(statusOf(RAW, "working", false)).toBe("running");
      expect(statusOf(RAW, "idle", true)).toBe("done");
      expect(statusOf(RAW, "idle", false)).toBe("idle");
      expect(statusOf(RAW, "working", false)).toBe("running");
    });
  });

  describe("the dot separates the states a human confuses", () => {
    it("done no longer shares running's silhouette — the measured defect", () => {
      const running = dotRule("running");
      const done = dotRule("done");

      expect(done).not.toBe(running);
      // Shape, not shade. The version this replaces ALSO differed textually from `running` — it had a
      // 1px `color-mix(..., transparent)` ring — and still read identical at 7px, which is exactly how
      // it shipped. Matching CSS text for "is it visible?" is a trap: nested `var()`/`color-mix()`
      // parens and commas defeat naive patterns (they defeated two of mine). So pin the DESIGN
      // decision instead — the ring is detached by a gap painted in the sidebar background, which the
      // old translucent wash had no way to express. The rendered proof lives in the headless QA,
      // which reads computed styles rather than source text.
      expect(done, "done's ring must be detached by a background-coloured gap")
        .toMatch(/--vscode-sideBar-background/);
      expect(running).not.toMatch(/box-shadow/);
    });

    it("keeps running, idle and done mutually distinct", () => {
      const rules = ["running", "idle", "done"].map(dotRule);

      expect(new Set(rules).size).toBe(3);
      // idle must not be drawn in the ok colour at all — that was the whole confusion.
      expect(dotRule("idle")).not.toContain("--ds-ok");
    });

    it("gives every rendered status its own rule", () => {
      const statuses: AgentStatus[] = [
        "running", "needs", "throttled", "done", "idle", "stopping", "stop-failed", "stopped", "crashed",
      ];
      const rules = statuses.map(dotRule);

      expect(new Set(rules).size).toBe(statuses.length);
    });
  });

  describe("meaning never rides on colour alone", () => {
    it("labels every status for the tooltip and the screen reader", () => {
      const app = fs.readFileSync(path.resolve(__dirname, "..", "..", "src/webview/sidebar/App.tsx"), "utf8");
      const statuses: AgentStatus[] = [
        "running", "needs", "throttled", "done", "idle", "stopping", "stop-failed", "stopped", "crashed",
      ];
      const labels = /const STATUS_LABEL[^=]*=\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";

      for (const status of statuses) {
        expect(labels, `STATUS_LABEL is missing ${status}`).toMatch(new RegExp(`["']?${status}["']?\\s*:`));
      }
      // The dot is decorative-with-meaning: it must carry both the hover text and the a11y name.
      expect(app).toMatch(/title=\{STATUS_LABEL\[a\.status\]\}/);
      expect(app).toMatch(/aria-label=\{STATUS_LABEL\[a\.status\]\}/);
    });

    it("names done and running differently for a screen reader", () => {
      const app = fs.readFileSync(path.resolve(__dirname, "..", "..", "src/webview/sidebar/App.tsx"), "utf8");
      const labels = /const STATUS_LABEL[^=]*=\s*\{([^}]*)\}/.exec(app)?.[1] ?? "";
      const done = /done:\s*"([^"]+)"/.exec(labels)?.[1];
      const running = /running:\s*"([^"]+)"/.exec(labels)?.[1];

      expect(done).toBeTruthy();
      expect(running).toBeTruthy();
      expect(done).not.toBe(running);
    });
  });
});
