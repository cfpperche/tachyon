import type { InboxArtifactKind, InboxArtifactPreview, InboxArtifactResolver, InboxArtifactSummary } from "@tachyon/engine/humanInbox/artifactTypes.js";
export type { InboxArtifactKind, InboxArtifactContent, InboxArtifactPreview, InboxArtifactResolver, InboxArtifactSummary } from "@tachyon/engine/humanInbox/artifactTypes.js";
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
import type { ArtifactRef } from "@tachyon/shared/tasks/types.js";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"]);
const PROTOTYPE_EXTENSIONS = new Set([".html", ".htm"]);

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
