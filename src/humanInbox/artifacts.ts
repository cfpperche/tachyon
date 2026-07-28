/**
 * Human Inbox — turning an item's `ArtifactRef[]` into things a detail route can SHOW (t-e76acc).
 *
 * The task asks for inline previews of images, screenshots and HTML prototypes "with the same
 * experience and components already used in the Task detail screens". Measured before writing any of
 * this, rather than assumed:
 *
 *   - Task detail renders `artifact_refs` as plain BADGES (`task-detail/App.tsx:187`) — no image
 *     preview at all. Copying that literally would ship exactly what the task asks to replace.
 *   - What Task detail genuinely previews is a PROTOTYPE, through the shared `PrototypePreview`
 *     component: a sandboxed iframe fed a host-sanitized `srcdoc`, never a URL the frame fetches.
 *   - What previews an IMAGE inline is the pin preview (`webview/pin-preview/App.tsx:38-49`), whose
 *     contract is: a thumbnail comes from a HOST-RESOLVED source, never from user text; when it does
 *     not resolve, the row still renders with its name and says `unavailable`.
 *
 * So "the same experience and components" means both of those, per artifact kind — and this module
 * produces exactly the shape each one already consumes. Nothing new was invented to render.
 *
 * Two rules the task states and this module enforces:
 *
 *   1. **A reference without a preview keeps a readable fallback.** Nothing is dropped for being
 *      unpreviewable — a task id, a URL and a deleted screenshot each render as themselves.
 *   2. **No artifact is never "validated".** This module cannot express "nothing to see here": an
 *      empty ref list yields an empty array, and an unshowable artifact carries a REASON, so the
 *      renderer says why instead of implying the evidence passed.
 *
 * Pure: every byte of content comes from an injected `load`, so all six states the task names are
 * testable without a webview, a disk, or a host.
 */
import path from "node:path";
import type { ArtifactRef } from "../tasks/types.js";

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

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"]);
const PROTOTYPE_EXTENSIONS = new Set([".html", ".htm"]);

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

function isUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

/** A ref that looks like a path — the only kind that can ever produce a preview. */
function pathLike(value: string): boolean {
  return !isUrl(value) && /[./\\]/.test(value) && !/\s/.test(value.trim()) && path.extname(value) !== "";
}

function classify(value: string): InboxArtifactKind {
  if (isUrl(value)) return "link";
  if (!pathLike(value)) return "reference";
  const ext = path.extname(value).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (PROTOTYPE_EXTENSIONS.has(ext)) return "prototype";
  return "reference";
}

/**
 * Project every ref into something showable, in order, keeping ALL of them.
 *
 * The order is the caller's (a validation's source refs first, then each round's evidence oldest
 * first), because that is the order the work happened in and it is what makes a multi-artifact item
 * navigable without opening files by hand.
 */
export function projectInboxArtifacts(
  refs: readonly ArtifactRef[],
  resolver: InboxArtifactResolver = {},
): InboxArtifactPreview[] {
  return refs.map((ref, index) => {
    const kind = classify(ref.ref);
    const base = {
      id: `artifact-${index}`,
      kind,
      name: kind === "image" || kind === "prototype" ? path.basename(ref.ref) : ref.ref,
      detail: `${ref.type} · ${ref.ref}`,
      ref,
    };

    // A link or a bare reference is not "unavailable" — it is simply not a preview. Calling it
    // unavailable would tell the human something is wrong when nothing is.
    if (kind === "link" || kind === "reference") return { ...base, available: true };

    const root = resolver.workspaceRoot;
    const absolute = root && !path.isAbsolute(ref.ref) ? path.join(root, ref.ref) : ref.ref;
    const content = resolver.load?.(absolute, kind);
    if (!content) return { ...base, available: false, reason: "not readable from this workspace" };
    if ("unavailable" in content) return { ...base, available: false, reason: content.unavailable };
    if ("image" in content) return { ...base, available: true, src: content.image };
    return { ...base, available: true, srcdoc: content.prototype };
  });
}

export interface InboxArtifactSummary {
  total: number;
  previewable: number;
  unavailable: number;
}

/**
 * What the detail route says above the artifacts.
 *
 * `total === 0` is deliberately just zero — the caller renders "nothing attached". There is no field
 * here a renderer could mistake for "checked and fine", which is the confusion the task forbids.
 */
export function summarizeInboxArtifacts(previews: readonly InboxArtifactPreview[]): InboxArtifactSummary {
  return {
    total: previews.length,
    previewable: previews.filter((p) => p.available && (p.src !== undefined || p.srcdoc !== undefined)).length,
    unavailable: previews.filter((p) => !p.available).length,
  };
}
