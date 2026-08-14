import { describe, it, expect } from "vitest";
import {
  validateSpawnContract,
  composeSpawnContractBrief,
  notifyParentGuidance,
  noInteractivePromptGuidance,
  identityLine,
  taskJournalGuidance,
  idleSpawnGuidance,
  briefCarriesTaskSubstance,
  briefTaskSubstance,
  normalizeField,
  spawnContractCompletion,
  type SpawnContract,
} from "@tachyon/engine/bridge/spawnContract.js";

const good: SpawnContract = {
  task: "Add a retry to the upload client",
  context: "src/upload/client.ts times out on flaky networks",
  constraints: "no new deps; keep the public signature",
  deliverable: "a unit test proving 3 retries with backoff",
};

describe("validateSpawnContract (spec 246 D5)", () => {
  it.each([
    [{ deliverable: "artifact", doneWhen: undefined }, "deliverable"],
    [{ deliverable: undefined, doneWhen: "tests pass" }, "done_when"],
    [{ deliverable: undefined, doneWhen: undefined }, undefined],
    [{ deliverable: "artifact", doneWhen: "tests pass" }, undefined],
    [{ deliverable: "   ", doneWhen: undefined }, undefined],
  ] as const)("classifies the closed completion shape %#", (contract, expected) => {
    expect(spawnContractCompletion(contract)).toBe(expected);
  });

  it("accepts a substantive contract", () => {
    expect(validateSpawnContract(good)).toEqual({ ok: true, errors: [] });
  });

  it("requires task, context, constraints", () => {
    const r = validateSpawnContract({ deliverable: "a green test that covers it" });
    expect(r.ok).toBe(false);
    expect(r.errors.join(" ")).toMatch(/task:/);
    expect(r.errors.join(" ")).toMatch(/context:/);
    expect(r.errors.join(" ")).toMatch(/constraints:/);
  });

  it("requires exactly one of deliverable / done_when", () => {
    expect(validateSpawnContract({ ...good, deliverable: undefined, doneWhen: undefined }).errors.join(" ")).toMatch(/deliverable OR done_when/);
    expect(validateSpawnContract({ ...good, doneWhen: "the suite is green on CI" }).errors.join(" ")).toMatch(/exactly ONE/);
  });

  it("accepts done_when as the alternative", () => {
    expect(validateSpawnContract({ ...good, deliverable: undefined, doneWhen: "npm test exits 0 on the changed module" }).ok).toBe(true);
  });

  // D5 substance corpus
  const reject = ["", "   ", "<task>", "{{describe}}", "asdf", "QWER", "tbd", "todo", "n/a", "none", "xxx", "short", "x"];
  for (const v of reject) {
    it(`rejects junk/placeholder/too-short task: ${JSON.stringify(v)}`, () => {
      expect(validateSpawnContract({ ...good, task: v }).ok).toBe(false);
    });
  }

  const pass = ["tests pass", "Fix lint.", "src/foo.ts", "read-only", "add retry logic", "ship 0.34.0"];
  for (const v of pass) {
    it(`accepts terse-but-real task: ${JSON.stringify(v)}`, () => {
      expect(validateSpawnContract({ ...good, task: v }).ok).toBe(true);
    });
  }

  // t-5bcfa3 — 4 real spawn_agent contracts (2026-07-03/04) got falsely rejected because the field
  // contained a code/doc reference like "<select>" or "<id>" embedded in otherwise substantive prose;
  // PLACEHOLDER_RE was unanchored and matched that mid-string tag. It must only reject a value that IS
  // nothing but an untouched template placeholder, never one that merely mentions one.
  const embeddedPlaceholderProse = [
    // mcFixes context (rejected 2026-07-03 ~17:2x)
    "The native <select> elements are unstyled (white background) — style them with design tokens on the board and the detail view.",
    // tsFixes constraints (rejected 2026-07-03 ~17:4x)
    "Always commit by pathspec (git commit <arquivos> -m msg) — the index is shared with other agents and swallowed someone else's WIP today.",
    // deliveryHard context (rejected 2026-07-04 ~00:2x)
    'Fire the same notice with a short summary: "[tachyon] task assigned: <id> — <title truncated> (by <caller>)".',
    // agentIdent task (rejected 2026-07-04 ~01:2x)
    'The spawn contract brief opens with an explicit line: "You are agent <name> (TACHYON_AGENT_NAME)" before everything else.',
    // a mustache-style embedded placeholder should get the same treatment as angle brackets
    "Use the {{describe}} field name in the generated docs, then move on to the next step.",
  ];
  for (const v of embeddedPlaceholderProse) {
    it(`accepts substantive prose that merely mentions a placeholder-shaped token: ${JSON.stringify(v.slice(0, 40))}…`, () => {
      expect(validateSpawnContract({ ...good, task: v, context: v, constraints: v }).ok).toBe(true);
    });
  }

  it("still rejects a value that IS nothing but an untouched placeholder, even with surrounding whitespace", () => {
    expect(validateSpawnContract({ ...good, task: "  <task>  " }).ok).toBe(false);
    expect(validateSpawnContract({ ...good, task: "  {{describe}}  " }).ok).toBe(false);
  });

  it("counts non-whitespace codepoints, not UTF-16 units, toward the length floor", () => {
    // "café" x2 worth of accented codepoints plus digits — real substance, no ASCII-token pairs needed
    expect(validateSpawnContract({ ...good, task: "café — números” 42" }).ok).toBe(true);
  });
});

