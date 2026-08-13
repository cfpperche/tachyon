import path from "node:path";

/** Resolve a pick image through the owning webview without letting an event grant arbitrary disk files. */
export function designModeEventWithScreenshot(
  event: Record<string, unknown>,
  pickRoot: string,
  asWebviewUri: (file: string) => string,
): Record<string, unknown> {
  const screenshotPath = typeof event.screenshotPath === "string" ? event.screenshotPath : undefined;
  const resolved: Record<string, unknown> = screenshotPath
    && path.dirname(path.resolve(screenshotPath)) === path.resolve(pickRoot)
    ? { ...event, screenshotUri: asWebviewUri(screenshotPath) }
    : { ...event };
  delete resolved.screenshotPath;
  return resolved;
}
