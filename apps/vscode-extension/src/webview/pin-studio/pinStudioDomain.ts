/**
 * t-610705 (SDD 410 Phase D, D3) — Pin Studio's domain-message handler, ported from the retired
 * PinStudioPanelManager.handleDomainMessage (+ its private attachImage/storeSketch
 * helpers) onto the generic StudioRegistryEntry.handleDomainMessage extension point
 * (studioRegistry.ts) — same pattern as taskStudioDomain.ts (D2), minus importPrototype (Pin has no
 * prototype concept). Kept in its own file for the same reason taskStudioDomain.ts is: real file-
 * Buffer I/O per message, well beyond command/terminal's 3-line browse→cwd forward.
 *
 * Every handler reads `ctx.entityId` rather than a per-panel tracked field (same structural swap
 * D1b's Agent Studio port made) — for Pin Studio this is `undefined` while drafting a brand-new pin
 * (studio-new is a real, reachable route for pin, unlike task) — every handler no-ops on `undefined`
 * exactly like the old panel's own guards.
 */
import type { WorkspacePinStudioTarget } from "../../shell/PinStudioTarget.js";
import { envelope } from "@tachyon/webview-ui/webview/shared/studio/protocol";
import { attachmentStoredMessage } from "@tachyon/webview-ui/webview/pin-studio/messages";
import { notify } from "../../workspace/NotificationService.js";
import type { StudioDomainContext } from "../shared/studio/studioRegistry.js";

/** the webview -> host domain message shapes (mirrors pin-studio/types.ts's PinStudioWebviewMessage's
 *  domain members) — kept local since the dispatch's `message` param is only typed as `{ type: string }`. */
type PinStudioDomainMessage =
  | { type: "attachImage"; mediaType: string; name?: string; source: "paste" | "drop" | "import"; dataBase64: string }
  | { type: "storeSketch"; attachmentId?: string; name?: string; source: "blank" | "annotate-image"; baseImageAttachmentId?: string; sceneJson: string; previewBase64: string };

export function handlePinStudioDomainMessage(target: WorkspacePinStudioTarget, ctx: StudioDomainContext, message: { type: string }): void {
  if (message.type === "attachImage") { void attachImage(target, ctx, message as Extract<PinStudioDomainMessage, { type: "attachImage" }>); return; }
  if (message.type === "storeSketch") { void storeSketch(target, ctx, message as Extract<PinStudioDomainMessage, { type: "storeSketch" }>); return; }
}

async function attachImage(target: WorkspacePinStudioTarget, ctx: StudioDomainContext, m: Extract<PinStudioDomainMessage, { type: "attachImage" }>): Promise<void> {
  try {
    const estimated = Math.floor((m.dataBase64.length * 3) / 4);
    if (estimated > 10 * 1024 * 1024 + 8) throw new Error("pin image exceeds 10 MB limit");
    const stored = await target.putPinStudioImage({
      data: Buffer.from(stripDataPrefix(m.dataBase64), "base64"),
      mediaType: m.mediaType,
      ...(m.name !== undefined ? { name: m.name } : {}),
      source: m.source,
    });
    ctx.post(attachmentStoredMessage(stored.attachment));
    if (stored.overSoftLimit) notifyImageSoftLimit();
  } catch (error) {
    postDomainError(ctx, error instanceof Error ? error.message : String(error));
  }
}

async function storeSketch(target: WorkspacePinStudioTarget, ctx: StudioDomainContext, m: Extract<PinStudioDomainMessage, { type: "storeSketch" }>): Promise<void> {
  try {
    const stored = await target.putPinStudioSketch(ctx.entityId, {
      ...(m.attachmentId !== undefined ? { attachmentId: m.attachmentId } : {}),
      ...(m.name !== undefined ? { name: m.name } : {}),
      source: m.source,
      ...(m.baseImageAttachmentId !== undefined ? { baseImageAttachmentId: m.baseImageAttachmentId } : {}),
      sceneJson: m.sceneJson,
      previewData: Buffer.from(stripDataPrefix(m.previewBase64), "base64"),
    });
    ctx.post(attachmentStoredMessage(stored.attachment));
    if (stored.overSoftLimit) notifySketchSoftLimit();
  } catch (error) {
    postDomainError(ctx, error instanceof Error ? error.message : String(error));
  }
}

function postDomainError(ctx: StudioDomainContext, message: string): void {
  ctx.post(envelope({ type: "error" as const, code: "pin/domain-error", message, source: "persistence" as const, blocking: true }));
}

function notifyImageSoftLimit(): void {
  notify("Tachyon pin images exceed 50 MB in this workspace; saves still work, but consider pruning old screenshots.", "warn", { prefix: false });
}

function notifySketchSoftLimit(): void {
  notify("Tachyon pin visual artifacts exceed 50 MB in this workspace; saves still work, but consider pruning old screenshots/sketches.", "warn", { prefix: false });
}

function stripDataPrefix(value: string): string {
  const i = value.indexOf(",");
  return i >= 0 ? value.slice(i + 1) : value;
}
