import { randomUUID } from "node:crypto";

/**
 * Shell-owned presentation of tmux sessions.  The operational engine only asks for a session to be
 * presented; it never imports or constructs a VS Code terminal directly.
 */
export interface TerminalPresentation {
  open(agent: string, session: string, viewColumn?: number, title?: string): void;
  close(agent: string, session?: string): void;
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

export type TerminalUiRequest =
  | {
      schemaVersion: 1;
      operationId: string;
      kind: "terminal.present";
      agent: string;
      session: string;
      viewColumn?: number;
      title?: string;
    }
  | { schemaVersion: 1; operationId: string; kind: "terminal.close"; agent: string; session: string };

export type TerminalUiRequester = (request: TerminalUiRequest) => Promise<unknown>;

/**
 * Daemon-side terminal intent store. It owns no editor object: desired tabs are persisted in engine
 * state and presented through the same single-claim UI channel as every other shell-only operation.
 */
export class DaemonTerminalPresentation implements TerminalPresentation {
  private readonly entries = new Map<string, TerminalRestoreEntry>();
  private readonly liveSessions = new Set<string>();
  private readonly dispatchQueues = new Map<string, TerminalUiRequest[]>();
  private readonly activeDispatch = new Map<string, TerminalUiRequest>();
  private disposed = false;

  constructor(
    private readonly options: TerminalPresentationOptions,
    private readonly requestUi: TerminalUiRequester,
  ) {
    const stored = options.manifest?.read();
    if (Array.isArray(stored)) {
      for (const value of stored) {
        if (isTerminalRestoreEntry(value)) this.entries.set(value.agent, { ...value });
      }
    }
    this.persist();
  }

  open(agent: string, session: string, viewColumn?: number, title?: string): void {
    if (this.disposed) return;
    const entry: TerminalRestoreEntry = {
      schemaVersion: 1,
      agent,
      session,
      ...(viewColumn !== undefined ? { viewColumn } : {}),
      ...(title !== undefined ? { title } : {}),
    };
    if (!isTerminalRestoreEntry(entry)) return;
    const previous = this.entries.get(agent);
    if (previous) this.liveSessions.delete(previous.session);
    this.entries.set(agent, entry);
    this.liveSessions.add(session);
    this.persist();
    this.present(entry);
  }

  close(agent: string, session?: string): void {
    if (this.disposed) return;
    const current = this.entries.get(agent);
    if (!current || (session !== undefined && current.session !== session)) return;
    this.entries.delete(agent);
    this.liveSessions.delete(current.session);
    this.persist();
    this.dispatch("terminal-ui", {
      schemaVersion: 1,
      operationId: randomUUID(),
      kind: "terminal.close",
      agent,
      session: current.session,
    });
  }

  has(agent: string): boolean { return this.entries.has(agent); }
  isActive(): boolean { return false; }

  async restoreOpen(hasSession: (session: string) => Promise<boolean>): Promise<void> {
    for (const entry of this.entries.values()) {
      let live = false;
      try { live = await hasSession(entry.session); } catch { live = false; }
      if (live) this.liveSessions.add(entry.session);
    }
    this.persist();
  }

  /** Replays durable presentation intents when a new shell attaches after reload or a no-shell interval. */
  replay(): void {
    if (this.disposed) return;
    for (const entry of this.entries.values()) {
      if (this.liveSessions.has(entry.session)) this.present(entry);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.dispatchQueues.clear();
    this.activeDispatch.clear();
    this.liveSessions.clear();
  }

  private present(entry: TerminalRestoreEntry): void {
    this.dispatch("terminal-ui", {
      schemaVersion: 1,
      operationId: randomUUID(),
      kind: "terminal.present",
      agent: entry.agent,
      session: entry.session,
      ...(entry.viewColumn !== undefined ? { viewColumn: entry.viewColumn } : {}),
      ...(entry.title !== undefined ? { title: entry.title } : {}),
    });
  }

  private dispatch(key: string, request: TerminalUiRequest): void {
    if (this.disposed) return;
    const queue = this.dispatchQueues.get(key) ?? [];
    const previous = queue.at(-1) ?? this.activeDispatch.get(key);
    if (previous && sameTerminalUiIntent(previous, request)) return;
    queue.push(request);
    this.dispatchQueues.set(key, queue);
    this.pumpDispatch(key);
  }

  private pumpDispatch(key: string): void {
    if (this.disposed || this.activeDispatch.has(key)) return;
    const queue = this.dispatchQueues.get(key);
    const request = queue?.shift();
    if (!request) {
      this.dispatchQueues.delete(key);
      return;
    }
    this.activeDispatch.set(key, request);
    void this.requestUi(request).catch(() => undefined).finally(() => {
      this.activeDispatch.delete(key);
      this.pumpDispatch(key);
    });
  }

  private persist(): void {
    this.options.manifest?.write([...this.entries.values()].map((entry) => ({ ...entry })));
  }
}

function sameTerminalUiIntent(left: TerminalUiRequest, right: TerminalUiRequest): boolean {
  if (left.kind !== right.kind || left.agent !== right.agent || left.session !== right.session) return false;
  if (left.kind === "terminal.close" || right.kind === "terminal.close") return true;
  return left.viewColumn === right.viewColumn && left.title === right.title;
}

export function isTerminalRestoreEntry(value: unknown): value is TerminalRestoreEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const allowed = ["schemaVersion", "agent", "session", "viewColumn", "title"];
  if (Object.keys(record).some((key) => !allowed.includes(key))
    || record.schemaVersion !== 1
    || typeof record.agent !== "string" || record.agent.length < 1 || record.agent.length > 128
    || typeof record.session !== "string" || record.session.length < 1 || record.session.length > 256
    || (record.viewColumn !== undefined && (!Number.isSafeInteger(record.viewColumn) || (record.viewColumn as number) < -100 || (record.viewColumn as number) > 100))
    || (record.title !== undefined && (typeof record.title !== "string" || record.title.length < 1 || record.title.length > 256))) {
    return false;
  }
  return true;
}
