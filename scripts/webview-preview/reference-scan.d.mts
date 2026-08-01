export const CALLER_ROOTS: string[];

export function blankComments(src: string): string;

export function callerFiles(roots?: string[]): string[];

export function declaredWebviewBundles(esbuildSource?: string): Set<string>;

export function scanFile(
  file: string,
  source?: string,
): {
  views: Array<{ token: string; view: string; file: string; line: number }>;
  bundles: Array<{ token: string; bundle: string; file: string; line: number }>;
  waivers: Array<{ token: string; task: string; file: string; line: number }>;
};

export function scanPreviewReferences(options?: {
  routeKeys?: Set<string>;
  bundles?: Set<string>;
  files?: string[];
}): {
  dead: string[];
  stale: string[];
  knownViews: string[];
  knownBundles: string[];
};
