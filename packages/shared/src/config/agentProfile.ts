export interface AgentProfileV1 {
  schemaVersion: 1;
  agentId: string;
  runtime: {
    adapter: string;
    executable: string;
    model?: string;
    provider?: string;
    reasoningEffort?: string;
    serviceTier?: string;
  };
  displayName?: string;
  environment?: {
    values?: Record<string, string>;
    secrets?: Record<string, { provider: string; id: string; purpose: string }>;
  };
  prompt?: {
    instructions?: string;
    memory?: { policy: "disabled" | "runtime-managed" | "human-approved"; reference?: string };
  };
  lifecycle?: {
    enabled?: boolean;
    autostart?: boolean;
    watch?: string[];
    attention?: { enabled?: boolean; silenceSec?: number; patterns?: string[] };
    restart?: "never" | "on-crash";
  };
  workspace?: {
    cwd?: string;
    worktree?: { enabled?: boolean; base?: string; branch?: string; setup?: string[] };
  };
  isolation?: "transcript";
  ownership?: { subagents: string[] };
  capabilities?: {
    skills?: string[];
    mcp?: string[];
    hooks?: string[];
    pi?: { extensions?: string[]; prompts?: string[]; themes?: string[]; packages?: string[] };
  };
  grants?: { proposeSavedAgent?: boolean };
  nativeConfig?: Partial<Record<
    "memory" | "selectors" | "permissions" | "interface" | "tooling" | "featureFlags" | "authentication" | "diagnostics",
    {
      lifecycle: Array<"restart" | "fresh" | "resume" | "fork">;
      source: "workspace" | "global" | "agent";
      treatment: "exclude" | "snapshot" | "overlay" | "external";
      refresh: "create-once" | "every-launch" | "runtime-owned";
      authorize?: string[];
    }
  >>;
  guidance?: { project?: string[]; bridge?: string[] };
  inherit?: {
    environment?: string[];
    workspace?: Array<"worktree.base" | "worktree.branch" | "projectGuidance" | "bridgeGuidance">;
  };
  references?: Array<{
    path: string;
    id: string;
    kind: "instructions" | "memory" | "mcp" | "skill" | "hook" | "pi-extension" | "pi-prompt" | "pi-theme" | "pi-package" | "project-guidance" | "bridge-guidance" | "worktree-setup" | "runtime-adapter";
    scope: "project" | "profile" | "product";
    owner: string;
    mode: "pinned" | "floating";
    sha256?: string;
    version?: string;
  }>;
}
