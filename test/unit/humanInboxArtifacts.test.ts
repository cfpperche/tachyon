import { describe, expect, it } from "vitest";
import {
  projectInboxArtifacts,
  summarizeInboxArtifacts,
  type InboxArtifactContent,
} from "../../src/humanInbox/artifacts.js";
import type { ArtifactRef } from "../../src/tasks/types.js";

/**
 * Human Inbox — the artifact states the detail route has to survive (t-e76acc).
 *
 * The task names them: no artifacts, one image, several images, a prototype, an invalid/unavailable
 * reference, and a narrow viewport. Five of the six are data questions and live here; the narrow
 * viewport is layout and is measured in the browser harness.
 *
 * The rule underneath all of them: a reference that cannot be previewed must still READ, and nothing
 * may let "no artifact" look like "evidence checked".
 */
const ROOT = "/ws";
/** stands in for the host loader: reads a file, or says why it cannot. */
const load = (absolutePath: string, kind: "image" | "prototype"): InboxArtifactContent | undefined => {
  if (absolutePath.includes("missing")) return { unavailable: "file not found" };
  if (absolutePath.includes("huge")) return { unavailable: "too large to preview inline (12.0 MB)" };
  if (absolutePath.includes("unreadable")) return undefined;
  return kind === "image" ? { image: `data:image/png;base64,#${absolutePath}` } : { prototype: `<p>${absolutePath}</p>` };
};
const resolver = { workspaceRoot: ROOT, load };
const ref = (type: string, value: string): ArtifactRef => ({ type, ref: value });

describe("Human Inbox artifacts — what can be shown", () => {
  it("previews a single image from a host-loaded source", () => {
    const [image] = projectInboxArtifacts([ref("image", ".tachyon/evidence/shot.png")], resolver);
    expect(image.kind).toBe("image");
    expect(image.name).toBe("shot.png");
    expect(image.available).toBe(true);
    expect(image.src).toBe("data:image/png;base64,#/ws/.tachyon/evidence/shot.png");
    // never a srcdoc for an image — the two preview paths are not interchangeable
    expect(image.srcdoc).toBeUndefined();
    // the ref travels with it, so a detail route can copy/deep-link without re-deriving anything
    expect(image.ref).toEqual({ type: "image", ref: ".tachyon/evidence/shot.png" });
  });

  it("keeps several images distinct and in order, so they can be stepped through", () => {
    const previews = projectInboxArtifacts(
      [ref("image", "a/one.png"), ref("image", "b/two.jpeg"), ref("screenshot", "c/three.webp")],
      resolver,
    );
    expect(previews.map((p) => p.name)).toEqual(["one.png", "two.jpeg", "three.webp"]);
    expect(new Set(previews.map((p) => p.id)).size).toBe(3);
    expect(previews.every((p) => p.available && p.src)).toBe(true);
    expect(summarizeInboxArtifacts(previews)).toEqual({ total: 3, previewable: 3, unavailable: 0 });
  });

  it("hands an HTML prototype to the srcdoc path, never to the image one", () => {
    // the sandboxed-iframe contract Task detail's PrototypePreview already uses: the host sanitizes
    // and hands over HTML, the page never points a frame at a file it fetches itself.
    const [proto] = projectInboxArtifacts([ref("prototype", ".tachyon/prototypes/p.html")], resolver);
    expect(proto.kind).toBe("prototype");
    expect(proto.available).toBe(true);
    expect(proto.srcdoc).toContain("p.html");
    expect(proto.src).toBeUndefined();
  });

  it("recognizes every image extension the product actually writes", () => {
    const previews = projectInboxArtifacts(
      [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"].map((ext) => ref("image", `e/x${ext}`)),
      resolver,
    );
    expect(previews.every((p) => p.kind === "image")).toBe(true);
  });
});

describe("Human Inbox artifacts — what cannot be shown still reads", () => {
  it("keeps a missing file, with the host's own reason, instead of dropping it", () => {
    const [gone] = projectInboxArtifacts([ref("image", "evidence/missing.png")], resolver);
    expect(gone.available).toBe(false);
    expect(gone.reason).toBe("file not found");
    expect(gone.name).toBe("missing.png"); // still named, still listed
    expect(gone.src).toBeUndefined();
    expect(summarizeInboxArtifacts([gone])).toEqual({ total: 1, previewable: 0, unavailable: 1 });
  });

  it("passes a size refusal through in the host's words, not as a generic failure", () => {
    // "the evidence is gone" and "this one is too big to inline" send a human to different places;
    // flattening both into one message would hide which.
    const [huge] = projectInboxArtifacts([ref("screenshot", "evidence/huge.png")], resolver);
    expect(huge.available).toBe(false);
    expect(huge.reason).toBe("too large to preview inline (12.0 MB)");
  });

  it("does NOT call a link or a plain reference unavailable — they are simply not previews", () => {
    const previews = projectInboxArtifacts(
      [ref("url", "https://example.test/run/1"), ref("task", "t-e76acc"), ref("commit", "2577d527")],
      resolver,
    );
    expect(previews.map((p) => p.kind)).toEqual(["link", "reference", "reference"]);
    // marking these "unavailable" would tell the human something is broken when nothing is
    expect(previews.every((p) => p.available)).toBe(true);
    expect(previews.every((p) => p.src === undefined && p.srcdoc === undefined)).toBe(true);
    expect(previews.map((p) => p.detail)).toEqual([
      "url · https://example.test/run/1",
      "task · t-e76acc",
      "commit · 2577d527",
    ]);
    expect(summarizeInboxArtifacts(previews)).toEqual({ total: 3, previewable: 0, unavailable: 0 });
  });

  it("reports nothing attached as plain zero — never as a checked state", () => {
    const summary = summarizeInboxArtifacts(projectInboxArtifacts([], resolver));
    expect(summary).toEqual({ total: 0, previewable: 0, unavailable: 0 });
    // there is no field here a renderer could read as "validated"
    expect(Object.keys(summary).sort()).toEqual(["previewable", "total", "unavailable"]);
  });

  it("survives a resolver that knows nothing, without inventing availability", () => {
    // The headless path has no loader at all: every path-like ref degrades to unavailable-with-reason
    // rather than to a broken <img>.
    const [image] = projectInboxArtifacts([ref("image", "e/x.png")], {});
    expect(image.available).toBe(false);
    expect(image.reason).toBe("not readable from this workspace");
  });

  it("takes an absolute ref as-is rather than nesting it under the workspace root", () => {
    const [abs] = projectInboxArtifacts([ref("image", "/tmp/evidence/abs.png")], resolver);
    expect(abs.src).toBe("data:image/png;base64,#/tmp/evidence/abs.png");
  });
});
