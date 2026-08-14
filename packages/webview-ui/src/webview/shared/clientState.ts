export interface TachyonVsCodeApi {
  postMessage(msg: unknown): void;
  setState?(state: unknown): void;
}

declare global {
  interface Window {
    __tachyonPersistedState?: unknown;
  }
}

export function persistWebviewState(vscode: TachyonVsCodeApi | undefined): void {
  const state = window.__tachyonPersistedState;
  if (state !== undefined) vscode?.setState?.(state);
}
