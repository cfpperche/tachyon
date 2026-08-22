export const READY = "ready" as const;
export const MODEL = "keysModel" as const;
export const ERROR = "keysError" as const;

/**
 * t-3b8073 — why a stored key is declared by nobody. A machine key outlives the workspace it was
 * added for (it is machine-local by design), so "unused" has two very different causes and the
 * screen used to state neither: on 2026-08-21 a workspace was destroyed and re-cloned, three
 * provider keys correctly survived, and the screen reported "No profile declares this key" three
 * times with no way to tell whether that was a loss or just work not done yet.
 */
export type KeyOrphanReason =
  /** nothing in this workspace declares ANY key — its agents are gone, or it has none yet. */
  | "no-declarations"
  /** other keys are declared here; this one simply is not. */
  | "not-declared-here";

export interface StoredKey { provider: string; id: string; usedBy: string[]; orphan?: KeyOrphanReason }
export interface RequiredKey { agent: string; name: string; provider: string; id: string; purpose: string }
export interface KeysModel { stored: StoredKey[]; missing: RequiredKey[] }

export type KeysAction =
  | { type: typeof READY }
  | { type: "storeKey"; provider: string; id: string; value: string }
  | { type: "replaceKey"; provider: string; id: string; value: string }
  | { type: "removeKey"; provider: string; id: string }
  // t-3b8073 — the OTHER exit from an orphan: an agent that declares it. The screen used to offer
  // only removal, which reads as "this key is junk" for a credential that may be the whole reason
  // the workspace exists.
  | { type: "declareKey"; provider: string; id: string };

export const readyMessage = () => ({ type: READY } as const);
export const modelMessage = (model: KeysModel) => ({ type: MODEL, model } as const);
export const errorMessage = (message: string) => ({ type: ERROR, message } as const);

export function isKeysModel(value: unknown): value is KeysModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Record<string, unknown>;
  if (Object.keys(model).sort().join("\0") !== "missing\0stored") return false;
  const stored = Array.isArray(model.stored) && model.stored.every(item => {
    if (!item || typeof item !== "object") return false;
    const key = item as Record<string, unknown>;
    const shape = Object.keys(key).sort().join("\0");
    if (shape !== "id\0provider\0usedBy" && shape !== "id\0orphan\0provider\0usedBy") return false;
    if (key.orphan !== undefined && key.orphan !== "no-declarations" && key.orphan !== "not-declared-here") return false;
    return typeof key.provider === "string" && typeof key.id === "string"
      && Array.isArray(key.usedBy) && key.usedBy.every(agent => typeof agent === "string");
  });
  const missing = Array.isArray(model.missing) && model.missing.every(item => {
    if (!item || typeof item !== "object") return false;
    const key = item as Record<string, unknown>;
    return Object.keys(key).sort().join("\0") === "agent\0id\0name\0provider\0purpose"
      && Object.values(key).every(value => typeof value === "string");
  });
  return stored && missing;
}
