import { useEffect, useRef, useState } from "preact/hooks";
import { Button } from "../shared/ui";
import { dataURLWithMediaType } from "./data-url.js";
import type { RichDocAssets, RichDocAttachmentVM } from "./types.js";

const Icon = ({ name }: { name: string }) => <span class={`codicon codicon-${name}`} aria-hidden="true" />;

export interface SketchRequest {
  attachmentId?: string;
  name: string;
  source: "blank" | "annotate-image";
  baseImageAttachmentId?: string;
  initialScene?: Record<string, unknown> | null;
  baseImage?: {
    attachmentId: string;
    name: string;
    dataURL: string;
    mediaType: string;
    width?: number;
    height?: number;
  };
  insertOnStore: boolean;
}

export interface RichDocExcalidrawSaveResult {
  sceneJson: string;
  previewBase64: string;
  elementCount: number;
}

interface RichDocExcalidrawSession {
  save(): Promise<RichDocExcalidrawSaveResult>;
  unmount(): void;
}

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
    __tachyonExcalidraw?: {
      mount(container: HTMLElement, options?: Record<string, unknown>): RichDocExcalidrawSession;
    };
  }
}

export function attachmentPreview(att: RichDocAttachmentVM): string | undefined {
  return att.kind === "image" ? att.uri : att.previewUri;
}

export function attachmentSizeLabel(att: RichDocAttachmentVM): string {
  return att.kind === "image" ? `${Math.round(att.size / 1024)} KB` : `${Math.round(att.previewSize / 1024)} KB preview`;
}

export function uriToDataURL(uri: string, mediaType: string): Promise<string> {
  return fetch(uri)
    .then((response) => {
      if (!response.ok) throw new Error(`Unable to read image artifact (${response.status})`);
      return response.blob();
    })
    .then((blob) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const value = String(reader.result ?? "");
        resolve(dataURLWithMediaType(value, mediaType));
      };
      reader.readAsDataURL(blob);
    }));
}

/** The Visuals aside: import/drop affordance + attachment list with annotate/edit actions. */
export function VisualsPanel({
  attachments,
  onImport,
  onAnnotate,
  onEditSketch,
}: {
  attachments: RichDocAttachmentVM[];
  onImport: () => void;
  onAnnotate: (att: RichDocAttachmentVM) => void;
  onEditSketch: (att: RichDocAttachmentVM) => void;
}) {
  return (
    <aside>
      <button class="drop" type="button" onClick={onImport}>
        <Icon name="cloud-upload" />
        <span>Paste, drop, import, or annotate screenshots</span>
      </button>
      <div class="att-head">Visuals · {attachments.length}</div>
      {attachments.length === 0 ? <div class="ds-dim">No screenshots or sketches attached.</div> : attachments.map((a) => (
        <div class="att" key={a.id}>
          <div class="att-thumb">
            {attachmentPreview(a) ? <img src={attachmentPreview(a)} alt="" class={a.kind === "excalidraw" ? "att-sketch-preview" : undefined} /> : <span class="missing"><Icon name="warning" /></span>}
            {a.kind === "excalidraw" && a.source === "annotate-image" && (
              <span class="att-annotated-badge" title="Annotated"><Icon name="edit" /></span>
            )}
          </div>
          <div>
            <div class="att-name">{a.name}</div>
            <div class="ds-dim">{attachmentSizeLabel(a)}</div>
            <div class="att-actions">
              {a.kind === "image" && <button type="button" onClick={() => onAnnotate(a)}>Annotate</button>}
              {a.kind === "excalidraw" && <button type="button" onClick={() => onEditSketch(a)}>Edit</button>}
            </div>
          </div>
        </div>
      ))}
    </aside>
  );
}

let excalidrawLoad: Promise<void> | undefined;

function ensureExcalidraw(assets: RichDocAssets): Promise<void> {
  if (window.__tachyonExcalidraw) return Promise.resolve();
  if (excalidrawLoad) return excalidrawLoad;
  window.EXCALIDRAW_ASSET_PATH = assets.excalidrawAssetPath;
  excalidrawLoad = new Promise((resolve, reject) => {
    if (!document.querySelector(`link[href="${cssEscape(assets.excalidrawCssUri)}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = assets.excalidrawCssUri;
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.src = assets.excalidrawScriptUri;
    script.onload = () => window.__tachyonExcalidraw ? resolve() : reject(new Error("Excalidraw bundle loaded without registering the Tachyon bridge"));
    script.onerror = () => reject(new Error("Failed to load Excalidraw bundle"));
    document.body.appendChild(script);
  });
  return excalidrawLoad;
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

export function SketchModal({
  assets,
  request,
  onCancel,
  onSave,
  onError,
}: {
  assets: RichDocAssets;
  request: SketchRequest;
  onCancel: () => void;
  onSave: (request: SketchRequest, result: RichDocExcalidrawSaveResult) => void;
  onError: (message: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const session = useRef<RichDocExcalidrawSession | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    setReady(false);
    setLoadError(undefined);
    ensureExcalidraw(assets)
      .then(() => {
        if (disposed || !host.current || !window.__tachyonExcalidraw) return;
        session.current = window.__tachyonExcalidraw.mount(host.current, {
          initialScene: request.initialScene,
          baseImage: request.baseImage,
          theme: "dark",
          onReady: () => setReady(true),
        });
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)));
    return () => {
      disposed = true;
      session.current?.unmount();
      session.current = null;
    };
  }, [assets, request]);

  const save = async () => {
    try {
      const result = await session.current?.save();
      if (!result) throw new Error("Sketch editor is not ready");
      onSave(request, result);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div class="sketch-modal">
      <div class="sketch-bar">
        <strong>{request.name}</strong>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" icon="save" disabled={!ready || !!loadError} onClick={() => void save()}>Save sketch</Button>
      </div>
      <div class="sketch-host">
        {loadError && <div class="sketch-fail">{loadError}</div>}
        <div ref={host} />
      </div>
    </div>
  );
}
