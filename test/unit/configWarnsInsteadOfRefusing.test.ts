import { describe, expect, it } from "vitest";
import { asAgent, parseConfig } from "../../src/config/loadConfig.js";

/**
 * t-48dd8d — tachyon.yml warns instead of refusing, and it does exactly that and nothing more.
 *
 * The owner's rule, chosen on 2026-08-07 after seeing the full survey of which way every key falls:
 *
 *   1. An invalid or unknown key is DISCARDED with a warning; the rest of the file loads.
 *   2. If the key has a default today, THE DEFAULT RUNS. No special treatment.
 *   3. If it has no default, the warning is all that happens.
 *   4. NOTHING CLOSES ANYTHING. No door changes state because something else warned.
 *
 * Rule 4 has no exception, and the expensive one is pinned below: a delegated codex agent whose
 * permission line is discarded gets the class default, which is `danger-full-access`. That was chosen
 * with the number in hand — the alternative was one rule with one special case, and a rule with a
 * special case is a rule that rots. The measurement that priced the decision lives in the t-48dd8d
 * journal, where it stays useful without being behavior.
 */

describe("an unreadable key is discarded and the rest of the file loads", () => {
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

  it.each([
    ["agents", "agents:\n  worker:\n    cmd: claude\n    nope: 1\n"],
    ["terminals", "terminals:\n  dev:\n    cmd: npm run dev\n    nope: 1\n"],
    ["commands", "commands:\n  build:\n    cmd: npm run build\n    nope: 1\n"],
    ["runbooks", "runbooks:\n  ship:\n    steps: [build]\n    nope: 1\n"],
    ["schedules", "schedules:\n  nightly:\n    every: 1h\n    run: build\n    nope: 1\n"],
    ["settings", "settings:\n  nope: 1\n"],
    ["top level", "nope: 1\n"],
  ])("names the unknown key in the %s block and still loads", (_block, yaml) => {
    const withCommand = yaml.startsWith("schedules") ? `commands:\n  build:\n    cmd: x\n${yaml}` : yaml;
    const { config, errors, warnings } = parseConfig(withCommand);
    expect(errors).toEqual([]);
    expect(config).toBeDefined();
    expect(warnings.some((warning) => warning.includes("nope"))).toBe(true);
  });

  it("drops an unreadable value and keeps its siblings", () => {
    const { config, errors, warnings } = parseConfig("settings:\n  bridgePort: not-a-port\n  clipboard: off\n");
    expect(errors).toEqual([]);
    expect(config?.settings.bridgePort).toBeUndefined();
    expect(config?.settings.clipboard).toBe("off");
    expect(warnings.some((warning) => warning.includes("settings.bridgePort"))).toBe(true);
  });

  it("drops one bad roster entry and keeps the rest", () => {
    const { config, errors } = parseConfig("agents:\n  good:\n    cmd: claude\n  bad:\n    autostart: true\n");
    expect(errors).toEqual([]);
    expect(Object.keys(config?.agents ?? {})).toEqual(["good"]);
  });

  it("does not take the workspace down where it used to", () => {
    // Every one of these refused the WHOLE file before t-48dd8d, dropping the workspace to its
    // ledger/last-known-good roster and making spawning read-only.
    for (const yaml of [
      "settings:\n  ideBrowsr:\n    enabled: true\n",
      "settings:\n  companion:\n    tabTools: true\n    allowedHost:\n      - example.com\n",
      "settings:\n  auth: yes-please\n",
      "agents:\n  worker:\n    cmd: claude\n    worktree: yes-please\n",
      "terminals:\n  dev:\n    cmd: npm run dev\n    restart: sometimes\n",
      "settings:\n  persistence:\n    silentHooks: false\n",
    ]) {
      const { config, errors, warnings } = parseConfig(yaml);
      expect(errors, yaml).toEqual([]);
      expect(config, yaml).toBeDefined();
      expect(warnings.length, yaml).toBeGreaterThan(0);
    }
  });

  it("still refuses the two failures that leave nothing to salvage", () => {
    const broken = parseConfig("agents:\n  - this is not: a mapping\n   bad indent:\n");
    expect(broken.config).toBeUndefined();
    expect(broken.errors.length).toBeGreaterThan(0);

    const scalar = parseConfig("just-a-string\n");
    expect(scalar.config).toBeUndefined();
    expect(scalar.errors).toEqual(["tachyon.yml must be a YAML mapping"]);
  });
});

