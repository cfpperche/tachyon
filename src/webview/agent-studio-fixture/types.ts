/**
 * spec 350 T5 — Fake 2 (Agent-entity fixture): the Agent tab's real field shapes (quick-add CLI detection
 * chips, role template, instructions, worktree section) as a SINGLE-DOCUMENT studio proving the densest real
 * form maps into shell regions. Test + preview route ONLY — no command, no persistence, no lifecycle proof
 * (T4 already proved the lifecycle against Fake 1); this fixture exists to prove REGION composition.
 */

export interface AgentFixtureChip {
  cli: string;
  installed: boolean;
}

export interface AgentFixtureWorktree {
  enabled: boolean;
  branch: string;
  setupCommands: string;
}

export interface AgentFixtureFields {
  name: string;
  command: string;
  role: string | null;
  instructions: string;
  worktree: AgentFixtureWorktree;
}

export interface AgentFixtureVM {
  mode: "new" | "edit";
  entityId?: string;
  chips: AgentFixtureChip[];
  roleOptions: string[];
  fields: AgentFixtureFields;
}

export type AgentFixtureHostMessage = { type: "load"; entity: AgentFixtureVM; concurrency: { kind: "none" }; studioProtocolVersion: number };

export type AgentFixtureWebviewMessage =
  | { type: "ready"; studioProtocolVersion: number }
  | { type: "save"; studioProtocolVersion: number }
  | { type: "cancel"; studioProtocolVersion: number };
