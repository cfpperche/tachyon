import { FilesystemBackupAdapter, type StateBackupAdapter } from "./adapter.js";
import { runBackup, type BackupStats } from "./backup.js";

/**
 * t-5786bc — the opt-in periodic backup runner.
 *
 * Reads settings LIVE through the getter (the Workspace's `this.config` refreshes on tachyon.yml
 * edits), so declaring or removing `settings.stateBackup` takes effect within one poll — no engine
 * restart. Poll-based on purpose: no watchers on the stores, nothing on their write path; a backup
 * pass only ever READS the durable set. Failures warn and the next tick retries — a backup service
 * that can crash the engine would be worse than no backup.
 */

export interface StateBackupSettings {
  backend: "filesystem";
  path: string;
  /** interval like '10m' / '1h' (parseEvery format); default 10m. */
  every?: string;
  /** generations to keep at the destination; default 30. */
  keep?: number;
}

const POLL_MS = 60_000;
const DEFAULT_EVERY_MS = 10 * 60_000;

export class StateBackupService {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private lastRunAt = 0;
  private lastWarning = "";
  /** last completed pass, for status surfaces. */
  lastResult: BackupStats | undefined;

  constructor(
    private readonly workspaceRoot: string,
    private readonly getSettings: () => StateBackupSettings | undefined,
    private readonly everyMsOf: (every: string | undefined) => number | null,
    private readonly pollMs: number = POLL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    const settings = this.getSettings();
    if (!settings || this.running) return;
    const everyMs = this.everyMsOf(settings.every) ?? DEFAULT_EVERY_MS;
    if (Date.now() - this.lastRunAt < everyMs) return;
    this.running = true;
    try {
      const adapter = this.adapterFor(settings);
      this.lastResult = await runBackup(this.workspaceRoot, adapter, { keepGenerations: settings.keep });
      this.lastRunAt = Date.now();
      this.lastWarning = "";
    } catch (error) {
      // Warn once per distinct failure; a dead NAS should not print every minute.
      const message = error instanceof Error ? error.message : String(error);
      if (message !== this.lastWarning) {
        this.lastWarning = message;
        console.warn(`[tachyon] state backup failed (will keep retrying): ${message}`);
      }
      this.lastRunAt = Date.now();
    } finally {
      this.running = false;
    }
  }

  private adapterFor(settings: StateBackupSettings): StateBackupAdapter {
    // v1 ships filesystem; s3-compatible and gdrive join here (loadConfig validates the name).
    return new FilesystemBackupAdapter(settings.path);
  }
}
