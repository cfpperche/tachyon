import { envelope } from "../shared/studio/protocol";
import { projectSoulProfileStatus, type AgentStudioPatch, type SoulProfileStatusMessage } from "./domain";

export const readyMessage = () => envelope({ type: "ready" as const });
export const patchMessage = (patch: AgentStudioPatch) => envelope({ type: "patch" as const, patch });
export const dirtyMessage = (dirty: boolean) => envelope({ type: "dirty" as const, dirty });
export const saveMessage = () => envelope({ type: "save" as const });
export const cancelMessage = () => envelope({ type: "cancel" as const });
export const browseMessage = () => envelope({ type: "browse" as const });

/** Webview → host: create minimal canonical SOUL.md under a journaled transaction. */
export const createSoulMessage = (agent: string) => envelope({ type: "createSoul" as const, agent });
/** Webview → host: import exact bytes selected by the in-Studio picker; no local path crosses the boundary. */
export const importSoulMessage = (agent: string, contentBase64: string) =>
  envelope({ type: "importSoul" as const, agent, contentBase64 });
/** Webview → host: open the canonical managed copy in the editor. */
export const openSoulMessage = (agent: string) => envelope({ type: "openSoul" as const, agent });
/** Webview → host: re-read profile status. */
export const refreshSoulMessage = (agent: string) => envelope({ type: "refreshSoul" as const, agent });
/** Webview → host: bounded preview + status. */
export const previewSoulMessage = (agent: string) => envelope({ type: "previewSoul" as const, agent });
/** Webview → host: digest-backed adopt of retained data. */
export const adoptSoulProfileMessage = (agent: string, expectedDigest: string) =>
  envelope({ type: "adoptSoulProfile" as const, agent, expectedDigest });
/** Webview → host: enable soul when an active resolvable profile exists. */
export const enableSoulMessage = (agent: string) => envelope({ type: "enableSoul" as const, agent });
/** Webview → host: disable soul, retain bytes, mark retained. */
export const disableSoulMessage = (agent: string) => envelope({ type: "disableSoul" as const, agent });

/** Host → webview: profile status / preview reply. */
export const soulProfileStatusMessage = (status: SoulProfileStatusMessage) =>
  envelope({ type: "soulProfileStatus" as const, status: projectSoulProfileStatus(status) });

/** Host → webview: profile action failure (typed; no source path). */
export const soulProfileErrorMessage = (agent: string, code: string, message: string) =>
  envelope({ type: "soulProfileError" as const, agent, code, message });
