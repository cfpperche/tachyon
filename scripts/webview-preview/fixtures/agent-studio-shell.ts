/**
 * spec 350 Phase 3 T3/T5 — Agent Studio (shell) preview fixtures: the pilot's real agent-kind field set
 * (quick-add chips, name/command + flag chips, role, instructions, worktree section, isolated harness)
 * rendered on the studio shell, for the visual pass (create + edit) without needing the full extension host.
 */

import type { AgentStudioEntity } from "../../../src/webview/agent-studio-shell/domain";
import { blankAgentFields, canonicalAgentFields, createAgentEvolutionLabels, createAgentProfileLabels } from "../../../src/webview/agent-studio-shell/domain";
import type { AgentProfileStudioSnapshotV1 } from "../../../src/config/agentProfileStudio";
import type { AgentForgetPlanResultV1 } from "../../../src/config/agentForgetPlan";
import type { Fixture, Route } from "../routes";
import { ATTESTED_RUNTIMES } from "../../../src/runtime/attestedRuntimes";

interface AgentStudioShellFixtureVM {
  entity: AgentStudioEntity;
  loadError?: { code: string; message: string };
  /**
   * t-e722ce — a forget plan delivered after `load`, so the plan panel is addressable for a visual
   * pass without driving a click. The panel opens on the plan's arrival (its state follows the
   * data), which is the same path the real engine reply takes.
   */
  forgetPlan?: AgentForgetPlanResultV1;
}

const STUDIO_PROTOCOL_VERSION = 1;

function envelope<T extends { type: string }>(message: T) {
  return { ...message, studioProtocolVersion: STUDIO_PROTOCOL_VERSION };
}

export function agentStudioShellMakeMessage(vm: AgentStudioShellFixtureVM): unknown {
  if (vm.loadError) {
    return envelope({ type: "error", code: vm.loadError.code, message: vm.loadError.message, blocking: true });
  }
  const load = envelope({ type: "load", entity: vm.entity, concurrency: { kind: "none" } });
  if (!vm.forgetPlan) return load;
  return [load, envelope({ type: "agentProfileForgetPlan", agent: vm.entity.name ?? "", result: vm.forgetPlan })];
}

/** The state a human meets most: nothing blocks, the checkout goes, and the risk is real. */
const executableForgetPlan: AgentForgetPlanResultV1 = {
  schemaVersion: 1,
  kind: "plan",
  plan: {
    schemaVersion: 1,
    agentName: "reviewer",
    revision: "b".repeat(64),
    authority: "session-ledger",
    steps: [
      { id: "stop-session", state: "satisfied", detail: "no live session, pane or reservation holds this agent" },
      {
        id: "remove-worktree",
        state: "will-run",
        detail: "deletes the checkout at /home/dev/.cache/tachyon/worktrees/reviewer; branch tachyon/reviewer was created by Tachyon and is deleted if git can safe-delete it",
      },
      { id: "retire-evolution", state: "will-run", detail: "retires the stored Agent Evolution profile" },
      { id: "retire-authority", state: "will-run", detail: "retires this agent's record in the host authority vault" },
      { id: "remove-locator", state: "will-run", detail: "removes the 'reviewer' entry from tachyon.yml" },
      { id: "quarantine-profile", state: "will-run", detail: "moves .tachyon/agents/reviewer/ into the retirement receipt" },
      {
        id: "converge-runtime",
        state: "will-run",
        detail: "drops the session ledger row, the generated spawn brief, and the pane transcript",
      },
    ],
    dissent: [
      { source: "managed-worktree-registry", claim: "the worktree registry lists nothing; the ledger owns tachyon/reviewer, and the ledger decides" },
    ],
    retained: ["runtime homes", "runtime secrets", "session-owner rows", "continuity"],
    retiredToReceipt: ["canonical profile tree", "activity projections"],
    risk: {
      branch: "tachyon/reviewer",
      uncommittedChanges: 4,
      commitsAheadOfBase: 2,
      unpushedCommits: 2,
      aheadProbeFailed: false,
      branchDeletionPlanned: true,
      liveDescendants: [],
    },
    executable: true,
  },
};

