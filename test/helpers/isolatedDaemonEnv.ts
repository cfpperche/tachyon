/**
 * t-70fda0 / t-93ec7f — child env for real engine/daemon fixtures.
 *
 * A test that spawns a real Tachyon daemon inherits the host process environment by Node default.
 * In a live Tachyon pane that means a valid TACHYON_AGENT_BRIDGE_TOKEN (and the rest of the fleet
 * identity surface) reaches a fixture that was only meant to hold a private workspace and tmux
 * socket. Strip every TACHYON_* key, then reintroduce only what the fixture itself needs.
 *
 * Callers must pass the result as `env:` on spawn — omitting env reopens the inheritance door.
 */
export const FLEET_TACHYON_KEYS = [
  "TACHYON_AGENT_BRIDGE_TOKEN",
  "TACHYON_AGENT_NAME",
  "TACHYON_BRIDGE_TOKEN",
  "TACHYON_BRIDGE_URL",
  "TACHYON_ENGINE_SERVICE",
  "TACHYON_INSTANCE_CUT",
] as const;

export function isolatedDaemonChildEnv(
  base: NodeJS.ProcessEnv = process.env,
  reintroduce: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith("TACHYON_")) delete childEnv[key];
  }
  Object.assign(childEnv, reintroduce);
  return childEnv;
}

/** Assert the named fleet surface is absent. Prefer this over a silent strip that no test saw fail. */
export function assertNoFleetLeak(childEnv: NodeJS.ProcessEnv): void {
  for (const key of FLEET_TACHYON_KEYS) {
    if (childEnv[key] !== undefined) {
      throw new Error(`${key} leaked from the live fleet into the daemon fixture`);
    }
  }
}