describe("composeSpawnContractBrief (spec 246 D3)", () => {
  it("composes the slots in order, labeled, after the identity line", () => {
    const b = composeSpawnContractBrief("worker-1", good);
    expect(b).toBe(
      `${identityLine("worker-1")}\n\n` +
        "TASK: Add a retry to the upload client\n" +
        "CONTEXT: src/upload/client.ts times out on flaky networks\n" +
        "CONSTRAINTS: no new deps; keep the public signature\n" +
        "DELIVERABLE: a unit test proving 3 retries with backoff\n\n" +
        taskJournalGuidance(),
    );
  });

  it("uses DONE_WHEN when deliverable absent", () => {
    const b = composeSpawnContractBrief("worker-1", { ...good, deliverable: undefined, doneWhen: "the suite is green" });
    expect(b).toMatch(/DONE_WHEN: the suite is green/);
    expect(b).not.toMatch(/DELIVERABLE:/);
  });

  it("appends optional free-form instructions after the contract", () => {
    const b = composeSpawnContractBrief("worker-1", good, "Prefer fetch over axios.");
    expect(b).toContain("\n\nPrefer fetch over axios.\n\n");
    expect(b.endsWith(taskJournalGuidance())).toBe(true);
  });

  it("never truncates an over-long field — carries it in full, byte for byte (t-11a2d1)", () => {
    const longContext = "x".repeat(2000);
    const b = composeSpawnContractBrief("worker-1", { ...good, context: longContext });
    const ctx = b.split("\n").find((l) => l.startsWith("CONTEXT:"))!;
    expect(ctx).toBe(`CONTEXT: ${longContext}`);
    expect(ctx.endsWith("…")).toBe(false);
  });

  it("does not bound the total brief below the 64KB hard cap — a realistic 6KB contract passes through whole", () => {
    const b = composeSpawnContractBrief("worker-1", good, "y".repeat(5000));
    expect(b).toContain("y".repeat(5000));
    expect(b.length).toBeGreaterThan(5000);
  });

  it("rejects a contract over the 64KB hard cap with an explicit, actionable error instead of silently clipping it", () => {
    expect(() => composeSpawnContractBrief("worker-1", { ...good, context: "x".repeat(70_000) })).toThrow(/64KB|64 ?\* ?1024|hard cap/i);
  });

  it("accepts a contract exactly at the 64KB hard cap boundary", () => {
    const base = [`TASK: ${good.task}`, `CONTEXT: ${good.context}`, `CONSTRAINTS: ${good.constraints}`, `DELIVERABLE: ${good.deliverable}`].join("\n");
    const instructions = "x".repeat(64 * 1024 - base.length - "\n\n".length);

    expect(() => composeSpawnContractBrief("worker-1", good, instructions)).not.toThrow();
  });

  it("rejects a contract one char over the 64KB hard cap boundary", () => {
    const base = [`TASK: ${good.task}`, `CONTEXT: ${good.context}`, `CONSTRAINTS: ${good.constraints}`, `DELIVERABLE: ${good.deliverable}`].join("\n");
    const instructions = "x".repeat(64 * 1024 - base.length - "\n\n".length + 1);

    expect(() => composeSpawnContractBrief("worker-1", good, instructions)).toThrow(/65537 chars.*65536-char.*64KB.*hard cap/i);
  });

  it("accepts a contract comfortably under the 64KB cap (coordinator contracts run 2-6KB in the wild)", () => {
    expect(() => composeSpawnContractBrief("worker-1", { ...good, context: "x".repeat(6000) })).not.toThrow();
  });
});

