export const READY = "ready" as const;
export const MODEL = "onboardingModel" as const;
export const ERROR = "onboardingError" as const;

/**
 * t-505f13 — the onboarding model. Machine facts (environment checklist) plus window facts (open
 * folders, which have a config, which are attached). No fleet projection: before the first
 * workspace exists there is nothing to project, and after it exists the sidebar is the fleet's
 * home — this screen's third step hands over to it and to Agent Studio.
 */
export interface OnboardingFolder {
  name: string;
  root: string;
  /** a tachyon.yml exists at the root. */
  configured: boolean;
  /** the folder is attached (a Tachyon workspace booted for it). */
  attached: boolean;
}

export interface OnboardingModel {
  folders: OnboardingFolder[];
  environment: {
    items: Array<{ id: string; label: string; status: string; detail: string; remedy?: string }>;
    ready: boolean;
    /** ISO timestamp of the last probe run — the screen shows it, so a stale check is visible. */
    checkedAt: string;
  };
  /** Count of agent entries in the first attached workspace, when one exists. */
  agentCount?: number;
}

export type OnboardingAction =
  | { type: typeof READY }
  | { type: "recheck" }
  | { type: "initialize" }
  | { type: "openConfig" }
  | { type: "openAgentStudio" }
  | { type: "openKeys" }
  /** t-505f13 round 4 — the finished screen's EXIT. Always the user's click, never automatic. */
  | { type: "close" };

export const readyMessage = () => ({ type: READY } as const);
export const modelMessage = (model: OnboardingModel) => ({ type: MODEL, model } as const);
export const errorMessage = (message: string) => ({ type: ERROR, message } as const);

export function isOnboardingModel(value: unknown): value is OnboardingModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Record<string, unknown>;
  if (!Array.isArray(model.folders) || !model.folders.every((f) =>
    f && typeof f === "object"
    && typeof (f as OnboardingFolder).name === "string"
    && typeof (f as OnboardingFolder).root === "string"
    && typeof (f as OnboardingFolder).configured === "boolean"
    && typeof (f as OnboardingFolder).attached === "boolean")) return false;
  const env = model.environment as Record<string, unknown> | undefined;
  if (!env || typeof env !== "object" || typeof env.ready !== "boolean" || typeof env.checkedAt !== "string" || !Array.isArray(env.items)) return false;
  if (!env.items.every((item) =>
    item && typeof item === "object"
    && typeof (item as { id?: unknown }).id === "string"
    && typeof (item as { label?: unknown }).label === "string"
    && typeof (item as { status?: unknown }).status === "string"
    && typeof (item as { detail?: unknown }).detail === "string")) return false;
  if (model.agentCount !== undefined && typeof model.agentCount !== "number") return false;
  return true;
}
