/**
 * spec 350 Phase 3 T3/T5 — Agent Studio (shell) preview fixtures: the pilot's real agent-kind field set
 * (quick-add chips, name/command + flag chips, role, instructions, worktree section, isolated harness)
 * rendered on the studio shell, for the visual pass (create + edit) without needing the full extension host.
 */

import type { AgentStudioEntity } from "../../../src/webview/agent-studio-shell/domain";
import { blankAgentFields, canonicalAgentFields, createAgentEvolutionLabels, createAgentProfileLabels } from "../../../src/webview/agent-studio-shell/domain";
import type { AgentProfileStudioSnapshotV1 } from "../../../src/config/agentProfileStudio";
import type { Fixture, Route } from "../routes";

interface AgentStudioShellFixtureVM {
  entity: AgentStudioEntity;
  loadError?: { code: string; message: string };
}

const STUDIO_PROTOCOL_VERSION = 1;

function envelope<T extends { type: string }>(message: T) {
  return { ...message, studioProtocolVersion: STUDIO_PROTOCOL_VERSION };
}

export function agentStudioShellMakeMessage(vm: AgentStudioShellFixtureVM): unknown {
  if (vm.loadError) {
    return envelope({ type: "error", code: vm.loadError.code, message: vm.loadError.message, blocking: true });
  }
  return envelope({ type: "load", entity: vm.entity, concurrency: { kind: "none" } });
}

const chips = [
  { bin: "claude", label: "Claude Code", detected: true },
  { bin: "codex", label: "OpenAI Codex", detected: true },
  { bin: "agy", label: "Antigravity CLI", detected: false, installHint: "curl -fsSL https://antigravity.google/cli/install.sh | bash" },
  { bin: "gemini", label: "Gemini CLI (legacy)", detected: false, installHint: "npm install -g @google/gemini-cli" },
];

const flagMap = { claude: ["--dangerously-skip-permissions", "--model sonnet", "--model haiku", "--permission-mode plan", "--continue"] };
const evolutionLabels = createAgentEvolutionLabels();
const profileLabels = createAgentProfileLabels();

const newEntity: AgentStudioEntity = {
  fields: blankAgentFields(),
  chips,
  flagMap,
  defaultCwd: "/home/dev/project",
  verifyCandidates: ["npm test", "npm run lint"],
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
    soul: true,
    role: "reviewer",
    instructions: "you are a code reviewer; read the diff and flag correctness issues before style ones.",
    autostart: true,
    attention: true,
    worktree: true,
    branch: "feature/auth-redesign",
    worktreeSetup: 'pnpm install\ncp "$TACHYON_WORKSPACE_ROOT/.env.local" .env.local',
    verify: "npm test",
    harness: true,
    harnessMcp: "tavily:\n  command: npx\n  args: [\"-y\", \"tavily-mcp\"]",
  },
  chips,
  flagMap,
  defaultCwd: "/home/dev/project",
  verifyCandidates: ["npm test", "npm run lint"],
  persistentInstructionsHelp: "When supported, delivered at startup through the selected runtime.",
  evolutionLabels,
  profileLabels,
};

const canonicalSnapshot: AgentProfileStudioSnapshotV1 = {
  schemaVersion: 1,
  kind: "canonical",
  agentName: "reviewer",
  agentId: "123e4567-e89b-42d3-a456-426614174000",
  revision: "a".repeat(64),
  enabled: false,
  editable: {
    displayName: "Repository reviewer", runtime: { adapter: "codex", executable: "codex", model: "gpt-5.6" }, role: "reviewer",
    cwd: "apps/reviewer", lifecycle: { autostart: true, restart: "on-crash", attention: true, watch: ["src/**"] },
    worktree: { enabled: true, branch: "feature/reviewer" }, isolation: "transcript",
    capabilities: { skills: ["review-checklist"], mcp: ["docs-search"], hooks: [] },
  },
  bindings: {
    environmentValueNames: ["NODE_ENV"], secretNames: ["GITHUB_TOKEN"],
    prompt: { soul: true, instructions: true, evolution: true, memoryPolicy: "human-approved" },
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

export const agentStudioShellFixtures: Record<string, Fixture<AgentStudioShellFixtureVM>> = {
  new: { provenance: "synthetic-edge", vm: { entity: newEntity } },
  "dense-edit": { provenance: "synthetic-edge", vm: { entity: denseEntity } },
  "canonical-disabled": { provenance: "synthetic-edge", vm: { entity: canonicalEntity } },
  "load-error": { provenance: "synthetic-edge", vm: { entity: newEntity, loadError: { code: "persistence/not-found", message: "This agent no longer exists." } } },
};

export type { AgentStudioShellFixtureVM };
export type AgentStudioShellRoute = Route<AgentStudioShellFixtureVM>;