describe("composeSpawnContractBrief — t-d7b3a9 layer A identity line", () => {
  it("opens the brief with the identity line naming the child's own agent name", () => {
    const b = composeSpawnContractBrief("codex-review", good);
    expect(b.startsWith(identityLine("codex-review"))).toBe(true);
  });

  it("names the exact agent, distinct agents get distinct identity lines", () => {
    const a = composeSpawnContractBrief("claude-2", good);
    const b = composeSpawnContractBrief("codex-review", good);
    expect(a).toContain("You are agent claude-2");
    expect(b).toContain("You are agent codex-review");
    expect(a).not.toContain("You are agent codex-review");
  });

  it("points the agent at its own $TACHYON_AGENT_NAME env var", () => {
    expect(identityLine("codex-review")).toMatch(/\$TACHYON_AGENT_NAME/);
  });

  it("still opens with the identity line for a large (multi-KB, under-cap) contract", () => {
    const large: SpawnContract = { ...good, context: "x".repeat(3000), constraints: "y".repeat(3000) };
    const b = composeSpawnContractBrief("codex-review", large, "z".repeat(3000));
    expect(b.startsWith(identityLine("codex-review"))).toBe(true);
    // and the large content is carried through in full, not truncated
    expect(b).toContain("x".repeat(3000));
    expect(b).toContain("y".repeat(3000));
    expect(b).toContain("z".repeat(3000));
  });
});

