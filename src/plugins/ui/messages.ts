/**
 * spec 349 — shared host↔plugin-surface envelope for the curated fleet projection.
 *
 * Pure module: imported by the projection sender, future relay listener, and tests. The type string and shape
 * live here once so envelope drift breaks typecheck instead of silently changing the postMessage contract.
 */

import type { PluginFleetProjectionV1 } from "./projectionTypes.js";

export { READY, readyMessage, type ReadyMessage } from "../../webview/shared/ready.js";

export const PLUGIN_FLEET_PROJECTION = "pluginFleetProjection" as const;
export interface PluginFleetProjectionMessage {
  type: typeof PLUGIN_FLEET_PROJECTION;
  projection: PluginFleetProjectionV1;
}

export function pluginFleetProjectionMessage(projection: PluginFleetProjectionV1): PluginFleetProjectionMessage {
  return { type: PLUGIN_FLEET_PROJECTION, projection };
}

export type PluginUiHostMessage = PluginFleetProjectionMessage;
