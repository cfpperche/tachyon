import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { HostActionLifecycleState } from "./types.js";

export interface ReloadReattachBundle {
  readonly host_instance_id: string;
  readonly workspace_id: string;
  readonly extension_build_id: string;
  readonly session_epoch: number;
  readonly reattach_nonce: string;
}

export interface PendingReloadTransaction {
  readonly action_id: string;
  readonly command: string;
  readonly created_at: string;
  readonly deadline_at: string;
  readonly bundle: ReloadReattachBundle;
}

export interface ReloadRecoveryResult {
  readonly actionId: string;
  readonly state: HostActionLifecycleState;
  readonly reason?: string;
}

export class ReloadTransactionStore {
  constructor(private readonly filePath: string) {}

  async begin(input: {
    readonly actionId: string;
    readonly command: string;
    readonly bundle: Omit<ReloadReattachBundle, "reattach_nonce">;
    readonly deadlineMs: number;
    readonly now?: number;
  }): Promise<PendingReloadTransaction> {
    const now = input.now ?? Date.now();
    const pending: PendingReloadTransaction = {
      action_id: input.actionId,
      command: input.command,
      created_at: new Date(now).toISOString(),
      deadline_at: new Date(now + input.deadlineMs).toISOString(),
      bundle: {
        ...input.bundle,
        reattach_nonce: crypto.randomBytes(16).toString("hex"),
      },
    };
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(pending, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    return pending;
  }

  async readPending(): Promise<PendingReloadTransaction | undefined> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as PendingReloadTransaction;
    } catch {
      return undefined;
    }
  }

  async recover(input: {
    readonly current: Omit<ReloadReattachBundle, "reattach_nonce">;
    readonly healthOk: boolean;
    readonly now?: number;
  }): Promise<ReloadRecoveryResult | undefined> {
    const pending = await this.readPending();
    if (!pending) return undefined;

    const now = input.now ?? Date.now();
    let state: HostActionLifecycleState = "reattached_verified";
    let reason: string | undefined;
    if (Date.parse(pending.deadline_at) < now) {
      state = "failed_to_return";
      reason = "reload transaction deadline elapsed before recovery";
    } else if (
      pending.bundle.host_instance_id !== input.current.host_instance_id ||
      pending.bundle.workspace_id !== input.current.workspace_id ||
      pending.bundle.extension_build_id !== input.current.extension_build_id
    ) {
      state = "returned_wrong_host";
      reason = "reattach bundle did not match the current host";
    } else if (input.current.session_epoch <= pending.bundle.session_epoch || !input.healthOk) {
      state = "result_unknown";
      reason = input.healthOk ? "session epoch did not advance after reload" : "post-reload health check failed";
    }

    await rm(this.filePath, { force: true });
    return { actionId: pending.action_id, state, reason };
  }
}