describe("composeSpawnContractBrief — spec 332 parent-aware notify guidance (dueto F5/F6)", () => {
  it("appends no guidance when parent is omitted", () => {
    const b = composeSpawnContractBrief("worker-1", good);
    expect(b).not.toMatch(/notify_agent\(to:/);
  });

  it("appends the notify_agent guidance, naming the parent, when parent is given", () => {
    const b = composeSpawnContractBrief("worker-1", good, undefined, "orchestrator");
    expect(b).toMatch(/notify_agent\(to: "orchestrator"/);
    // it ADDS to (not replaces) the human-facing completion reporting language
    expect(b).toMatch(/in ADDITION to.*normal completion reporting/);
  });

  it("appends the guidance in full after a large (multi-KB, under-cap) contract, which is itself carried in full", () => {
    const large: SpawnContract = { ...good, context: "x".repeat(2000), constraints: "y".repeat(2000) };
    const b = composeSpawnContractBrief("worker-1", large, "z".repeat(2000), "orchestrator");
    const guidance = `${notifyParentGuidance("orchestrator")}\n\n${noInteractivePromptGuidance("orchestrator")}`;
    expect(b.endsWith(guidance)).toBe(true);
    expect(b).toContain("x".repeat(2000));
    expect(b).toContain("y".repeat(2000));
    expect(b).toContain("z".repeat(2000));
  });

  it("notifyParentGuidance interpolates the exact parent name", () => {
    expect(notifyParentGuidance("codex-2")).toContain('notify_agent(to: "codex-2"');
  });
});

describe("composeSpawnContractBrief — t-8605be no-blocking-on-prompts guidance", () => {
  it("appends no guidance when parent is omitted", () => {
    const b = composeSpawnContractBrief("worker-1", good);
    expect(b).not.toMatch(/interactive prompt/);
  });

  it("appends the no-blocking guidance, naming the parent, when parent is given", () => {
    const b = composeSpawnContractBrief("worker-1", good, undefined, "orchestrator");
    expect(b).toMatch(/Don't block on an interactive prompt/);
    expect(b).toMatch(/notify_agent\(to: "orchestrator"/);
    // it comes after the completion-notify guidance, not in place of it
    const notifyIdx = b.indexOf("When the deliverable/done_when is met");
    const promptIdx = b.indexOf("Don't block on an interactive prompt");
    expect(notifyIdx).toBeGreaterThan(-1);
    expect(promptIdx).toBeGreaterThan(notifyIdx);
  });

  it("appends the guidance in full after a large (multi-KB, under-cap) contract", () => {
    const large: SpawnContract = { ...good, context: "x".repeat(2000), constraints: "y".repeat(2000) };
    const b = composeSpawnContractBrief("worker-1", large, "z".repeat(2000), "orchestrator");
    expect(b.endsWith(noInteractivePromptGuidance("orchestrator"))).toBe(true);
  });

  it("noInteractivePromptGuidance interpolates the exact parent name", () => {
    expect(noInteractivePromptGuidance("codex-2")).toContain('notify_agent(to: "codex-2"');
  });
});

describe("t-e3aaae brief task substance", () => {
  // Drift guard: every fixed protocol rendering this module emits must be recognized as boilerplate.
  // If one is reworded without updating the recognizer, a boilerplate-only brief would start
  // claiming to carry a task again — which is the whole defect.
  it.each([
    ["identity line", identityLine("claude-opus5")],
    ["notify-parent guidance", notifyParentGuidance("codex-canonico")],
    ["no-interactive-prompt guidance", noInteractivePromptGuidance("codex-canonico")],
    ["task journal guidance", taskJournalGuidance()],
    ["idle spawn guidance", idleSpawnGuidance("parked until the human names the task")],
  ])("classifies the %s as protocol boilerplate, not task substance", (_label, rendering) => {
    expect(briefCarriesTaskSubstance(rendering)).toBe(false);
  });

  it("finds no substance in the persisted brief that made a restart claim a task it never had", () => {
    // Verbatim shape of agent `claude-opus5`'s ledger row on 2026-07-27: identity + doorbell +
    // no-blocking guidance, and nothing whatsoever about the work.
    const persisted = [
      identityLine("claude-opus5"),
      notifyParentGuidance("codex-canonico"),
      noInteractivePromptGuidance("codex-canonico"),
    ].join("\n\n");

    expect(briefCarriesTaskSubstance(persisted)).toBe(false);
    expect(briefTaskSubstance(persisted)).toBe("");
  });

  it("keeps real task text that sits beside the boilerplate", () => {
    const brief = composeSpawnContractBrief("worker-1", good, undefined, "orchestrator");

    expect(briefCarriesTaskSubstance(brief)).toBe(true);
    expect(briefTaskSubstance(brief)).toContain("TASK:");
    expect(briefTaskSubstance(brief)).not.toContain("$TACHYON_AGENT_NAME");
  });

  it("treats an empty or whitespace-only brief as no substance", () => {
    expect(briefCarriesTaskSubstance(undefined)).toBe(false);
    expect(briefCarriesTaskSubstance("")).toBe(false);
    expect(briefCarriesTaskSubstance("   \n\n  ")).toBe(false);
  });

  it("counts free-form instructions handed to a contract-skipped spawn as substance", () => {
    const brief = `${identityLine("worker-1")}\n\nFinish the migration in docs/specs/478 and report the SHA.\n\n${notifyParentGuidance("orchestrator")}`;

    expect(briefCarriesTaskSubstance(brief)).toBe(true);
    expect(briefTaskSubstance(brief)).toBe("Finish the migration in docs/specs/478 and report the SHA.");
  });
});

describe("normalizeField", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeField("  a\n\t b  ")).toBe("a b");
    expect(normalizeField(undefined)).toBe("");
  });
});