/** The state the old flow could only render as "could not be completed". */
const blockedForgetPlan: AgentForgetPlanResultV1 = {
  schemaVersion: 1,
  kind: "plan",
  plan: {
    schemaVersion: 1,
    agentName: "reviewer",
    revision: "b".repeat(64),
    authority: "session-ledger",
    steps: [
      { id: "stop-session", state: "satisfied", detail: "no live session, pane or reservation holds this agent" },
      {
        id: "remove-worktree",
        state: "blocked",
        detail: "scout, tester still run inside this checkout",
        refusalCode: "agent-profile/worktree-release-agent-running",
        resolution: "Stop scout, tester first — they share this worktree.",
      },
      { id: "retire-evolution", state: "satisfied", detail: "this agent has no Agent Evolution profile" },
      { id: "retire-authority", state: "will-run", detail: "retires this agent's record in the host authority vault" },
      { id: "remove-locator", state: "will-run", detail: "removes the 'reviewer' entry from tachyon.yml" },
      { id: "quarantine-profile", state: "will-run", detail: "moves .tachyon/agents/reviewer/ into the retirement receipt" },
      {
        id: "converge-runtime",
        state: "will-run",
        detail: "drops the session ledger row, the generated spawn brief, and the pane transcript",
      },
    ],
    dissent: [],
    retained: ["runtime homes", "runtime secrets", "session-owner rows", "continuity"],
    retiredToReceipt: ["canonical profile tree", "activity projections"],
    risk: {
      branch: "tachyon/reviewer",
      uncommittedChanges: 4,
      commitsAheadOfBase: 0,
      unpushedCommits: 0,
      aheadProbeFailed: true,
      branchDeletionPlanned: true,
      liveDescendants: ["scout", "tester"],
    },
    executable: false,
  },
};

/**
 * t-d68b8b — the chip row a real host would now send, with the SET derived from `ATTESTED_RUNTIMES`
 * rather than hand-listed. This fixture used to name `agy` and `gemini`, which `quickAddChips` no
 * longer offers: a preview showing an offer the form has stopped making is a screenshot of a screen
 * that does not exist, and `t-d68b8b`'s browser guard reads this row.
 *
 * `quickAddChips` itself cannot be imported here — this module is bundled into the browser preview
 * and formLogic pulls `node:fs` through loadConfig — so only the labels are mirrored from
 * `AGENT_CATALOG`, and only for realism. The membership is the part that has to be true.
 */
const CHIP_LABELS: Record<string, string> = { claude: "Claude Code", codex: "OpenAI Codex", grok: "grok", pi: "Pi" };
const chips = ATTESTED_RUNTIMES.map((bin, index) => ({
  bin,
  label: CHIP_LABELS[bin] ?? bin,
  // Two detected, the rest not: the row has to show both chip states side by side to be worth a look.
  detected: index < 2,
  ...(index < 2 ? {} : { installHint: `install ${bin}` }),
}));

const flagMap = { claude: ["--dangerously-skip-permissions", "--model sonnet", "--model haiku", "--permission-mode plan", "--continue"] };
const evolutionLabels = createAgentEvolutionLabels();
const profileLabels = createAgentProfileLabels();

const newEntity: AgentStudioEntity = {
  fields: blankAgentFields(),
  chips,
  flagMap,
  defaultCwd: "/home/dev/project",
  persistentInstructionsHelp: "When supported, delivered at startup through the selected runtime.",
  evolutionLabels,
  profileLabels,
};

const denseEntity: AgentStudioEntity = {
  name: "reviewer",
  fields: {
    ...blankAgentFields(),
    name: "reviewer",
    cmd: "claude --model sonnet",
    instructions: "you are a code reviewer; read the diff and flag correctness issues before style ones.",
    autostart: true,
    attention: true,
    worktree: true,
    branch: "feature/auth-redesign",
    worktreeSetup: 'pnpm install\ncp "$TACHYON_WORKSPACE_ROOT/.env.local" .env.local',
  },
  chips,
  flagMap,
  defaultCwd: "/home/dev/project",
  persistentInstructionsHelp: "When supported, delivered at startup through the selected runtime.",
  evolutionLabels,
  profileLabels,
};

