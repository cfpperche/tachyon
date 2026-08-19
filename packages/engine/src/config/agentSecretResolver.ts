import type { AgentSecretEnvironment } from "./loadConfig.js";
import { secretStorageKey } from "./agentProfileProjection.js";

/** Resolve profile references at the launch boundary. The returned map is process-env data only. */
export async function resolveProfileSecretEnvironment(
  references: AgentSecretEnvironment,
  resolve: (key: string) => Promise<string | undefined>,
): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const [name, reference] of Object.entries(references)) {
    const value = await resolve(secretStorageKey(reference.provider, reference.id));
    if (value === undefined) throw new Error(`agent launch refused: missing secret '${name}' (${reference.provider}/${reference.id})`);
    values[name] = value;
  }
  return values;
}
