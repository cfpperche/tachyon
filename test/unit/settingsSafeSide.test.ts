import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/loadConfig.js";
import { SETTINGS_DOOR_CLOSURES, SETTINGS_KEY_FALLBACKS } from "../../src/config/settingsSafeSide.js";

/**
 * t-48dd8d — tachyon.yml warns instead of refusing, and when it discards it falls to the SAFE side.
 *
 * The two halves are tested separately on purpose. The first half is easy to believe and easy to get
 * wrong in the direction that matters: the file must keep loading. The second half is the one the
 * owner's decision actually turns on — a discarded key must not hand out the permissive default,
 * because a warning nobody reads is not a control.
 *
 * What keeps this from becoming a list of examples that ages is NOT this file: it is
 * `scripts/check-settings-fallbacks.mjs`, which reads the config type, the declaration table and the
 * parser by AST and goes red when a key arrives undeclared. This file proves the declared behavior is
 * the real behavior, and the closure table below is checked for completeness against
 * `SETTINGS_DOOR_CLOSURES` so a new closure cannot ship without a case here either.
 */

describe("tachyon.yml warns instead of refusing", () => {
  it("keeps the whole file when one letter of a settings key is wrong", () => {
    // The motivating case: a typo in `ideBrowser` used to put the workspace on its degraded roster.
    const { config, errors, warnings } = parseConfig(
      [
        "agents:",
        "  worker:",
        "    cmd: claude",
        "settings:",
        "  ideBrowsr:",
        "    enabled: true",
        "  maxAgents: 12",
        "",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(config).toBeDefined();
    expect(config?.agents.worker?.cmd).toBe("claude");
    expect(config?.settings.maxAgents).toBe(12);
    expect(warnings.some((warning) => warning.includes("unknown key 'ideBrowsr'"))).toBe(true);
  });

  it("drops an unreadable value and keeps its siblings", () => {
    const { config, errors, warnings } = parseConfig(
      "settings:\n  bridgePort: not-a-port\n  clipboard: off\n",
    );
    expect(errors).toEqual([]);
    expect(config?.settings.bridgePort).toBeUndefined();
    expect(config?.settings.clipboard).toBe("off");
    expect(warnings.some((warning) => warning.includes("settings.bridgePort"))).toBe(true);
  });

  it("drops one bad roster entry and keeps the rest", () => {
    const { config, errors } = parseConfig(
      "agents:\n  good:\n    cmd: claude\n  bad:\n    autostart: true\n",
    );
    expect(errors).toEqual([]);
    expect(Object.keys(config?.agents ?? {})).toEqual(["good"]);
  });

  it("still refuses the two failures that leave nothing to salvage", () => {
    const broken = parseConfig("agents:\n  - this is not: a mapping\n   bad indent:\n");
    expect(broken.config).toBeUndefined();
    expect(broken.errors.length).toBeGreaterThan(0);

    const scalar = parseConfig("just-a-string\n");
    expect(scalar.config).toBeUndefined();
    expect(scalar.errors).toEqual(["tachyon.yml must be a YAML mapping"]);
  });

  it("leaves a key whose default is already closed at its default", () => {
    // `auth` is read as `auth ?? true`, so discarding it turns authentication ON. Nothing to install.
    const { config, errors, warnings } = parseConfig("settings:\n  auth: yes-please\n");
    expect(errors).toEqual([]);
    expect(config?.settings.auth).toBeUndefined();
    expect(warnings.some((warning) => warning.includes("settings.auth"))).toBe(true);
  });
});

/**
 * One case per door in `SETTINGS_DOOR_CLOSURES`. `assertClosed` states the door's PERMISSIVE absent
 * state and asserts the parser did not leave it there — not merely that some warning was produced.
 */
const CLOSURE_CASES: Record<string, { yaml: string; assertClosed: (result: ReturnType<typeof parseConfig>) => void }> = {
  companion: {
    // The exact typo from the task: `allowedHost` for `allowedHosts`. Today it refuses the file and
    // the human notices; the whole risk of warning instead is that they stop noticing.
    yaml: "settings:\n  companion:\n    tabTools: true\n    allowedHost:\n      - example.com\n",
    assertClosed: ({ config }) => {
      // tabSafety.hostAllowed returns true for EVERY host when the allowlist is missing, so leaving
      // tabTools on with no list is precisely the failure this rule exists to prevent.
      expect(config?.settings.companion).toBeUndefined();
      expect(config?.settings.companion?.tabTools).not.toBe(true);
      expect(config?.settings.companion?.lanAccess).not.toBe(true);
    },
  },
  legacyBridgeAuth: {
    yaml: "settings:\n  legacyBridgeAuth: nope\n",
    assertClosed: ({ config }) => {
      // Absent means `?? true` — the shared legacy token would be accepted as a caller identity.
      expect(config?.settings.legacyBridgeAuth).toBe(false);
    },
  },
  worktree: {
    yaml: "settings:\n  worktree:\n    base: ~/wt\n    shareDependency: false\n",
    assertClosed: ({ config }) => {
      // Both are read as `!== false`, so absence is the open side for each.
      expect(config?.settings.worktree?.shareDependencies).toBe(false);
      expect(config?.settings.worktree?.revealInWorkspace).toBe(false);
    },
  },
  agentPermissionProjection: {
    // The widest door in the product: a delegated codex agent with NOTHING projected is launched with
    // approval_policy="never" and sandbox_mode="danger-full-access", so a discarded `read-only` is
    // not a fall back to a runtime default — it is a fall forward into full access.
    yaml: [
      "agents:",
      "  builder:",
      "    cmd: codex",
      "settings:",
      "  agentPermissionProjection:",
      "    builder:",
      "      runtime: codex",
      "      sandboxMode: read-onlyy",
      "",
    ].join("\n"),
    assertClosed: ({ config }) => {
      const projected = config?.settings.agentPermissionProjection?.builder;
      expect(projected).toBeDefined();
      expect(projected).toMatchObject({
        runtime: "codex",
        approvalPolicy: "untrusted",
        sandboxMode: "read-only",
        bridgeToolApproval: "prompt",
      });
    },
  },
};

describe("discarding falls to the safe side, not to the default", () => {
  it("has a case for every declared closure", () => {
    // A closure added without a case here would ship untested, which is how a door quietly stops
    // closing. The declaration table is the list; this test refuses to be shorter than it.
    expect(Object.keys(CLOSURE_CASES).sort()).toEqual(SETTINGS_DOOR_CLOSURES.map((c) => c.domain).sort());
  });

  it.each(SETTINGS_DOOR_CLOSURES.map((closure) => closure.domain))("closes the '%s' door", (domain) => {
    const testCase = CLOSURE_CASES[domain]!;
    const result = parseConfig(testCase.yaml);
    expect(result.errors).toEqual([]);
    expect(result.config).toBeDefined();
    testCase.assertClosed(result);
    // The close is never silent: the human is told what was shut and why, next to the discard itself.
    expect(result.warnings.some((warning) => warning.includes(domain))).toBe(true);
  });

  it("does not close a door the file got right", () => {
    const { config, errors } = parseConfig(
      [
        "settings:",
        "  companion:",
        "    tabTools: true",
        "    allowedHosts:",
        "      - example.com",
        "  legacyBridgeAuth: true",
        "  worktree:",
        "    shareDependencies: true",
        "",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(config?.settings.companion?.tabTools).toBe(true);
    expect(config?.settings.companion?.allowedHosts).toEqual(["example.com"]);
    expect(config?.settings.legacyBridgeAuth).toBe(true);
    expect(config?.settings.worktree?.shareDependencies).toBe(true);
    expect(config?.settings.worktree?.revealInWorkspace).toBeUndefined();
  });

  it("closes a permission posture only for the agent whose entry failed", () => {
    const { config } = parseConfig(
      [
        "agents:",
        "  builder:",
        "    cmd: codex",
        "  helper:",
        "    cmd: codex",
        "settings:",
        "  agentPermissionProjection:",
        "    builder:",
        "      runtime: codex",
        "      sandboxMode: nonsense",
        "    helper:",
        "      runtime: codex",
        "      sandboxMode: workspace-write",
        "",
      ].join("\n"),
    );
    expect(config?.settings.agentPermissionProjection?.builder).toMatchObject({ sandboxMode: "read-only" });
    expect(config?.settings.agentPermissionProjection?.helper).toMatchObject({ sandboxMode: "workspace-write" });
  });

  it("projects nothing for a posture entry that names an agent the roster does not declare", () => {
    // There is no door to close: `resolveAgentPermissionProjection` is keyed by the managed agent
    // name, so an entry naming nobody governs nothing, and inventing a runtime for it would break
    // the spawn of whatever later takes that name.
    const { config, errors } = parseConfig(
      "settings:\n  agentPermissionProjection:\n    ghost:\n      runtime: codex\n      sandboxMode: nonsense\n",
    );
    expect(errors).toEqual([]);
    expect(config?.settings.agentPermissionProjection?.ghost).toBeUndefined();
  });
});

describe("an agent that asked to be contained does not start uncontained", () => {
  it.each([
    ["worktree", "    worktree: yes-please\n"],
    ["harness", "    harness: 42\n"],
    ["isolate", "    isolate: transcirpt\n"],
  ])("drops the whole entry when '%s' cannot be read", (key, line) => {
    const { config, errors, warnings } = parseConfig(`agents:\n  worker:\n    cmd: claude\n${line}`);
    expect(errors).toEqual([]);
    // Keeping the entry would put it in the PRIMARY CHECKOUT with the workspace's own configuration —
    // the opposite of what the file asked for, not a smaller version of it.
    expect(config?.agents.worker).toBeUndefined();
    expect(warnings.some((warning) => warning.includes(`'${key}' could not be read`))).toBe(true);
  });

  it("keeps an entry whose isolation declaration is fine", () => {
    const { config } = parseConfig("agents:\n  worker:\n    cmd: claude\n    worktree: true\n    harness: {}\n");
    expect(config?.agents.worker).toBeDefined();
  });

  it("does not drop a terminal over a key it never had", () => {
    // `worktree` is already refused for a terminal, and refusing it takes away nothing.
    const { config, errors } = parseConfig("terminals:\n  dev:\n    cmd: npm run dev\n    worktree: true\n");
    expect(errors).toEqual([]);
    expect(config?.agents.dev?.kind).toBe("terminal");
  });

  it("drops BOTH entries when one name is declared twice", () => {
    const { config, errors, warnings } = parseConfig(
      "agents:\n  dev:\n    cmd: claude\nterminals:\n  dev:\n    cmd: npm run dev\n",
    );
    expect(errors).toEqual([]);
    // Keeping the agent would resolve the ambiguity toward the more capable entity.
    expect(config?.agents.dev).toBeUndefined();
    expect(warnings.some((warning) => warning.includes("BOTH entries were dropped"))).toBe(true);
  });
});

describe("a harness never carries a capability its runtime does not support", () => {
  it("does not store a key the runtime cannot honor", () => {
    // These were reported AND stored: unobservable while any complaint refused the file, and a
    // materialized lie the moment a refusal became a discard.
    const { config } = parseConfig(
      "agents:\n  writer:\n    cmd: codex\n    harness:\n      rules: docs/rules.md\n      instructions: docs/agents.md\n",
    );
    expect(config?.agents.writer).toBeDefined();
    const harness = config?.agents.writer && "harness" in config.agents.writer ? config.agents.writer.harness : undefined;
    expect(harness?.rules).toBeUndefined();
    expect(harness?.instructions).toEqual(["docs/agents.md"]);
  });

  it("falls to the more isolated 'inherit' when the value cannot be read", () => {
    // `workspace` SEEDS the workspace base config into the private home; `none` does not.
    const { config } = parseConfig(
      "agents:\n  writer:\n    cmd: claude\n    harness:\n      inherit: whatever\n      skills: skills/one\n",
    );
    const harness = config?.agents.writer && "harness" in config.agents.writer ? config.agents.writer.harness : undefined;
    expect(harness?.inherit).toBe("none");
  });
});

describe("the declaration table", () => {
  it("says which way every key falls", () => {
    for (const entry of SETTINGS_KEY_FALLBACKS) {
      expect(entry.why, `${entry.path} must say what happens when it is discarded`).toBeTruthy();
    }
  });

  it("never leaves an 'opens' key without a closure or a written-down accepted risk", () => {
    // The same rule the AST guard enforces at build time, asserted against the loaded table so a
    // reader of the tests sees the contract without having to open the script.
    const covered = new Set(SETTINGS_DOOR_CLOSURES.flatMap((closure) => closure.covers));
    for (const entry of SETTINGS_KEY_FALLBACKS.filter((row) => row.direction === "opens")) {
      expect(
        covered.has(entry.path) || Boolean(entry.acceptedRisk),
        `${entry.path} widens the product when discarded — close it or declare the accepted risk`,
      ).toBe(true);
    }
  });
});
