export function reachableWebviewChunkBasenames(
  webviewDir: string,
  entryFiles?: string[],
): Set<string>;

export function pruneUnreachableWebviewChunks(webviewDir: string): {
  kept: string[];
  pruned: string[];
};

export function assertWebviewChunksReachable(webviewDir: string): void;
