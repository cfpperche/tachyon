export interface StopFixtureBridgeOptions {
  timeoutMs?: number;
}

export interface StopFixtureBridgeResult {
  state: "absent" | "stopped";
}

export function stopFixtureBridge(
  fixtureRoot: string,
  options?: StopFixtureBridgeOptions,
): Promise<StopFixtureBridgeResult>;
