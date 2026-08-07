/**
 * spec 279 — the SHARED host↔webview envelope for the Inspector view (`preact-live`, BOTH directions: the
 * host pushes init/model/capture; the webview posts ready/refresh/open/reap/capture/kill). Imported by the host
 * (`ServerInspector`), the webview (`inspector/main.tsx` + App), and the dev preview harness.
 */

import type { InspectorModel } from "../../inspector/model";

export { READY, readyMessage, type ReadyMessage } from "../shared/ready";

/** the l10n strings the host posts once (init); the webview renders with them (kept extension-side for locale). */
export interface InspectorStrings {
  title: string; subtitle: string; refresh: string; auto: string; empty: string; summary: string;
  foreignNote: string; pid: string; live: string; dead: string; exit: string; busy: string; idle: string;
  open: string; capture: string; kill: string; reapDead: string; reapOrphans: string; killConfirm: string;
  kindSession: string; kindCommand: string; kindRunbook: string; kindLogin: string; kindAnchor: string; kindUnknown: string;
  captureEmpty: string; ageSeconds: string; ageMinutes: string; ageHours: string; ageDays: string;
  overview: string; server: string; all: string; search: string; workspace: string; status: string; kind: string; cpu: string;
  details: string; fullName: string; hash: string; command: string; startCommand: string; uptime: string;
  total: string; orphaned: string; socket: string; path: string; health: string; version: string; serverPids: string;
  diagnostics: string; noDiagnostics: string; refreshCapture: string; close: string; bulkActions: string;
  scopeNote: string; scopeShowAll: string;
}

/**
 * t-6b5dea — the window's selected project, as the SIDEBAR set it (`ControlWorkspaceScope`).
 *
 * It is the DEFAULT the screen opens on, never a restriction: the host resolves the hash to a folder name
 * so the client can name the project even when that project owns no session on the socket, and the client
 * drops it the moment a human picks something in the Workspace filter.
 */
export interface InspectorScope { hash: string; label: string }

// ── host → webview ───────────────────────────────────────────────────────────
export const INIT = "init" as const;
export interface InitMessage { type: typeof INIT; strings: InspectorStrings; scope?: InspectorScope }
export function initMessage(strings: InspectorStrings, scope?: InspectorScope): InitMessage {
  return { type: INIT, strings, scope };
}

export const MODEL = "model" as const;
export interface ModelMessage { type: typeof MODEL; model: InspectorModel }
export function modelMessage(model: InspectorModel): ModelMessage { return { type: MODEL, model }; }

export const CAPTURE = "capture" as const;
export interface CaptureMessage { type: typeof CAPTURE; session: string; text: string }
export function captureMessage(session: string, text: string): CaptureMessage { return { type: CAPTURE, session, text }; }

export type InspectorHostMessage = InitMessage | ModelMessage | CaptureMessage;

// ── webview → host (inbound actions) ──────────────────────────────────────────
export type InspectorAction =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "open"; session: string }
  | { type: "reapDead" }
  | { type: "reapOrphans" }
  | { type: "capture"; session: string }
  | { type: "kill"; session: string };

export const refreshAction = (): InspectorAction => ({ type: "refresh" });
export const openAction = (session: string): InspectorAction => ({ type: "open", session });
export const reapDeadAction = (): InspectorAction => ({ type: "reapDead" });
export const reapOrphansAction = (): InspectorAction => ({ type: "reapOrphans" });
export const captureAction = (session: string): InspectorAction => ({ type: "capture", session });
export const killAction = (session: string): InspectorAction => ({ type: "kill", session });
