import fs from "node:fs";
import type { WorkspaceClient } from "./WorkspaceClient.js";

export type ConnectWorkspaceClient = (canonicalWorkspaceRoot: string) => Promise<WorkspaceClient>;

export interface WorkspaceClientRegistryOptions {
  connect: ConnectWorkspaceClient;
  canonicalize?: (workspaceRoot: string) => string;
}

interface WorkspaceClientSlot {
  root: string;
  detached: boolean;
  pending?: Promise<WorkspaceClient>;
  client?: WorkspaceClient;
}

export class WorkspaceClientRegistryError extends Error {
  constructor(readonly code: "REGISTRY_CLOSED" | "ATTACH_CANCELLED" | "IDENTITY_MISMATCH" | "HASH_COLLISION", message: string) {
    super(message);
    this.name = "WorkspaceClientRegistryError";
  }
}

/**
 * Shell-owned multi-root registry.  It converges concurrent attaches and owns only ephemeral client
 * leases: detach/close never has access to an engine stop or restart operation.
 */
export class WorkspaceClientRegistry {
  private readonly slots = new Map<string, WorkspaceClientSlot>();
  private readonly aliases = new Map<string, string>();
  private readonly connectClient: ConnectWorkspaceClient;
  private readonly canonicalize: (workspaceRoot: string) => string;
  private closed = false;

  constructor(options: WorkspaceClientRegistryOptions) {
    this.connectClient = options.connect;
    this.canonicalize = options.canonicalize ?? ((workspaceRoot) => fs.realpathSync(workspaceRoot));
  }

  attach(workspaceRoot: string): Promise<WorkspaceClient> {
    if (this.closed) return Promise.reject(new WorkspaceClientRegistryError("REGISTRY_CLOSED", "workspace client registry is closed"));
    const root = this.canonicalize(workspaceRoot);
    this.aliases.set(workspaceRoot, root);
    const existing = this.slots.get(root);
    if (existing?.client) return Promise.resolve(existing.client);
    if (existing?.pending) return existing.pending;

    const slot: WorkspaceClientSlot = { root, detached: false };
    const pending = Promise.resolve().then(async () => {
      const client = await this.connectClient(root);
      if (client.workspaceRoot !== root) {
        await client.close().catch(() => undefined);
        throw new WorkspaceClientRegistryError(
          "IDENTITY_MISMATCH",
          "attached workspace client does not match its canonical registry root",
        );
      }
      if (this.closed || slot.detached || this.slots.get(root) !== slot) {
        await client.close().catch(() => undefined);
        throw new WorkspaceClientRegistryError("ATTACH_CANCELLED", "workspace attach was cancelled by shell detach");
      }
      slot.client = client;
      return client;
    }).finally(() => {
      slot.pending = undefined;
      if (!slot.client && this.slots.get(root) === slot) {
        this.slots.delete(root);
        this.removeAliases(root);
      }
    });
    slot.pending = pending;
    this.slots.set(root, slot);
    return pending;
  }

  get(workspaceRoot: string): WorkspaceClient | undefined {
    const root = this.lookupRoot(workspaceRoot);
    return root === undefined ? undefined : this.slots.get(root)?.client;
  }

  findByHash(workspaceHash: string): WorkspaceClient | undefined {
    const matches = this.list().filter((client) => client.workspaceHash === workspaceHash);
    if (matches.length > 1) {
      throw new WorkspaceClientRegistryError(
        "HASH_COLLISION",
        `workspace hash '${workspaceHash}' matches multiple canonical roots`,
      );
    }
    return matches[0];
  }

  list(): WorkspaceClient[] {
    return [...this.slots.values()]
      .flatMap((slot) => slot.client ? [slot.client] : [])
      .sort((left, right) => left.workspaceRoot.localeCompare(right.workspaceRoot));
  }

  async detach(workspaceRoot: string): Promise<void> {
    const root = this.lookupRoot(workspaceRoot);
    if (root === undefined) return;
    const slot = this.slots.get(root);
    if (!slot) return;
    this.slots.delete(root);
    this.removeAliases(root);
    slot.detached = true;
    if (slot.pending) await slot.pending.catch(() => undefined);
    if (slot.client) await slot.client.close();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const slots = [...this.slots.values()];
    this.slots.clear();
    this.aliases.clear();
    for (const slot of slots) slot.detached = true;
    const clients = new Set<WorkspaceClient>();
    for (const slot of slots) {
      if (slot.pending) await slot.pending.catch(() => undefined);
      if (slot.client) clients.add(slot.client);
    }
    const settled = await Promise.allSettled([...clients].map((client) => client.close()));
    const errors = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, "one or more workspace shell clients failed to detach");
  }

  private lookupRoot(workspaceRoot: string): string | undefined {
    const alias = this.aliases.get(workspaceRoot);
    if (alias !== undefined) return alias;
    if (this.slots.has(workspaceRoot)) return workspaceRoot;
    try { return this.canonicalize(workspaceRoot); }
    catch { return undefined; }
  }

  private removeAliases(root: string): void {
    for (const [alias, target] of this.aliases) {
      if (target === root) this.aliases.delete(alias);
    }
  }
}
