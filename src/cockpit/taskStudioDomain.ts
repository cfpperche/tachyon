/**
 * t-610705 (SDD 410 Phase D, D2) — Task Studio's domain-message handler, ported from the retired
 * TaskStudioPanelManager.handleDomainMessage (+ its private importPrototype/attachImage/
 * storeSketch helpers) onto the generic StudioRegistryEntry.handleDomainMessage extension point
 * (studioRegistry.ts) — same pattern as agentStudioDomain.ts. Kept in its own file rather than inline
 * in studioRegistry.ts for the same reason: each message does real file-picker/Buffer I/O,
 * well beyond command/terminal's 3-line browse→cwd forward.
 *
 * Every handler reads `ctx.entityId` rather than a per-panel tracked field (same structural swap
 * D1b's Agent Studio port already made) — for Task Studio this is ALWAYS defined in practice (see
 * route.ts's decodeRoute: studio-new + "task" is rejected outright; every real caller pre-mints an
 * id and opens studio-edit directly), but each handler still no-ops defensively on `undefined` rather
 * than assuming the route model's own invariant, matching the old panel's own guards verbatim.
 */
import * as vscode from "vscode";
import fs from "node:fs";
import path from "node:path";
import type { WorkspaceTaskStudioTarget } from "../shell/TaskStudioTarget.js";
import { envelope } from "../webview/shared/studio/protocol.js";
import { attachmentStoredMessage } from "../webview/task-studio/messages.js";
import { notify } from "../workspace/NotificationService.js";
import type { StudioDomainContext } from "../webview/shared/studio/studioRegistry.js";

/** the webview -> host domain message shapes (mirrors task-studio/types.ts's TaskStudioWebviewMessage's
 *  domain members) — kept local since the dispatch's `message` param is only typed as `{ type: string }`. */
type TaskStudioDomainMessage =
  | { type: "importPrototype" }
  | { type: "attachImage"; mediaType: string; name?: string; source: "paste" | "drop" | "import"; dataBase64: string }
  | { type: "storeSketch"; attachmentId?: string; name?: string; source: "blank" | "annotate-image"; baseImageAttachmentId?: string; sceneJson: string; previewBase64: string };

export function handleTaskStudioDomainMessage(target: WorkspaceTaskStudioTarget, ctx: StudioDomainContext, message: { type: string }): void {
  if (message.type === "importPrototype") { void importPrototype(target, ctx); return; }
  if (message.type === "attachImage") { void attachImage(target, ctx, message as Extract<TaskStudioDomainMessage, { type: "attachImage" }>); return; }
  if (message.type === "storeSketch") { void storeSketch(target, ctx, message as Extract<TaskStudioDomainMessage, { type: "storeSketch" }>); return; }
}

async function importPrototype(target: WorkspaceTaskStudioTarget, ctx: StudioDomainContext): Promise<void> {
  // t-610705 (Phase D, D2) — the old panel called `this.onTasksChanged()` here; `StudioDomainContext`
  // (post + entityId only) has no onChanged-equivalent hook to port it to — the SAME already-accepted
  // gap D1b's profile mutations (agentStudioDomain.ts, genuinely more mutation-heavy than this)
  // already carry, not a new regression this port introduces. Cross-cutting fix (extending
  // StudioDomainContext for every studio) is out of scope here.
  if (!ctx.entityId) return;
  const picked = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, filters: { HTML: ["html", "htm"] }, title: "Import static task prototype" });
  const file = picked?.[0]?.fsPath;
  if (!file) return;
  try {
    const stat = fs.statSync(file);
    if (stat.size > 512 * 1024) throw new Error("prototype HTML exceeds 524288 bytes");
    const html = fs.readFileSync(file, "utf8");
    await target.importTaskStudioPrototype(ctx.entityId, { html, title: path.basename(file) });
  } catch (err) {
    postDomainError(ctx, err instanceof Error ? err.message : String(err));
  }
}

async function attachImage(target: WorkspaceTaskStudioTarget, ctx: StudioDomainContext, m: Extract<TaskStudioDomainMessage, { type: "attachImage" }>): Promise<void> {
  try {
    if (!ctx.entityId) return;
    const estimated = Math.floor((m.dataBase64.length * 3) / 4);
    if (estimated > 10 * 1024 * 1024 + 8) throw new Error("task image exceeds 10 MB limit");
    const stored = await target.putTaskStudioImage(ctx.entityId, {
      data: Buffer.from(stripDataPrefix(m.dataBase64), "base64"),
      mediaType: m.mediaType,
      ...(m.name !== undefined ? { name: m.name } : {}),
      source: m.source,
    });
    ctx.post(attachmentStoredMessage(stored.attachment));
    if (stored.overSoftLimit) notifyImageSoftLimit();
  } catch (err) {
    postDomainError(ctx, err instanceof Error ? err.message : String(err));
  }
}

async function storeSketch(target: WorkspaceTaskStudioTarget, ctx: StudioDomainContext, m: Extract<TaskStudioDomainMessage, { type: "storeSketch" }>): Promise<void> {
  if (!ctx.entityId) return;
  try {
    const stored = await target.putTaskStudioSketch(ctx.entityId, {
      ...(m.attachmentId !== undefined ? { attachmentId: m.attachmentId } : {}),
      sceneJson: m.sceneJson,
      previewData: Buffer.from(stripDataPrefix(m.previewBase64), "base64"),
      ...(m.name !== undefined ? { name: m.name } : {}),
      source: m.source,
      ...(m.baseImageAttachmentId ? { baseImageAttachmentId: m.baseImageAttachmentId } : {}),
    });
    ctx.post(attachmentStoredMessage(stored.attachment));
    if (stored.overSoftLimit) notifySketchSoftLimit();
  } catch (err) {
    postDomainError(ctx, err instanceof Error ? err.message : String(err));
  }
}

function postDomainError(ctx: StudioDomainContext, message: string): void {
  ctx.post(envelope({ type: "error" as const, code: "persistence/unknown", message, blocking: true }));
}

function notifyImageSoftLimit(): void {
  notify("Tachyon task images exceed 50 MB in this workspace; saves still work, but consider pruning old screenshots.", "warn", { prefix: false });
}

function notifySketchSoftLimit(): void {
  notify("Tachyon task visual artifacts exceed 50 MB in this workspace; saves still work, but consider pruning old screenshots/sketches.", "warn", { prefix: false });
}

function stripDataPrefix(value: string): string {
  const i = value.indexOf(",");
  return i >= 0 ? value.slice(i + 1) : value;
}
