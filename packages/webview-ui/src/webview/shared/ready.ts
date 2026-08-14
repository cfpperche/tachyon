/**
 * spec 278 — the SHARED webview→host "ready" handshake, common to every view (the iframe mounted and is
 * ready to receive its first push). Pure; imported by each view's main.tsx (to post it), the dev preview
 * harness (to wait for it before injecting a fixture), and re-exported per-view for convenience.
 */

export const READY = "ready" as const;
export interface ReadyMessage {
  type: typeof READY;
}
export function readyMessage(): ReadyMessage {
  return { type: READY };
}
