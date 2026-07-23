import type { StudioPanelState } from "./shared/studio/StudioPanelManagerBase.js";
import type { PinPatch } from "./pin-studio/domain.js";

export const PIN_STUDIO_VIEW_TYPE = "tachyonPinStudio";

/**
 * t-610705 (SDD 410 Phase D, D3) — the standalone Pin Studio panel was retired: it's a Control
 * studio-new/studio-edit route now (studios-routes-design.md), the one nav-less studio (its
 * close-target is the route's own `returnRoute` slot, not a fixed Control tab — route.ts). src/
 * webview/pin-studio/App.tsx stays, lazy-imported by cockpit/App.tsx. The trusted serializer for
 * the legacy "tachyonPinStudio" viewType stays registered in extension.ts (registerLegacyStudioRedirect):
 * a revived pre-410 panel disposes itself and redirects into Control → the pin's studio route.
 */
export type PinStudioPanelState = StudioPanelState<PinPatch>;