describe("the default runs — nothing is closed, nothing is substituted", () => {
  it("lets a discarded key fall to its default, whichever way that points", () => {
    const { config, errors } = parseConfig(
      [
        "settings:",
        "  auth: yes-please",              // default `?? true` → authentication ON
        "  legacyBridgeAuth: nope",        // default `?? true` → shared legacy token ACCEPTED
        "  maxAgents: four",               // default 8
        "  worktree:",
        "    shareDependency: false",      // typo → shareDependencies default (share) stands
        "",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    // Absent, every one of them — the parser installs nothing in place of what it could not read.
    expect(config?.settings.auth).toBeUndefined();
    expect(config?.settings.legacyBridgeAuth).toBeUndefined();
    expect(config?.settings.maxAgents).toBeUndefined();
    expect(config?.settings.worktree?.shareDependencies).toBeUndefined();
    expect(config?.settings.worktree?.revealInWorkspace).toBeUndefined();
  });

  it("keeps the readable half of a block whose other half was discarded", () => {
    const { config, errors, warnings } = parseConfig(
      "settings:\n  companion:\n    tabTools: true\n    allowedHost:\n      - example.com\n",
    );
    expect(errors).toEqual([]);
    // `tabTools` was written correctly, so it survives; only the misspelled key goes. Note what this
    // means and what the owner accepted: `tabSafety.hostAllowed` treats a missing allowlist as every
    // host — which is also the product's DECLARED default ("Empty = all hosts" in Control), so the
    // typo returns the factory setting rather than opening something that was shut by default.
    expect(config?.settings.companion?.tabTools).toBe(true);
    expect(config?.settings.companion?.allowedHosts).toBeUndefined();
    expect(warnings.some((warning) => warning.includes("allowedHost"))).toBe(true);
  });

  it("keeps an agent that declared an unreadable worktree, harness or isolate", () => {
    // Rule 4 reaches here too: the key goes, the entry does not, and the agent runs with the default
    // for that key — no worktree, no private config home, the shared transcript namespace.
    for (const [key, line] of [
      ["worktree", "    worktree: yes-please\n"],
      ["harness", "    harness: 42\n"],
      ["isolate", "    isolate: transcirpt\n"],
    ] as const) {
      const { config, errors, warnings } = parseConfig(`agents:\n  worker:\n    cmd: claude\n${line}`);
      expect(errors, key).toEqual([]);
      const worker = asAgent(config?.agents.worker);
      expect(worker, key).toBeDefined();
      expect(worker?.worktree, key).toBeUndefined();
      expect(worker?.harness, key).toBeUndefined();
      expect(worker?.isolate, key).toBeUndefined();
      expect(warnings.some((warning) => warning.includes(key)), key).toBe(true);
    }
  });
});

describe("the owner's choice on the agent permission line, pinned", () => {
  /**
   * The expensive case, chosen deliberately. `AgentManager` gives a DELEGATED codex agent
   * `approval_policy="never"` + `sandbox_mode="danger-full-access"` when nothing is projected
   * (`CODEX_DELEGATED_*`, AgentManager.ts:385-386). So a discarded `sandboxMode: read-only` does not
   * land on a runtime default — it lands on full access.
   *
   * The parser projects NOTHING anyway. If this test ever starts asserting a substituted posture,
   * someone has re-added the special case the owner cut twice; that needs his written order, not a
   * good argument.
   */
  it("projects nothing for a discarded entry — the class default stands", () => {
    const { config, errors, warnings } = parseConfig(
      [
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
    );
    expect(errors).toEqual([]);
    expect(config?.settings.agentPermissionProjection?.builder).toBeUndefined();
    expect(warnings.some((warning) => warning.includes("agentPermissionProjection.builder.sandboxMode"))).toBe(true);
  });

  it("discards only the entry that was wrong, never a neighbour that was right", () => {
    // Rule 1, at the granularity the rule actually names. The block used to be stored only if EVERY
    // entry parsed, so one agent's typo silently dropped a posture another agent had written
    // correctly — that is discarding what is valid, which is a different thing from tolerating what
    // is not.
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
        "      sandboxMode: read-only",
        "",
      ].join("\n"),
    );
    expect(config?.settings.agentPermissionProjection?.builder).toBeUndefined();
    expect(config?.settings.agentPermissionProjection?.helper).toMatchObject({ sandboxMode: "read-only" });
  });
});

describe("ambiguity is discarded, which is not the same as closing a door", () => {
  it("drops BOTH entries when one name is declared twice", () => {
    // Neither declaration is wrong on its own; the FILE is, because one name cannot name two things.
    // Keeping the `agents:` one would resolve the ambiguity toward the more capable entity.
    const { config, errors, warnings } = parseConfig(
      "agents:\n  dev:\n    cmd: claude\nterminals:\n  dev:\n    cmd: npm run dev\n",
    );
    expect(errors).toEqual([]);
    expect(config?.agents.dev).toBeUndefined();
    expect(warnings.some((warning) => warning.includes("BOTH entries were dropped"))).toBe(true);
  });

});

describe("a harness never carries a capability its runtime does not support", () => {
  // Not a safety rule and not a closure — a plain bug, and the one the survey turned up on the way
  // past. These keys were REPORTED as unsupported and then stored anyway: unobservable while every
  // complaint refused the file, a harness materialized with a capability the runtime cannot honor the
  // moment a refusal became a discard.
  it("does not store a key the runtime cannot honor", () => {
    const { config } = parseConfig(
      "agents:\n  writer:\n    cmd: codex\n    harness:\n      rules: docs/rules.md\n      instructions: docs/agents.md\n",
    );
    const harness = asAgent(config?.agents.writer)?.harness;
    expect(harness?.rules).toBeUndefined();
    expect(harness?.instructions).toEqual(["docs/agents.md"]);
  });

  it("leaves 'inherit' at its default when the value cannot be read", () => {
    // Rule 2 — the default runs. `workspace` is what an omitted `inherit` has always meant.
    const { config } = parseConfig(
      "agents:\n  writer:\n    cmd: claude\n    harness:\n      inherit: whatever\n      skills: skills/one\n",
    );
    expect(asAgent(config?.agents.writer)?.harness?.inherit).toBe("workspace");
  });
});
