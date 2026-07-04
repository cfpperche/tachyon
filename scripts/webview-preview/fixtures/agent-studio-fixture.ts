/**
 * spec 350 T5/T7 — Agent-entity fixture (Fake 2) preview fixtures: the densest real form (Agent Studio's
 * Agent tab) proving quick-add chips, a role select, instructions, and a worktree section all map into the
 * shell's declared regions (`fields` + `sideActions`).
 */

import type { AgentFixtureVM } from "../../../src/webview/agent-studio-fixture/types";
import { loadMessage } from "../../../src/webview/agent-studio-fixture/messages";
import type { Fixture } from "../routes";

const denseAgent: AgentFixtureVM = {
  mode: "edit",
  entityId: "reviewer",
  chips: [
    { cli: "claude", installed: true },
    { cli: "codex", installed: true },
    { cli: "agy", installed: false },
    { cli: "gemini", installed: false },
  ],
  roleOptions: ["coder", "reviewer", "tester", "orchestrator"],
  fields: {
    name: "reviewer",
    command: "claude",
    role: "reviewer",
    instructions: "you are a code reviewer; read the diff and flag correctness issues before style ones.",
    worktree: { enabled: true, branch: "feature/auth-redesign", setupCommands: 'pnpm install\ncp "$TACHYON_WORKSPACE_ROOT/.env.local" .env.local' },
  },
};

const newAgent: AgentFixtureVM = {
  mode: "new",
  chips: denseAgent.chips,
  roleOptions: denseAgent.roleOptions,
  fields: { name: "", command: "", role: null, instructions: "", worktree: { enabled: false, branch: "", setupCommands: "" } },
};

export const agentStudioFixtureFixtures: Record<string, Fixture<AgentFixtureVM>> = {
  default: { provenance: "synthetic-edge", vm: denseAgent },
  new: { provenance: "synthetic-edge", vm: newAgent },
};

export function agentStudioFixtureMakeMessage(vm: AgentFixtureVM) {
  return loadMessage(vm);
}
