import { describe, it, expect } from "vitest";
import { effectiveVerify, verifyStale, verifyBadge, worktreeUnchanged, suggestVerify, verifySteps, type VerifyState } from "../../src/worktree/verify.js";
import type { TachyonConfig } from "../../src/config/loadConfig.js";

const settings = (s: Partial<TachyonConfig["settings"]> = {}): TachyonConfig["settings"] => s as TachyonConfig["settings"];
const state = (s: Partial<VerifyState> = {}): VerifyState => ({ command: "test", passed: true, atCommit: "abc", ranAt: "2026-06-14T00:00:00Z", ...s });

describe("verify-gate — pure helpers (spec 214)", () => {
  describe("effectiveVerify — per-agent wins over global", () => {
    it("per-agent verify wins", () => {
      expect(effectiveVerify({ verify: "test" }, settings({ worktree: { verify: "ci" } }))).toBe("test");
    });
    it("falls back to the global default", () => {
      expect(effectiveVerify({ verify: undefined }, settings({ worktree: { verify: "ci" } }))).toBe("ci");
    });
    it("undefined when neither is set", () => {
      expect(effectiveVerify({}, settings())).toBeUndefined();
      expect(effectiveVerify({ verify: "  " }, settings({ worktree: { verify: "  " } }))).toBeUndefined();
    });
  });

  describe("verifyStale", () => {
    it("no state → stale (never verified)", () => {
      expect(verifyStale(undefined, "abc", false)).toBe(true);
    });
    it("HEAD moved past the verified commit → stale", () => {
      expect(verifyStale(state({ atCommit: "abc" }), "def", false)).toBe(true);
    });
    it("same commit but dirty tree → stale", () => {
      expect(verifyStale(state({ atCommit: "abc" }), "abc", true)).toBe(true);
    });
    it("same commit, clean tree → fresh", () => {
      expect(verifyStale(state({ atCommit: "abc" }), "abc", false)).toBe(false);
    });
    it("empty atCommit → stale (can't trust)", () => {
      expect(verifyStale(state({ atCommit: "" }), "", false)).toBe(true);
    });
  });

  describe("verifyBadge", () => {
    it("never run → stale", () => {
      expect(verifyBadge(undefined, true)).toBe("stale");
    });
    it("stale wins over a prior pass/fail", () => {
      expect(verifyBadge(state({ passed: true }), true)).toBe("stale");
    });
    it("fresh pass → verified, fresh fail → failing", () => {
      expect(verifyBadge(state({ passed: true }), false)).toBe("verified");
      expect(verifyBadge(state({ passed: false }), false)).toBe("failing");
    });
  });

  describe("suggestVerify — stack-derived candidates", () => {
    it("Node: only present package.json scripts, in verify order (test → npm test)", () => {
      expect(suggestVerify("Node.js (Next.js)", { test: "vitest", build: "next build", lint: "eslint ." })).toEqual([
        "npm test",
        "npm run lint",
        "npm run build",
      ]);
    });
    it("Node with no scripts → empty (human types their own)", () => {
      expect(suggestVerify("Node.js", {})).toEqual([]);
    });
    it("Rust / Go / Python / PHP(Laravel) / Ruby(Rails) candidates", () => {
      expect(suggestVerify("Rust")).toEqual(["cargo test", "cargo clippy -- -D warnings", "cargo check"]);
      expect(suggestVerify("Go")).toEqual(["go test ./...", "go vet ./..."]);
      expect(suggestVerify("Python")).toEqual(["pytest", "python -m pytest", "ruff check ."]);
      expect(suggestVerify("PHP (Laravel)")).toEqual(["php artisan test", "vendor/bin/phpunit"]);
      expect(suggestVerify("Ruby (Rails)")).toEqual(["bin/rails test", "bundle exec rspec"]);
    });
    it("generic / unknown → empty (degrade gracefully)", () => {
      expect(suggestVerify("generic")).toEqual([]);
      expect(suggestVerify("whatever")).toEqual([]);
    });
  });

  describe("verifySteps — command > runbook > inline precedence", () => {
    it("a declared runbook name expands to its steps", () => {
      expect(verifySteps("ship", {}, { ship: { steps: ["lint", "npm test"] } })).toEqual(["lint", "npm test"]);
    });
    it("a command name or inline string is a single step (resolved later by the runner)", () => {
      expect(verifySteps("test", { test: {} }, {})).toEqual(["test"]);
      expect(verifySteps("npm run build", {}, { ship: { steps: ["x"] } })).toEqual(["npm run build"]);
    });
    it("a name that's BOTH a command and a runbook resolves as the command (matches docs)", () => {
      expect(verifySteps("check", { check: {} }, { check: { steps: ["a", "b"] } })).toEqual(["check"]);
    });
  });

  describe("worktreeUnchanged (spec 230 — pipeline no-op staleness)", () => {
    const z = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0, aheadOfBase: 0 };
    it("true when the worktree produced nothing", () => expect(worktreeUnchanged(z)).toBe(true));
    it("false on a NEW untracked file (agents create new files)", () => expect(worktreeUnchanged({ ...z, untracked: 1 })).toBe(false));
    it("false on staged / unstaged / conflict / commits-ahead", () => {
      expect(worktreeUnchanged({ ...z, staged: 1 })).toBe(false);
      expect(worktreeUnchanged({ ...z, unstaged: 1 })).toBe(false);
      expect(worktreeUnchanged({ ...z, conflicts: 1 })).toBe(false);
      expect(worktreeUnchanged({ ...z, aheadOfBase: 1 })).toBe(false);
    });
  });
});
