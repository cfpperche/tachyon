export interface StopFixtureBridgeOptions {
  timeoutMs?: number;
}

export interface StopFixtureBridgeResult {
  state: "absent" | "stopped";
}

export interface StopFixtureEngineOptions {
  timeoutMs?: number;
  pollMs?: number;
  runSystemctl?: (args: string[]) => Promise<{ status: number | null; stdout: string; stderr: string }> | { status: number | null; stdout: string; stderr: string };
}

export interface StopFixtureEngineResult {
  state: "absent" | "stopped";
  unitName?: string;
}

export interface ProbeFixtureEngineResult {
  state: "absent" | "active" | "inactive";
  unitName?: string;
}

export function fixtureEngineUnitName(fixtureRoot: string): string;

export function stopFixtureEngine(
  fixtureRoot: string,
  options?: StopFixtureEngineOptions,
): Promise<StopFixtureEngineResult>;

export function probeFixtureEngine(
  fixtureRoot: string,
  options?: StopFixtureEngineOptions,
): Promise<ProbeFixtureEngineResult>;

export function stopFixtureBridge(
  fixtureRoot: string,
  options?: StopFixtureBridgeOptions,
): Promise<StopFixtureBridgeResult>;
