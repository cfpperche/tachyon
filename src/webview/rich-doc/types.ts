import type { ResolvedRichDocAttachment } from "../../richDoc/types.js";

export type { TiptapJSON } from "../../richDoc/types.js";

/** The webview-side attachment view model: a resolved attachment plus webview-usable URIs/scene JSON. */
export type RichDocAttachmentVM = ResolvedRichDocAttachment & {
  uri?: string;
  previewUri?: string;
  sceneJson?: string;
};

export interface RichDocAssets {
  excalidrawScriptUri: string;
  excalidrawCssUri: string;
  excalidrawAssetPath: string;
}
