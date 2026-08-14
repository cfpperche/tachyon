/**
 * Exact operational state names shared by the old VS Code host and the persistent engine.
 * Keeping them here makes the one-time migration an allowlist instead of a globalState dump.
 */
export const CALLER_IDENTITY_HMAC_SECRET_KEY = "tachyon.callerIdentity.hmacKey";

export function callerIdentityInstanceIdStateKey(workspaceHash: string): string {
  return `tachyon.callerIdentity.instanceId.${workspaceHash}`;
}

export function callerIdentityRegistryStateKey(workspaceHash: string): string {
  return `tachyon.callerIdentity.registry.${workspaceHash}`;
}

export function hostActionSessionEpochStateKey(workspaceHash: string): string {
  return `tachyon.hostAction.sessionEpoch.${workspaceHash}`;
}

export function authorityHeadsSecretKey(workspaceHash: string): string {
  return `tachyon.authorityHeads.v1.${workspaceHash}`;
}

export function agentProfileAuthoritiesSecretKey(workspaceHash: string): string {
  return `tachyon.agentProfileAuthorities.v1.${workspaceHash}`;
}

export function workspaceVersionStateKey(workspaceHash: string): string {
  return `tachyon.version.${workspaceHash}`;
}
