/** SDD 485 C2 — the chunk filename prefix shared by every app entry in the splitting invocation. */
export const WEBVIEW_CHUNK_PREFIX: string;

/** the ESM entries that root the reachability graph: every top-level `.js` under the webview dir. */
export function webviewEntryFiles(webviewDir: string): string[];

export function reachableWebviewChunkBasenames(
  webviewDir: string,
  entryFiles?: string[],
): Set<string>;

export function pruneUnreachableWebviewChunks(webviewDir: string): {
  kept: string[];
  pruned: string[];
};

export function assertWebviewChunksReachable(webviewDir: string): void;
