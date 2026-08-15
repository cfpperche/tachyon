import { randomBytes } from "node:crypto";
import { CallerIdentityRegistry, loadOrCreateHmacKey, type PersistableEntry, type SecretPort } from "./callerIdentity.js";
import { loadOrCreateExternalToken, loadOrCreateToken, TOKEN_ENV_VAR, URL_ENV_VAR, AGENT_TOKEN_ENV_VAR } from "./token.js";
import { callerIdentityInstanceIdStateKey, callerIdentityRegistryStateKey } from "@tachyon/engine/workspace/operationalStateKeys.js";

export interface WorkspaceBridgeTransportOptions {
  workspaceId: string;
  storagePath: string;
  authEnabled: boolean;
  legacyCompatEnabled: boolean;
  getState: <T>(key: string) => T | undefined;
  setState: (key: string, value: unknown) => void;
}

/** Transport-owned connection credentials and caller identity lifecycle for one workspace listener. */
export class WorkspaceBridgeTransport {
  readonly token: string | undefined;
  readonly externalToken: string | undefined;
  readonly instanceId: string;
  private registry: CallerIdentityRegistry | undefined;

  constructor(private readonly options: WorkspaceBridgeTransportOptions) {
    this.token = options.authEnabled ? loadOrCreateToken(options.storagePath, options.workspaceId) : undefined;
    this.externalToken = this.token
      ? loadOrCreateExternalToken(options.storagePath, options.workspaceId, this.token)
      : undefined;
    const key = callerIdentityInstanceIdStateKey(options.workspaceId);
    this.instanceId = options.getState<string>(key) ?? randomBytes(8).toString("hex");
    options.setState(key, this.instanceId);
  }

  get authEnabled(): boolean { return this.options.authEnabled; }
  get legacyCompatEnabled(): boolean { return this.options.legacyCompatEnabled; }
  get scope() { return { workspaceId: this.options.workspaceId, instanceId: this.instanceId }; }
  get callerRegistry(): CallerIdentityRegistry | undefined { return this.registry; }
  get knownSecrets(): string[] { return [this.token, this.externalToken].filter((s): s is string => !!s); }

  launchEnv(url: string | undefined): Record<string, string> {
    return {
      ...(url ? { [URL_ENV_VAR]: url } : {}),
      ...(this.token ? { [TOKEN_ENV_VAR]: this.token } : {}),
    };
  }

  async initializeIdentity(host: SecretPort): Promise<Buffer> {
    const persisted = this.options.getState<PersistableEntry[]>(callerIdentityRegistryStateKey(this.options.workspaceId)) ?? [];
    const key = await loadOrCreateHmacKey(host);
    this.registry = new CallerIdentityRegistry(key, persisted);
    return key;
  }

  mintCaller(name: string): string | undefined {
    if (!this.registry) return undefined;
    const token = this.registry.mint(name, this.scope);
    this.persistRegistry();
    return token;
  }

  mintAgentEnv(name: string): Record<string, string> {
    const token = this.mintCaller(name);
    return token ? { [AGENT_TOKEN_ENV_VAR]: token } : {};
  }

  revokeCaller(name: string): void {
    this.registry?.revoke(name, this.scope);
    this.persistRegistry();
  }

  persistRegistry(): void {
    if (!this.registry) return;
    this.registry.sweepOrphans();
    this.options.setState(callerIdentityRegistryStateKey(this.options.workspaceId), this.registry.toPersistable());
  }

}
