export interface EdhCodeResolution {
  path: string;
  source: "explicit" | "worktree-cache" | "shared-checkout-cache" | "path";
}

export interface ResolveEdhCodeOptions {
  repo: string;
  explicit?: string;
  commonRoot?: string;
  pathCandidate?: string;
}

export function isWslRemoteCli(candidate?: string): boolean;
export function latestCachedCode(root: string, archLabel?: string): string | undefined;
export function primaryCheckoutRoot(repo: string): string | undefined;
export function commandOnPath(command: string, pathValue?: string): string | undefined;
export function resolveEdhCode(options: ResolveEdhCodeOptions): EdhCodeResolution;
