export const READY = "ready" as const;
export type DesignModeEvent = Record<string, unknown> & { type: string };
export type DesignModeWebviewMessage =
  | { type: typeof READY }
  | { type: "designMode.pickMode"; on: boolean }
  | { type: "designMode.agent"; agent: string }
  | { type: "designMode.loadBefore"; before: number }
  | { type: "designMode.send"; text: string }
  | { type: "designMode.clearSelection" }
  | { type: "designMode.openTerminal" };
export const designModeEvent = (event: Record<string, unknown>) => ({ type: "designMode.event" as const, event: event as DesignModeEvent });
