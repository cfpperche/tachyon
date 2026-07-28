import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_MEMORY_MEASURED_VERSION,
  claudeMemoryCapability,
  claudeMemoryStorePath,
  claudeMemoryVerificationPlan,
  claudeProjectKey,
  claudePurgePlanArgv,
  parseClaudePurgePlan,
} from "../../src/runtime/adapters/claudeMemory.js";
import { nativeMemoryCapability, resolveMemoryPolicy } from "../../src/runtime/nativeMemory.js";

/**
 * t-f22211 — what Claude Code's memory can be held to without billing anyone.
 *
 * The fixtures below are VERBATIM output from Claude Code 2.1.220 run against a sandboxed
 * `CLAUDE_CONFIG_DIR` on 2026-07-28 — not invented shapes. That matters because the adapter's whole
 * claim is that a non-billable path exists and answers three questions, and a test built on an
 * imagined format would prove only that the parser matches the imagination.
 */

/** Exactly what `claude project purge <repo> --dry-run -y` printed with a planted store. */
const REAL_PLAN_WITH_STORE = `
Purge plan for /tmp/claude-mem-I0Nj/repo:

  dir:    /tmp/claude-mem-I0Nj/cfg/projects/-tmp-claude-mem-I0Nj-repo
           project transcripts (.jsonl) and memory/

backups/ may still contain this project entry in old .claude.json snapshots (/tmp/claude-mem-I0Nj/cfg/backups); at most 5 are kept and they rotate out automatically
Dry run: 1 item(s) would be deleted.
`;

/** And what it printed before anything existed — the "nothing here" answer, also measured. */
const REAL_PLAN_EMPTY =
  "No Claude Code project state found for /tmp/claude-mem-I0Nj/repo under /tmp/claude-mem-I0Nj/cfg.\n";

describe("the store's shape, as measured", () => {
  it("keys a project by its absolute path with separators replaced", () => {
    // Measured, not documented: /tmp/claude-mem-I0Nj/repo resolved to -tmp-claude-mem-I0Nj-repo.
    expect(claudeProjectKey("/tmp/claude-mem-I0Nj/repo")).toBe("-tmp-claude-mem-I0Nj-repo");
  });

  it("places the store under the config home the caller chose", () => {
    // The isolation claim in its checkable form: the path is a function of CLAUDE_CONFIG_DIR, so a
    // sandbox home cannot resolve into the real one.
    const store = claudeMemoryStorePath("/tmp/sandbox/cfg", "/tmp/sandbox/repo");
    expect(store).toBe(path.join("/tmp/sandbox/cfg", "projects", "-tmp-sandbox-repo", "memory"));
    expect(store.startsWith("/tmp/sandbox/cfg")).toBe(true);
  });

  it("names the non-billable inspection verbatim, so a human can run it themselves", () => {
    expect(claudePurgePlanArgv("/tmp/sandbox/repo")).toEqual([
      "project",
      "purge",
      "/tmp/sandbox/repo",
      "--dry-run",
      "-y",
    ]);
  });
});

describe("the purge plan answers three questions without a model call", () => {
  it("names the exact target — the preview a destructive operation owes", () => {
    const plan = parseClaudePurgePlan(REAL_PLAN_WITH_STORE);
    expect(plan.targets).toEqual(["/tmp/claude-mem-I0Nj/cfg/projects/-tmp-claude-mem-I0Nj-repo"]);
    // …and it is under the sandbox config home, which is what makes the store's binding observable.
    expect(plan.targets[0].startsWith("/tmp/claude-mem-I0Nj/cfg")).toBe(true);
  });

  it("enumerates the store WITHOUT opening a memory file", () => {
    // The inventory axis, answered the only way the research permits: the plan says the directory
    // holds `memory/`, and nothing read its contents.
    expect(parseClaudePurgePlan(REAL_PLAN_WITH_STORE).namesMemory).toBe(true);
  });

  it("keeps the residue the plan discloses about itself", () => {
    // Unprompted, Claude says backups/ may still hold the project entry in rotated snapshots. A
    // product promising deletion has to carry that; dropping it here would make "purged" mean more
    // than it does.
    const plan = parseClaudePurgePlan(REAL_PLAN_WITH_STORE);
    expect(plan.residue).toContain("backups/");
    expect(plan.residue).toContain("rotate out automatically");
  });

  it("reads the empty answer as empty rather than as a parse failure", () => {
    const plan = parseClaudePurgePlan(REAL_PLAN_EMPTY);
    expect(plan.targets).toEqual([]);
    expect(plan.namesMemory).toBe(false);
    expect(plan.residue).toBeNull();
  });
});

