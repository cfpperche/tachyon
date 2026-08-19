export const READY = "ready" as const;
export const MODEL = "keysModel" as const;
export const ERROR = "keysError" as const;

export interface StoredKey { provider: string; id: string; usedBy: string[] }
export interface RequiredKey { agent: string; name: string; provider: string; id: string; purpose: string }
export interface KeysModel { stored: StoredKey[]; missing: RequiredKey[] }

export type KeysAction =
  | { type: typeof READY }
  | { type: "storeKey"; provider: string; id: string; value: string }
  | { type: "replaceKey"; provider: string; id: string; value: string }
  | { type: "removeKey"; provider: string; id: string };

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
    return Object.keys(key).sort().join("\0") === "id\0provider\0usedBy"
      && typeof key.provider === "string" && typeof key.id === "string"
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
