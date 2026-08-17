/**
 * SDD 512 fatia 1 — the current action-less product notice as last-write-wins state.
 *
 * This is not the Human Inbox (`notices[]`). It is the single message that used to
 * go to `setStatusBarMessage` and was erased on an 8s timer. There is no timer here:
 * the last notice stays until `set` replaces it or `dismiss` clears it.
 *
 * `level` is a required field. Do not infer it from `message` text or from an icon.
 */
export type StatusNoticeLevel = "info" | "warn" | "error";

export interface StatusNotice {
  message: string;
  level: StatusNoticeLevel;
  /** When this notice was set. A timestamp, not an expiry. */
  at: string;
}

export interface StatusNoticeSetInputV1 {
  message: string;
  level: StatusNoticeLevel;
}

export function isStatusNoticeSetInputV1(value: unknown): value is StatusNoticeSetInputV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return Object.keys(input).length === 2
    && typeof input.message === "string"
    && input.message.trim().length > 0
    && input.message.length <= 10_000
    && (input.level === "info" || input.level === "warn" || input.level === "error");
}

export class StatusNoticeStore {
  #current: StatusNotice | undefined;

  set(
    input: { message: string; level: StatusNoticeLevel },
    now: () => Date = () => new Date(),
  ): StatusNotice | undefined {
    const message = input.message.trim();
    if (!message) return this.#current;
    this.#current = { message, level: input.level, at: now().toISOString() };
    return this.#current;
  }

  dismiss(): void {
    this.#current = undefined;
  }

  get(): StatusNotice | undefined {
    return this.#current;
  }
}
