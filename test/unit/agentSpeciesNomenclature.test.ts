/**
 * t-4cc561 — the species vocabulary is gone from the product's own language; what is left is a
 * CLOSED set of boundary-crossing names, and this pins it.
 *
 * The distinction this guard exists to hold: renaming an identifier or a sentence costs nothing,
 * but the same word in a `.strict()` wire schema, a discriminant literal or a persisted row is a
 * COMPATIBILITY CONTRACT. Renaming those is a protocol change (the ratified plan §1A says "renamed
 * in one cut, protocol bumped in the same commit"), never nomenclature cleanup — and a shell that
 * silently disagreed with a skewed engine about a field name is the 0.56.110 class of failure.
 *
 * So the allowlist below is not a list of things nobody got to. It is the boundary, written down.
 * A NEW file appearing here means somebody reintroduced the species into product language; a file
 * LEAVING it means a wire/persisted name moved and a protocol bump had better be in the same change.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();

/**
 * Guards that ASSERT a symbol's absence must name it to do so. Excluding them by path keeps this
 * check honest without letting it fail on the very files that enforce the same rule.
 */
const ABSENCE_GUARDS = [
  "test/unit/agentSpeciesNomenclature.test.ts",
  "test/unit/lineageUniformityInventory.test.ts",
];

