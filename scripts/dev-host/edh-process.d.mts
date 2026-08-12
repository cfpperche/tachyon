export interface ProcessRow {
  pid: number;
  argv: string[];
  rawCmdline?: string;
}

export interface PickEdhPidOptions {
  port: number;
  electronBin?: string;
}

export interface ResolveEdhPidOptions {
  port: number;
  codeBin?: string;
  timeoutMs?: number;
  intervalMs?: number;
  procRoot?: string;
}

export function tokenizeCmdline(raw: string): string[];
export function readProcessTable(procRoot?: string): ProcessRow[];
export function pickEdhPid(procs: ProcessRow[], options: PickEdhPidOptions): number | undefined;
export function electronBinaryFor(codeBin?: string): string | undefined;
export function resolveEdhPid(options: ResolveEdhPidOptions): Promise<number | undefined>;
export function pidAlive(pid?: number): boolean;
