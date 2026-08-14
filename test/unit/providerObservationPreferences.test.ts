import { describe, expect, it } from "vitest";
import {
  PROVIDER_OBSERVATION_PREFERENCES_STATE_KEY,
  ProviderObservationPreferences,
  type ProviderObservationPreferenceInputV1,
  type ProviderObservationStatePort,
} from "@tachyon/engine/runtimeObservability/preferences.js";

class MemoryState implements ProviderObservationStatePort {
  readonly values = new Map<string, unknown>();
  readonly writes: unknown[] = [];

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): void {
    this.values.set(key, structuredClone(value));
    this.writes.push(structuredClone(value));
  }
}

describe("ProviderObservationPreferences", () => {
  it("is disabled by default and ignores malformed or ambient-looking persisted state", () => {
    const state = new MemoryState();
    state.values.set(PROVIDER_OBSERVATION_PREFERENCES_STATE_KEY, {
      schemaVersion: 1,
      providers: {
        codex: { accountScopeKey: "person@example.invalid", sources: ["cli"] },
        claude: { accountScopeKey: "ps_0000000000000001", sources: ["cookie"] },
      },
    });
    const preferences = new ProviderObservationPreferences(state);

    expect(preferences.all()).toEqual({});
    expect(preferences.get("codex")).toBeUndefined();
    expect(preferences.get("claude")).toBeUndefined();
  });

  it("persists only an explicit ordered grant and a Tachyon-owned opaque scope", async () => {
    const state = new MemoryState();
    const preferences = new ProviderObservationPreferences(state, () => "1".repeat(32));

    const granted = await preferences.configure("claude", {
      state: "granted",
      consent: "explicit-user",
      sources: ["cli", "oauth"],
    });

    expect(granted).toEqual({
      scope: { kind: "provider-account", provider: "claude", key: `ps_${"1".repeat(32)}` },
      sources: ["cli", "oauth"],
    });
    expect(state.writes).toEqual([{
      schemaVersion: 1,
      providers: {
        claude: { accountScopeKey: `ps_${"1".repeat(32)}`, sources: ["cli", "oauth"] },
      },
    }]);
  });

  it("canonicalizes the cheapest native source first and rotates scope only when the authorized set changes", async () => {
    const state = new MemoryState();
    const keys = ["1".repeat(32), "2".repeat(32)];
    const preferences = new ProviderObservationPreferences(state, () => keys.shift() ?? "3".repeat(32));
    const input = { state: "granted", consent: "explicit-user", sources: ["cli", "oauth"] } as const;

    const first = await preferences.configure("codex", input);
    const same = await preferences.configure("codex", input);
    const reordered = await preferences.configure("codex", {
      state: "granted",
      consent: "explicit-user",
      sources: ["oauth", "cli"],
    });
    const reduced = await preferences.configure("codex", {
      state: "granted",
      consent: "explicit-user",
      sources: ["cli"],
    });

    expect(same?.scope.key).toBe(first?.scope.key);
    expect(reordered?.scope.key).toBe(first?.scope.key);
    expect(reordered?.sources).toEqual(["cli", "oauth"]);
    expect(reduced?.scope.key).toBe(`ps_${"2".repeat(32)}`);
    expect(reduced?.sources).toEqual(["cli"]);
  });

  it("disables a provider without touching another provider's explicit selection", async () => {
    const state = new MemoryState();
    let n = 0;
    const preferences = new ProviderObservationPreferences(state, () => `${++n}`.repeat(32));
    await preferences.configure("codex", { state: "granted", consent: "explicit-user", sources: ["cli"] });
    await preferences.configure("claude", { state: "granted", consent: "explicit-user", sources: ["cli"] });

    await preferences.configure("claude", { state: "disabled" });

    expect(preferences.get("claude")).toBeUndefined();
    expect(preferences.get("codex")?.sources).toEqual(["cli"]);
  });

  it("serializes concurrent provider updates so one grant cannot overwrite another", async () => {
    const state = new MemoryState();
    const pending: Array<() => void> = [];
    state.update = (key: string, value: unknown) => new Promise<void>((resolve) => {
      pending.push(() => {
        state.values.set(key, structuredClone(value));
        state.writes.push(structuredClone(value));
        resolve();
      });
    });
    let n = 0;
    const preferences = new ProviderObservationPreferences(state, () => `${++n}`.repeat(32));

    const codex = preferences.configure("codex", {
      state: "granted",
      consent: "explicit-user",
      sources: ["cli"],
    });
    const claude = preferences.configure("claude", {
      state: "granted",
      consent: "explicit-user",
      sources: ["cli"],
    });
    await Promise.resolve();
    expect(pending).toHaveLength(1);
    pending.shift()?.();
    await codex;
    await Promise.resolve();
    expect(pending).toHaveLength(1);
    pending.shift()?.();
    await claude;

    expect(preferences.all()).toMatchObject({
      codex: { sources: ["cli"] },
      claude: { sources: ["cli"] },
    });
  });

  it.each([
    { state: "inferred", consent: "explicit-user", sources: ["cli"] },
    { state: "granted", consent: "implicit", sources: ["cli"] },
    { state: "granted", consent: "explicit-user", sources: [] },
    { state: "granted", consent: "explicit-user", sources: ["cli", "cli"] },
    { state: "granted", consent: "explicit-user", sources: ["cookie"] },
  ])("rejects forged or unsafe grant %# without persisting", async (input) => {
    const state = new MemoryState();
    const preferences = new ProviderObservationPreferences(state, () => "1".repeat(32));

    await expect(preferences.configure(
      "claude",
      input as unknown as ProviderObservationPreferenceInputV1,
    )).rejects.toThrow();
    expect(state.writes).toEqual([]);
  });

  it("rejects unsafe scope generation before writing state", async () => {
    const state = new MemoryState();
    const preferences = new ProviderObservationPreferences(state, () => "not-hex");

    await expect(preferences.configure("codex", {
      state: "granted",
      consent: "explicit-user",
      sources: ["cli"],
    })).rejects.toThrow(/unsafe key/u);
    expect(state.writes).toEqual([]);
  });
});