function grepFiles(pattern: string, pathspecs: string[]): string[] {
  try {
    const out = execFileSync("git", ["grep", "-lniE", "-e", pattern, "--", ...pathspecs], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean).filter((f) => !ABSENCE_GUARDS.includes(f)).sort();
  } catch (error) {
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

/** Every file still allowed to say `adhoc`/`ad-hoc`, and the boundary that earns it the exemption. */
const BOUNDARY = {
  // the `mode: "adhoc"` handoff discriminant, end to end
  "src/runtime-api/handoffCommands.ts": "wire discriminant literal",
  "src/engine-service/protocol.ts": "wire validation of that discriminant",
  "src/handoff/distill.ts": "HandoffDistillMode, the discriminant's type",
  "src/webview/handoff/messages.ts": "webview action carrying the discriminant",
  "src/webview/handoff/App.tsx": "<option value> IS the discriminant; its label already reads Temporary",
  // the sidebar row's `adhoc` capability flag, produced and consumed across the engine/shell wire
  "src/runtime-api/sidebarProjection.ts": "strict() wire schema field",
  "src/sidebar/types.ts": "the row VM that schema validates",
  "src/sidebar/sidebarFleetService.ts": "produces the flag from lifetime",
  "src/sidebar/agentModel.ts": "carries the flag through the VM",
  "src/sidebar/actions.ts": "gates actions on the flag",
  "src/shell/WorkspacePresentation.ts": "produces the flag shell-side",
  "src/webview/SidebarPrototype.ts": "reads the flag into the (renamed) context-value param",
  // one provenance comment naming the map that t-eb4b30 deleted
  "src/agents/AgentManager.ts": "comment recording the removed `this.adhoc` map",
} as const;

describe("the canonical/ad-hoc species is gone from product language", () => {
  it("only boundary-crossing files may still say adhoc/ad-hoc", () => {
    const actual = grepFiles("\\badhoc\\b|ad-hoc", ["src"]);
    const allowed = Object.keys(BOUNDARY).sort();
    const reintroduced = actual.filter((f) => !(f in BOUNDARY));
    expect(reintroduced, "these files put the species back into product language").toEqual([]);
    // Not a subset check: a file DROPPING out means a wire name moved, which needs a protocol bump.
    expect(actual).toEqual(allowed);
  });

  it("the retired identifiers are gone everywhere, including where the gate cannot run the suite", () => {
    for (const id of [
      "AdhocBackstopMonitor",
      "DEFAULT_ADHOC_BACKSTOP_THRESHOLD_MS",
      "forgetAdhoc",
      "isAdhocItem",
      "isAdhocAiAgent",
      "startAdhocAgent",
      // `liveAdhocAgents` is NOT here, and the reason is the correction this guard needed: it was a
      // WIRE field (`task.board` input, validated by hasOnlyKeys), not an internal identifier. I
      // renamed it as if it were, with no protocol bump — a new shell would have had its board query
      // rejected by a protocol-5 engine. It is renamed now WITH the 5 -> 6 bump, and its skew
      // behaviour is pinned by boardQueryProtocolSkew.test.ts and engineReleaseCompatibility.test.ts,
      // which is where a wire name belongs. Listing it as a plain retired symbol is what hid the bug.
      "nameInLiveConfigOrAdhoc",
      "MAX_HANDOFF_ADHOC_ARGS",
      "preservesDeclaredLedger",
      "stripDeclaredParent",
      // t-a5bd6b — the TEST fixture vocabulary, which no guard reached: this file's word scan is
      // `src`-only and the `canonicalprofile` needle never matched `canonicalAgentFixture`. These
      // built a Saved agent (durable profile + host authority) while calling it canonical, so they
      // follow their subject: writeSavedAgent / savedAgentSecrets / savedAgentsYaml in
      // `test/helpers/savedAgentFixture.ts`.
      "writeCanonicalAgent",
      "canonicalAgentSecrets",
      "canonicalAgentsYaml",
      "CanonicalAgentSpec",
      "CanonicalAgentFixture",
      "canonicalAgentFixture",
      // NOT `canonicalSha256`: that is the live authority-record field for the sha of the
      // authoritative document, the same homonym class as `canonicalRoot`/`canonicalize`. Banning it
      // here would order a product field renamed on the strength of a word.
      // NOT `adhocAdmission`: t-eb4b30/t-7ff13d left provenance comments naming what they replaced,
      // in `agentRuntimeAdmission.ts` and its test. A comment that says "this replaces X" is how a
      // reader learns the history; banning the word would delete the explanation, not the species.
    ]) {
      expect(grepFiles(`\\b${id}\\b`, ["src", "test", "scripts"]), `${id} came back`).toEqual([]);
    }
  });

  it("the species-derived profile naming is gone (t-4cc561: CanonicalProfile -> AgentProfile/SavedAgentProfile)", () => {
    // Renameable in one cut because these types cross extension<->webview, and BOTH sides ship in the
    // same VSIX from the same dist/. That is the opposite of the engine wire, where the peer can be a
    // different build — which is why one family moved freely and the other needed a protocol bump.
    expect(grepFiles("canonicalprofile", ["src", "test", "scripts"])).toEqual([]);
  });

  /**
   * t-a5bd6b — why `test/` is NOT word-scanned, written down so it is a decision and not an omission.
   *
   * The test tree went from 191 occurrences of adhoc/ad-hoc to a residue that is entirely one of four
   * PRESERVED senses. A word ban over `test/` would order every one of them renamed:
   *   1. the `mode: "adhoc"` distill discriminant and its suites — the ratified homonym, which the
   *      coordinator ruled must not move (it would force an unjustified protocol bump);
   *   2. the row VM's `adhoc` capability flag — the `.strict()` wire field whose producers this file
   *      already allowlists, so its tests must spell it the way the wire does;
   *   3. arbitrary agent NAMES used as data (`some-ad-hoc-runner`, `live-ad-hoc`, `another-ad-hoc`),
   *      where "ad-hoc assignee" means "not in the roster" — a different axis entirely;
   *   4. `.gen.test.ts` files, which are container-generated and not hand-edited.
   * What DID move is everything that called an instance ad-hoc: helper names, test titles, prose, and
   * the comments left naming identifiers that t-eb4b30 and this task deleted.
   */
  it("no user-facing string calls an instance ad-hoc", () => {
    expect(grepFiles("ad-hoc agent|adhoc agent", ["src", "l10n", "package.nls.json", "package.nls.pt-br.json"]))
      .toEqual([]);
  });
});

/**
 * t-a95ae8 — the audit, made executable.
 *
 * Prose saying "the rest is fine" is not a proof of absence; a future reader cannot check it and a
 * future change cannot fail it. So every remaining `adhoc`/`ad-hoc` line in test/ and scripts/ is
 * bucketed here BY WHY IT SURVIVES, and the total is pinned. A new occurrence outside these buckets
 * fails; a bucket emptying out fails too, so a stale exemption cannot outlive its subject.
 */
describe("test/ and scripts/ residue is classified, not merely tolerated", () => {
  const CATEGORIES: Array<{ why: string; files: string[] }> = [
    {
      why: "subjects the PRESERVED wire: the `mode: \"adhoc\"` distill discriminant, or the row VM's `adhoc` flag",
      files: [
        "test/fixtures/sidebar/agentCardFixtures.ts",
        "test/unit/agentInstanceReaderConvergence.test.ts",
        "test/unit/engineServiceProtocol.test.ts",
        "test/unit/failVisibleConfigSidebar.test.ts",
        "test/unit/fakeWorkspaceClient.test.ts",
        "test/unit/handoffDistill.test.ts",
        "test/unit/handoffDistillService.test.ts",
        "test/unit/handoffTarget.test.ts",
        "test/unit/sidebarActions.test.ts",
      ],
    },
    {
      why: "uses the words as an arbitrary agent NAME or an assignee outside the roster — a different axis",
      files: [
        "scripts/webview-preview/fixtures/cockpit.ts",
        "test/unit/boardModel.test.ts",
        "test/unit/harness.test.ts",
        "test/unit/boardVm.test.ts",
      ],
    },
    {
      // `lineageUniformityInventory.test.ts` belongs here by nature but is NOT listed: it is already
      // in ABSENCE_GUARDS, and a file excused twice is a file whose exemption nobody can retire.
      why: "provenance: names what a prior stage REMOVED, or a dated repro. Deleting the word deletes the explanation",
      files: [
        "test/unit/agentProfileStudio.test.ts",
        "test/unit/ocGhostBehavior.gen.test.ts",
        "test/unit/ocGhostQBehavior.gen.test.ts",
        "test/unit/ocHarnessBehavior.gen.test.ts",
        "test/unit/snWaitHardenBehavior.gen.test.ts",
        "test/unit/workspaceHeadless.test.ts",
      ],
    },
    {
      why: "a HISTORICAL fixture key (`ad-hoc-contract`) that three files must match byte for byte, or a dated dogfood",
      files: [
        "scripts/dogfood/grok-attention-midturn.ts",
        "test/fixtures/agent-focus-line-dogfood/.tachyon/sessions.json",
        "test/fixtures/agent-focus-line-dogfood/README.md",
      ],
    },
    {
      why: "describes a DOOR or a label, not an instance: the admission door, a runbook label, a filter bucket",
      files: [
        "scripts/dogfood/adhoc-agent-boundary.ts",
        "scripts/dogfood/run.mjs",
        "test/unit/gatedCompletionMonitor.test.ts",
        "test/unit/loadPipeline.test.ts",
        "test/unit/runbooks.test.ts",
      ],
    },
    {
      why: "developer-facing test titles still using the old word for an instance — the honest remainder, harmless but not yet moved",
      files: [
        "test/unit/agentManager.test.ts",
        "test/unit/agentModel.test.ts",
        "test/unit/attention.test.ts",
        "test/unit/bridge.test.ts",
        "test/unit/pipelineDurability.test.ts",
      ],
    },
  ];

  it("every residue file is classified, and every classification still has a subject", () => {
    const actual = grepFiles("\\badhoc\\b|ad-hoc", ["test", "scripts"]);
    const classified = CATEGORIES.flatMap((c) => c.files).sort();
    expect(new Set(classified).size, "a file is listed under two categories").toBe(classified.length);
    expect(actual.filter((f) => !classified.includes(f)), "unclassified residue — put it in a bucket or remove it").toEqual([]);
    expect(classified.filter((f) => !actual.includes(f)), "stale exemption: the residue it excused is gone").toEqual([]);
  });
});
