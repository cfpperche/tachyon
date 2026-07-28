/**
 * Human Inbox — the host half of an artifact preview: read the file, or say why not (t-e76acc).
 *
 * `artifacts.ts` decides what a ref IS; this decides what may actually be inlined into the webview.
 * That split matters because every decision here is a boundary decision, and three of them are
 * security-shaped rather than cosmetic:
 *
 *  1. **Containment.** An `ArtifactRef` is agent-written text. A validation could carry
 *     `{type:"image", ref:"/home/me/.ssh/id_rsa.png"}` — or `../../../etc/shadow.svg` — and without a
 *     containment check this function would base64 it straight into a webview the human is looking at.
 *     So a path is loaded ONLY if it resolves inside the workspace root. Outside is refused by name,
 *     not silently skipped: a human looking at evidence deserves to know the evidence pointed out of
 *     the repository.
 *  2. **A budget.** These bytes travel inline in a postMessage, so a 400 MB "screenshot" would wedge
 *     the panel rather than fail. Over budget is a REFUSAL WITH THE SIZE in it — the human can still
 *     go open the file, which is the readable fallback the task asks for.
 *  3. **HTML is never handed a URL.** A prototype is read, sanitized through the same
 *     `assembleUntrustedSrcdoc(..., "prototype-static")` Task detail's PrototypePreview already uses,
 *     and delivered as srcdoc for a `sandbox=""` iframe. Pointing a frame at a webview-resource URI
 *     instead would let arbitrary repository HTML run with the panel's own origin.
 *
 * Everything is injected or derived from arguments, so the whole matrix is testable against a temp
 * directory with no vscode, no webview and no panel.
 */
import fs from "node:fs";
import path from "node:path";
import { assembleUntrustedSrcdoc } from "../webview/shared/untrustedSrcdoc.js";
import type { InboxArtifactContent } from "./artifacts.js";

/** Inline budget per artifact. Images travel base64 (≈ +33%), so this is generous but bounded. */
export const INBOX_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const INBOX_PROTOTYPE_MAX_BYTES = 512 * 1024;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
};

function humanBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/**
 * Is `absolutePath` inside `root`? String-prefix comparison on RESOLVED paths, with the separator
 * appended so `/ws-secrets/x` never counts as inside `/ws`.
 */
export function insideWorkspace(root: string, absolutePath: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(absolutePath);
  return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
}

export interface InboxArtifactLoadDeps {
  /** injected for tests; defaults to the real filesystem */
  statSync?: (p: string) => { size: number; isFile(): boolean };
  readFileSync?: (p: string) => Buffer;
}

/**
 * Build the `load` function `projectInboxArtifacts` injects. One closure per workspace, because
 * containment is a property of THAT workspace's root and must not be shared across roots.
 */
export function makeInboxArtifactLoader(
  workspaceRoot: string,
  deps: InboxArtifactLoadDeps = {},
): (absolutePath: string, kind: "image" | "prototype") => InboxArtifactContent {
  const statSync = deps.statSync ?? ((p: string) => fs.statSync(p));
  const readFileSync = deps.readFileSync ?? ((p: string) => fs.readFileSync(p));

  return (absolutePath, kind) => {
    if (!insideWorkspace(workspaceRoot, absolutePath)) {
      return { unavailable: "outside this workspace — not previewed" };
    }
    let size: number;
    try {
      const stat = statSync(absolutePath);
      if (!stat.isFile()) return { unavailable: "not a file" };
      size = stat.size;
    } catch {
      return { unavailable: "file not found" };
    }
    const max = kind === "image" ? INBOX_IMAGE_MAX_BYTES : INBOX_PROTOTYPE_MAX_BYTES;
    if (size > max) return { unavailable: `too large to preview inline (${humanBytes(size)})` };
    let bytes: Buffer;
    try {
      bytes = readFileSync(absolutePath);
    } catch (err) {
      return { unavailable: err instanceof Error ? err.message : String(err) };
    }
    if (kind === "prototype") {
      // Same sanitization Task detail's prototype preview gets: scripts stripped, CSP meta injected,
      // pointer events neutered. The iframe that renders it carries sandbox="" on top of this.
      return { prototype: assembleUntrustedSrcdoc(bytes.toString("utf8"), { mode: "prototype-static" }) };
    }
    const mime = IMAGE_MIME[path.extname(absolutePath).toLowerCase()];
    if (!mime) return { unavailable: "unsupported image format" };
    return { image: `data:${mime};base64,${bytes.toString("base64")}` };
  };
}