describe("what the measurement does and does NOT promote", () => {
  const capability = claudeMemoryCapability(nativeMemoryCapability("claude")!);

  it("promotes inventory, because the store was enumerated", () => {
    expect(capability.evidence.inventory).toBe("verified");
  });

  it("leaves isolation DECLARED — the near-miss worth being strict about", () => {
    // The store's PATH is provably bound to the private home. Whether a LIVE session writes only
    // there is a different claim, and it needs a session. `verified` has to mean observed, including
    // when the observation is nearly enough.
    expect(capability.evidence.isolation).toBe("declared");
  });

  it("leaves every axis that needs a model call unverified", () => {
    for (const axis of ["disable", "enable", "injection", "mutation"] as const) {
      expect(capability.evidence[axis], `${axis} cannot be observed without a turn`).toBe("declared");
    }
  });

  it("carries a behavioral-test source for the axis it promoted", () => {
    // The registry's guard is that `verified` traces to an observation; this is that trace.
    expect(capability.sources.some((s) => s.kind === "behavioral-test")).toBe(true);
  });

  it("pins the exact version the evidence describes", () => {
    expect(capability.runtimeVersion).toBe(CLAUDE_MEMORY_MEASURED_VERSION);
    expect(CLAUDE_MEMORY_MEASURED_VERSION).toBe("2.1.220");
  });
});

describe("the policy consequence, which is the task's stated default", () => {
  const capability = claudeMemoryCapability(nativeMemoryCapability("claude")!);

  it("still BLOCKS `disabled`, because disable itself is unproven", () => {
    // Claude has memory ON by default, so this is rule 4's sharp edge: unverifiable disable must not
    // render as Ready. Closing it needs one authorized turn, not another config write.
    const outcome = resolveMemoryPolicy({
      adapter: "claude",
      requested: "disabled",
      observedVersion: CLAUDE_MEMORY_MEASURED_VERSION,
      capability,
    });
    expect(outcome.status).toBe("blocked");
    expect(outcome.reasons.join(" ")).toContain("only proves Tachyon authored bytes");
    expect(outcome.reasons.join(" ")).toContain("blocked rather than Ready");
  });

  it("still BLOCKS `runtime-managed` — the task's bar is not met", () => {
    // "Admit runtime-managed only with bounded startup injection, isolated write and purge evidence":
    // purge is evidenced, the other two are not.
    const outcome = resolveMemoryPolicy({
      adapter: "claude",
      requested: "runtime-managed",
      observedVersion: CLAUDE_MEMORY_MEASURED_VERSION,
      capability,
    });
    expect(outcome.status).toBe("blocked");
    expect(outcome.reasons.join(" ")).toContain("injection=declared");
  });

  it("refuses to answer for a different build", () => {
    const outcome = resolveMemoryPolicy({
      adapter: "claude",
      requested: "disabled",
      observedVersion: "2.2.0",
      capability,
    });
    expect(outcome.status).toBe("blocked");
    expect(outcome.reasons[0]).toContain("measured on 2.1.220");
  });
});

describe("the plan states its own cost before anyone authorizes it", () => {
  const plan = claudeMemoryVerificationPlan();

  it("separates what is free from what must be authorized", () => {
    expect(plan.withoutModelCall.length).toBeGreaterThan(0);
    expect(plan.needsAuthorization.map((entry) => entry.axis)).toEqual([
      "disable",
      "enable",
      "injection",
      "mutation",
    ]);
    // Each says what it would BUY, so the decision is about evidence rather than about spend.
    for (const entry of plan.needsAuthorization) expect(entry.proves.length).toBeGreaterThan(20);
  });

  it("covers all four lifecycle operations the task names", () => {
    expect(plan.lifecycle.map((entry) => entry.operation)).toEqual(["fresh", "restart", "resume", "fork"]);
    // Fork is the one worth proving most: Tachyon mints a distinct private home, so the marker must
    // be ABSENT — a claim about Tachyon's own behavior, not only about Claude's.
    expect(plan.lifecycle.find((entry) => entry.operation === "fork")?.method).toContain("must be absent");
  });
});
