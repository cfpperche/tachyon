export interface ReleaseOptions {
  args?: string[];
  run?: (command: string, args: string[]) => void;
  root?: string;
}

export function runRelease(options?: ReleaseOptions): void;
