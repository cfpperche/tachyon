import type { ArtifactRef } from "@tachyon/shared/tasks/types.js";
/** How a ref can be shown. `reference` is the readable fallback, never a failure. */
export type InboxArtifactKind = "image" | "prototype" | "link" | "reference";


/**
 * What the host managed to load for one path-like ref.
 *
 * `unavailable` carries the host's own words rather than a boolean, because the human deserves the
 * difference between "the evidence is gone" and "this workspace will not read it" — one is a lost
 * artifact, the other is a permission/size boundary, and only one of them means someone should go
 * looking for the file.
 */
export type InboxArtifactContent =
  /** an image the renderer can put in `<img src>` — a data URI, not a path the page fetches */
  | { image: string }
  /** already-sanitized static HTML for a sandboxed `srcdoc` iframe, same as a task prototype */
  | { prototype: string }
  | { unavailable: string };


export interface InboxArtifactPreview {
  /** stable within one item — index-based, since refs carry no id of their own */
  id: string;
  kind: InboxArtifactKind;
  /** what to call it: the file's basename, or the ref itself when it has no path shape */
  name: string;
  /** the ref's declared type plus its raw value, for the line under the name */
  detail: string;
  /** false when the thing exists as a REFERENCE but cannot be shown (missing file, unreadable, too big) */
  available: boolean;
  /** host-loaded image source for `<img>`; present only for an image that actually loaded */
  src?: string;
  /** host-sanitized static HTML for a sandboxed iframe; present only for a prototype that loaded */
  srcdoc?: string;
  /** why it cannot be shown — displayed instead of the preview, never swallowed */
  reason?: string;
  /** the verbatim ref, so a detail route can offer "copy" or a deep link without re-deriving it */
  ref: ArtifactRef;
}


export interface InboxArtifactResolver {
  /** workspace root, for resolving a repo-relative ref */
  workspaceRoot?: string;
  /**
   * Read one path-like artifact. The host owns every decision this module must not make: whether the
   * file exists, whether it is inside a readable boundary, whether it is small enough to inline, and
   * how to sanitize HTML. Returning `undefined` means the caller has no loader at all (the headless
   * path) — the artifact degrades to unavailable rather than to a broken `<img>`.
   */
  load?(absolutePath: string, kind: "image" | "prototype"): InboxArtifactContent | undefined;
}


export interface InboxArtifactSummary {
  total: number;
  previewable: number;
  unavailable: number;
}