const canonicalSnapshot: AgentProfileStudioSnapshotV1 = {
  schemaVersion: 1,
  kind: "agent-instance",
  agentName: "reviewer",
  agentId: "123e4567-e89b-42d3-a456-426614174000",
  revision: "a".repeat(64),
  enabled: false,
  readiness: { state: "limited", limitations: ["fork-unavailable"] },
  editable: {
    displayName: "Repository reviewer", runtime: { adapter: "codex", executable: "codex", model: "gpt-5.6" },
    cwd: "apps/reviewer", lifecycle: { autostart: true, restart: "on-crash", attention: true },
    worktree: { enabled: true, branch: "feature/reviewer", setup: ["pnpm install", "pnpm --filter web build"] },
    selfEvolution: true, isolation: "transcript",
    capabilities: { skills: ["review-checklist"], mcp: ["docs-search"], hooks: [] },
  },
  bindings: {
    grants: { proposeSavedAgent: false },
    foreignWorkspaceCommands: false,
    environmentValueNames: ["NODE_ENV"], secretNames: ["GITHUB_TOKEN"],
    prompt: { instructions: true, evolution: true, memoryPolicy: "human-approved" },
    capabilities: { skills: 3, mcp: 1, hooks: 1, pi: 0 }, externalReferences: 2,
    tooling: {
      skills: [{ id: "review-checklist", scope: "profile" }, { id: "repo-search", scope: "project" }],
      mcp: [{ id: "docs-search", scope: "product" }],
      hooks: [{ id: "guard-output", scope: "project" }],
    },
  },
  provenance: {
    canonical: { scope: "profile", writable: true, sha256: "b".repeat(64) },
    authority: { scope: "host", writable: false, revision: "authority-r7", grants: 2 },
    learned: { scope: "profile", writable: false, present: true },
    projection: { scope: "runtime", writable: false, active: false },
  },
};

const canonicalEntity: AgentStudioEntity = {
  ...denseEntity,
  storage: "canonical",
  profile: canonicalSnapshot,
  fields: canonicalAgentFields(canonicalSnapshot),
};

/**
 * An agent whose setup commands were published by the WORKSPACE rather than by this profile.
 *
 * The one case where the setup field stays read-only. It is worth a fixture of its own because the
 * failure it guards against is invisible: a form that rendered the field blank and
 * editable would let the next save delete a value the human was never shown. The screen has to say
 * who owns them instead.
 */
const foreignWorkspaceCommandsEntity: AgentStudioEntity = {
  ...canonicalEntity,
  profile: {
    ...canonicalSnapshot,
    editable: { ...canonicalSnapshot.editable, worktree: { ...canonicalSnapshot.editable.worktree, setup: [] } },
    bindings: { ...canonicalSnapshot.bindings, foreignWorkspaceCommands: true },
  },
  fields: canonicalAgentFields({
    ...canonicalSnapshot,
    editable: { ...canonicalSnapshot.editable, worktree: { ...canonicalSnapshot.editable.worktree, setup: [] } },
    bindings: { ...canonicalSnapshot.bindings, foreignWorkspaceCommands: true },
  }),
};

/**
 * SDD 471 — the bypassPermissions authorization only renders for Claude with the permissions
 * family projected, so the Codex fixture above cannot show it. These two make the control (and its
 * risk copy) inspectable in both states.
 */
function claudeCanonicalSnapshot(authorize?: string[]): AgentProfileStudioSnapshotV1 {
  return {
    ...canonicalSnapshot,
    agentName: "claude-reviewer",
    editable: {
      ...canonicalSnapshot.editable,
      displayName: "Claude reviewer",
      runtime: { adapter: "claude", executable: "claude", model: "claude-opus-5", reasoningEffort: "high" },
      nativeConfig: {
        permissions: {
          source: "global", treatment: "overlay", refresh: "every-launch",
          lifecycle: ["fresh", "restart", "resume", "fork"],
          ...(authorize ? { authorize } : {}),
        },
        interface: {
          source: "global", treatment: "overlay", refresh: "every-launch",
          lifecycle: ["fresh", "restart", "resume", "fork"],
        },
      },
    },
  };
}

function claudeCanonicalEntity(authorize?: string[]): AgentStudioEntity {
  const profile = claudeCanonicalSnapshot(authorize);
  // Populate the read-only policy preview too, so the section above the editor does not claim
  // "no native configuration policy is authored" while the editor shows one.
  profile.provenance = {
    ...profile.provenance,
    nativeConfig: (["permissions", "interface"] as const).map((family) => ({
      family,
      source: "global" as const,
      treatment: "overlay" as const,
      refresh: "every-launch" as const,
      lifecycle: ["fresh", "restart", "resume", "fork"] as ("fresh" | "restart" | "resume" | "fork")[],
      support: "supported" as const,
      reason: `Claude declares filtered global ${family} projection for fresh, restart, resume and fork`,
    })),
  };
  return { ...denseEntity, storage: "canonical", profile, fields: canonicalAgentFields(profile) };
}

