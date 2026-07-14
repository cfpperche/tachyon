/**
 * Shell-owned presentation of tmux sessions.  The operational engine only asks for a session to be
 * presented; it never imports or constructs a VS Code terminal directly.
 */
export interface TerminalPresentation {
  open(agent: string, session: string, viewColumn?: number, title?: string): void;
  close(agent: string): void;
  has(agent: string): boolean;
  isActive(agent: string): boolean;
  restoreOpen(hasSession: (session: string) => Promise<boolean>): Promise<void>;
  dispose(): void;
}

export interface TerminalManifestStore {
  read(): unknown;
  write(entries: TerminalRestoreEntry[]): void;
}

export interface TerminalRestoreEntry {
  schemaVersion: 1;
  agent: string;
  session: string;
  viewColumn?: number;
  title?: string;
}

export interface TerminalPresentationOptions {
  onReveal?: (agent: string, session: string) => void;
  kindOf?: (agent: string) => "agent" | "terminal";
  manifest?: TerminalManifestStore;
}

/**
 * Daemon default.  Terminal tabs are a shell concern, so a headless engine neither restores nor
 * pretends to own them.  A connected shell will reconstruct presentation from engine projections.
 */
export class HeadlessTerminalPresentation implements TerminalPresentation {
  open(): void {}
  close(): void {}
  has(): boolean { return false; }
  isActive(): boolean { return false; }
  async restoreOpen(): Promise<void> {}
  dispose(): void {}
}
