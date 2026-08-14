export type AgentInstanceLifetime = "saved" | "temporary";
export type AgentInstanceResumePolicy = "restartable" | "collected";

export interface AgentInstancePolicy {
  lifetime: AgentInstanceLifetime;
  resumePolicy: AgentInstanceResumePolicy;
  lifecycleHooks?: boolean;
}