/**
 * SDD 472 — the Codex counterpart. The base canonical fixture is Codex but authors no native
 * config, so it cannot show the two danger authorizations; this one projects the permissions family.
 */
function codexCanonicalEntity(authorize?: string[]): AgentStudioEntity {
  const lifecycle = ["fresh", "restart", "resume"] as ("fresh" | "restart" | "resume" | "fork")[];
  const profile: AgentProfileStudioSnapshotV1 = {
    ...canonicalSnapshot,
    agentName: "codex-reviewer",
    editable: {
      ...canonicalSnapshot.editable,
      displayName: "Codex reviewer",
      nativeConfig: {
        permissions: {
          source: "global", treatment: "overlay", refresh: "every-launch",
          lifecycle: [...lifecycle], ...(authorize ? { authorize } : {}),
        },
        interface: { source: "global", treatment: "overlay", refresh: "every-launch", lifecycle: [...lifecycle] },
      },
    },
    provenance: {
      ...canonicalSnapshot.provenance,
      nativeConfig: (["permissions", "interface"] as const).map((family) => ({
        family,
        source: "global" as const,
        treatment: "overlay" as const,
        refresh: "every-launch" as const,
        lifecycle: [...lifecycle],
        support: "supported" as const,
        reason: `Codex declares filtered global ${family} projection for fresh, restart and resume`,
      })),
    },
  };
  return { ...denseEntity, storage: "canonical", profile, fields: canonicalAgentFields(profile) };
}

/**
 * t-d68b8b — a New Agent whose command names a runtime the creation path does not cover.
 *
 * Reachable by typing, not by clicking: the chip is gone, but the Command field is free text, and
 * this is the screen that has to explain itself when someone types `opencode` into it. Its whole
 * point is the blocking refusal above the fields and the disabled Save, so a visual pass that only
 * ever loaded `new` would never see either.
 */
const unattestedRuntimeEntity: AgentStudioEntity = {
  ...newEntity,
  // `storage: "canonical"` + `canonicalAgentFields()` is exactly what `AgentStudioAdapter.load(undefined)`
  // sends for a brand-new agent; the refusal only speaks for a canonical creation, so a fixture built
  // on `blankAgentFields()` would render the legacy form and show nothing.
  storage: "canonical",
  fields: { ...canonicalAgentFields(), name: "helper", cmd: "opencode" },
};

export const agentStudioShellFixtures: Record<string, Fixture<AgentStudioShellFixtureVM>> = {
  new: { provenance: "synthetic-edge", vm: { entity: newEntity } },
  "new-unattested-runtime": { provenance: "synthetic-edge", vm: { entity: unattestedRuntimeEntity } },
  "dense-edit": { provenance: "synthetic-edge", vm: { entity: denseEntity } },
  "canonical-disabled": { provenance: "synthetic-edge", vm: { entity: canonicalEntity } },
  "foreign-workspace-commands": { provenance: "synthetic-edge", vm: { entity: foreignWorkspaceCommandsEntity } },
  "canonical-claude-bypass-off": { provenance: "synthetic-edge", vm: { entity: claudeCanonicalEntity() } },
  "canonical-claude-bypass-on": { provenance: "synthetic-edge", vm: { entity: claudeCanonicalEntity(["bypassPermissions"]) } },
  "canonical-codex-danger-off": { provenance: "synthetic-edge", vm: { entity: codexCanonicalEntity() } },
  "canonical-codex-danger-on": {
    provenance: "synthetic-edge",
    vm: { entity: codexCanonicalEntity(["neverAskForApproval", "dangerFullAccess"]) },
  },
  // t-e722ce — the plan a human approves, in both of its shapes.
  "forget-plan": { provenance: "synthetic-edge", vm: { entity: canonicalEntity, forgetPlan: executableForgetPlan } },
  "forget-plan-blocked": { provenance: "synthetic-edge", vm: { entity: canonicalEntity, forgetPlan: blockedForgetPlan } },
  "load-error": { provenance: "synthetic-edge", vm: { entity: newEntity, loadError: { code: "persistence/not-found", message: "This agent no longer exists." } } },
};

export type { AgentStudioShellFixtureVM };
export type AgentStudioShellRoute = Route<AgentStudioShellFixtureVM>;
