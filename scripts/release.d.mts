export interface ReleaseOptions {
  args?: string[];
  run?: (command: string, args: string[]) => void;
}

export function runRelease(options?: ReleaseOptions): void;
