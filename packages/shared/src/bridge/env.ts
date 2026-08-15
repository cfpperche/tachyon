/**
 * Env keys Tachyon injects into spawned agent sessions (t-907238).
 * Hook scripts that talk to the Bridge must read THESE names — inventing
 * a parallel TACHYON_AGENT_BRIDGE_URL is how runtime-status-publish
 * silently never worked until the failure log landed.
 */
export const TOKEN_ENV_VAR = "TACHYON_BRIDGE_TOKEN";
export const URL_ENV_VAR = "TACHYON_BRIDGE_URL";
/** spec 351 — per-agent minted token, injected alongside TOKEN_ENV_VAR. */
export const AGENT_TOKEN_ENV_VAR = "TACHYON_AGENT_BRIDGE_TOKEN";
