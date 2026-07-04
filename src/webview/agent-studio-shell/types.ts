import type { StudioConcurrencyState, StudioRestoreSnapshot } from "../shared/studio/protocol";
import type { AgentStudioEntity, AgentStudioPatch } from "./domain";

export type { AgentStudioEntity, AgentStudioFields, AgentStudioPatch } from "./domain";

/** Host -> webview messages this surface actually receives (core + its one registered domain reply, `cwd` —
 *  the `browse` native-picker round trip's answer). */
export type AgentStudioHostMessage =
  | { type: "load"; entity: AgentStudioEntity; concurrency: StudioConcurrencyState; saveInFlight?: boolean; studioProtocolVersion: number }
  | { type: "error"; code: string; message: string; blocking: boolean; studioProtocolVersion: number }
  | { type: "restore"; snapshot: StudioRestoreSnapshot<string, AgentStudioPatch> | null; studioProtocolVersion: number }
  | { type: "cwd"; value: string; studioProtocolVersion: number };

/** Webview -> host messages this surface sends. */
export type AgentStudioWebviewMessage =
  | { type: "ready"; studioProtocolVersion: number }
  | { type: "patch"; patch: AgentStudioPatch; studioProtocolVersion: number }
  | { type: "dirty"; dirty: boolean; studioProtocolVersion: number }
  | { type: "save"; studioProtocolVersion: number }
  | { type: "cancel"; studioProtocolVersion: number }
  | { type: "browse"; studioProtocolVersion: number };
