import { render, type VNode } from "preact";
import { useEffect, useMemo } from "preact/hooks";
import { Excalidraw, exportToBlob, serializeAsJSON, convertToExcalidrawElements } from "@excalidraw/excalidraw";

type ExcalidrawElements = readonly unknown[];
type ExcalidrawAppState = Record<string, unknown>;
type ExcalidrawFiles = Record<string, { id: string; dataURL: string; mimeType: string; created: number; [key: string]: unknown }>;

export interface TachyonExcalidrawScene {
  type?: string;
  version?: number;
  source?: string;
  elements?: unknown[];
  appState?: ExcalidrawAppState;
  files?: ExcalidrawFiles;
}

export interface TachyonExcalidrawBaseImage {
  attachmentId: string;
  name: string;
  dataURL: string;
  mediaType: string;
  width?: number;
  height?: number;
}

export interface TachyonExcalidrawMountOptions {
  initialScene?: TachyonExcalidrawScene | null;
  baseImage?: TachyonExcalidrawBaseImage;
  theme?: "dark" | "light";
  onReady?: () => void;
  onChange?: () => void;
}

export interface TachyonExcalidrawSaveResult {
  sceneJson: string;
  previewBase64: string;
  elementCount: number;
}

export interface TachyonExcalidrawSession {
  save(): Promise<TachyonExcalidrawSaveResult>;
  unmount(): void;
}

interface SessionState {
  elements: ExcalidrawElements;
  appState: ExcalidrawAppState;
  files: ExcalidrawFiles;
}

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
    __tachyonExcalidraw?: {
      mount(container: HTMLElement, options?: Record<string, unknown>): TachyonExcalidrawSession;
    };
  }
}

const Draw = Excalidraw as unknown as (props: Record<string, unknown>) => VNode;

function TachyonExcalidraw({ state, options }: { state: SessionState; options: TachyonExcalidrawMountOptions }) {
  const initialData = useMemo(() => {
    const scene = options.initialScene ?? {};
    const files = { ...(scene.files ?? {}) };
    let elements = scene.elements ?? [];
    const appState = {
      ...(scene.appState ?? {}),
      theme: options.theme ?? "dark",
      viewBackgroundColor: (scene.appState?.viewBackgroundColor as string | undefined) ?? "#ffffff",
    };

    if (options.baseImage && elements.length === 0) {
      const fileId = `tachyon-${options.baseImage.attachmentId}`;
      files[fileId] = {
        id: fileId,
        dataURL: options.baseImage.dataURL,
        mimeType: options.baseImage.mediaType,
        created: Date.now(),
      };
      const width = options.baseImage.width ?? 900;
      const height = options.baseImage.height ?? Math.round(width * 0.62);
      elements = convertToExcalidrawElements([
        {
          type: "image",
          x: 0,
          y: 0,
          width,
          height,
          fileId,
          status: "saved",
        },
      ] as never, { regenerateIds: true }) as unknown[];
    }

    state.elements = elements;
    state.appState = appState;
    state.files = files;
    return { elements, appState, files };
  }, [options, state]);

  useEffect(() => {
    options.onReady?.();
  }, [options]);

  return (
    <Draw
      initialData={initialData}
      theme={options.theme ?? "dark"}
      detectScroll={false}
      handleKeyboardGlobally={false}
      UIOptions={{
        canvasActions: {
          export: false,
          saveAsImage: false,
          saveToActiveFile: false,
          loadScene: false,
        },
      }}
      onChange={(elements: ExcalidrawElements, appState: ExcalidrawAppState, files: ExcalidrawFiles) => {
        state.elements = elements;
        state.appState = appState;
        state.files = files;
        options.onChange?.();
      }}
    />
  );
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

window.__tachyonExcalidraw = {
  mount(container, options = {}) {
    const typedOptions = options as TachyonExcalidrawMountOptions;
    const state: SessionState = { elements: [], appState: {}, files: {} };
    render(<TachyonExcalidraw state={state} options={typedOptions} />, container);
    return {
      async save() {
        const sceneJson = serializeAsJSON(state.elements as never, state.appState as never, state.files as never, "local");
        const preview = await exportToBlob({
          elements: state.elements as never,
          appState: { ...state.appState, exportWithDarkMode: false, exportEmbedScene: false, viewBackgroundColor: "#ffffff" } as never,
          files: state.files as never,
          mimeType: "image/png",
          exportPadding: 24,
        });
        return {
          sceneJson,
          previewBase64: await blobToBase64(preview),
          elementCount: state.elements.filter((el) => !(el as { isDeleted?: boolean }).isDeleted).length,
        };
      },
      unmount() {
        render(null, container);
      },
    };
  },
};
