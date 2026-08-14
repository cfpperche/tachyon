import * as vscode from "vscode";
import { StudioPanelManagerBase, type StudioDomainMessageContext, type StudioSurfaceConfig } from "./shared/studio/StudioPanelManagerBase.js";
import type { StudioRestoreSnapshot } from "@tachyon/webview-ui/webview/shared/studio/protocol";
import { createPipelineStudioAdapter } from "./pipelineStudioAdapter.js";
import { parseImportedStages, type PipelineEntity, type PipelineFields, type PipelinePatch } from "@tachyon/webview-ui/webview/pipeline-studio/domain";
import { stagesImportedMessage } from "@tachyon/webview-ui/webview/pipeline-studio/messages";

export const PIPELINE_STUDIO_VIEW_TYPE = "tachyonPipelineStudio";

export type PipelineStudioPanelState = {
  schemaVersion: 1;
  view: typeof PIPELINE_STUDIO_VIEW_TYPE;
  wsKey: string;
  snapshot: StudioRestoreSnapshot<string, PipelinePatch>;
};

/**
 * spec 350 T4 — Pipeline Studio (Fake 1) host wiring: proves the full shell lifecycle end to end. Deliberately
 * NOT registered anywhere in extension.ts and contributes NO command — the spec's "disabled `pipeline-studio`
 * (no command contribution, or dev-flag-hidden)" clause. Reachable only through this class's own tests and
 * the dev preview harness (which loads the built bundle directly, bypassing this host manager entirely).
 */
const surface: StudioSurfaceConfig = {
  viewType: PIPELINE_STUDIO_VIEW_TYPE,
  bundleFile: "pipeline-studio.js",
  styleFiles: ["codicon.css", "tokens.css", "faces.css", "design-system.css", "quick-picker.css", "studio-frame.css", "pipeline-studio.css"],
};

export class PipelineStudioPanelManager {
  private readonly store = new Map<string, PipelineEntity>();
  private readonly base: StudioPanelManagerBase<PipelineEntity, PipelineFields, PipelinePatch>;

  constructor(extensionUri: vscode.Uri, onChanged: () => void = () => {}) {
    this.base = new StudioPanelManagerBase(
      extensionUri,
      surface,
      createPipelineStudioAdapter(this.store),
      onChanged,
      (ctx, message) => this.handleDomainMessage(ctx, message),
    );
  }

  openNew(wsKey: string): void {
    this.base.openNew(wsKey);
  }

  openExisting(wsKey: string, entityId: string): void {
    this.base.openExisting(wsKey, entityId);
  }

  refreshAll(): void {
    this.base.refreshAll();
  }

  dispose(): void {
    this.base.dispose();
  }

  captureSnapshot(wsKey: string, entityId?: string): StudioRestoreSnapshot<string, PipelinePatch> | undefined {
    return this.base.captureSnapshot(wsKey, entityId);
  }

  restoreFromSnapshot(wsKey: string, snapshot: StudioRestoreSnapshot<string, PipelinePatch>): void {
    this.base.restoreFromSnapshot(wsKey, snapshot);
  }

  deserialize(panel: vscode.WebviewPanel, state: PipelineStudioPanelState): void {
    this.base.deserializePanel(panel, state);
  }

  private handleDomainMessage(ctx: StudioDomainMessageContext, message: { type: string }): void {
    if (message.type !== "importStages") return;
    const raw = (message as { raw?: string }).raw ?? "";
    const entityId = ctx.entityId;
    const existing = entityId ? this.store.get(entityId)?.stages ?? [] : [];
    ctx.post(stagesImportedMessage(parseImportedStages(raw, existing)));
  }
}
