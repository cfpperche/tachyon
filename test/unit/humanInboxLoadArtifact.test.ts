import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  INBOX_IMAGE_MAX_BYTES,
  insideWorkspace,
  makeInboxArtifactLoader,
} from "../../src/humanInbox/loadArtifact.js";

/**
 * Human Inbox — the boundary between "a ref points at this" and "these bytes go into the webview"
 * (t-e76acc).
 *
 * An `ArtifactRef` is agent-written text. Everything here exists because inlining it is a privileged
 * act: the loader reads real files off disk and hands their contents to a panel the human is looking
 * at, so what it REFUSES is more load-bearing than what it renders.
 */
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-inbox-artifacts-"));
  roots.push(root);
  return root;
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");

describe("Human Inbox artifact loader — containment", () => {
  it("refuses a path outside the workspace instead of reading it", () => {
    const root = workspace();
    const outside = path.join(os.tmpdir(), `tachyon-inbox-outside-${process.pid}.png`);
    fs.writeFileSync(outside, PNG);
    try {
      const load = makeInboxArtifactLoader(root);
      // A validation could carry {type:"image", ref:"/home/me/.ssh/known_hosts.png"}; base64-ing that
      // into the panel is exfiltration through a preview, so the refusal is the feature.
      expect(load(outside, "image")).toEqual({ unavailable: "outside this workspace — not previewed" });
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("refuses a traversal that climbs out of the workspace", () => {
    const root = workspace();
    const load = makeInboxArtifactLoader(root);
    const climbed = path.join(root, "..", "..", "etc", "hosts.svg");
    expect(load(climbed, "image")).toEqual({ unavailable: "outside this workspace — not previewed" });
  });

  it("insideWorkspace does not treat a sibling with a shared prefix as inside", () => {
    // "/ws-secrets" must never count as inside "/ws" — string prefix alone would say it does.
    expect(insideWorkspace("/ws", "/ws/evidence/a.png")).toBe(true);
    expect(insideWorkspace("/ws", "/ws")).toBe(true);
    expect(insideWorkspace("/ws", "/ws-secrets/a.png")).toBe(false);
  });
});

describe("Human Inbox artifact loader — what it will and will not inline", () => {
  it("inlines an image as a data URI with the right mime", () => {
    const root = workspace();
    fs.mkdirSync(path.join(root, ".tachyon", "evidence"), { recursive: true });
    const file = path.join(root, ".tachyon", "evidence", "shot.png");
    fs.writeFileSync(file, PNG);
    const content = makeInboxArtifactLoader(root)(file, "image");
    expect(content).toEqual({ image: `data:image/png;base64,${PNG.toString("base64")}` });
  });

  it("says a file is missing rather than throwing", () => {
    const root = workspace();
    expect(makeInboxArtifactLoader(root)(path.join(root, "gone.png"), "image")).toEqual({ unavailable: "file not found" });
  });

  it("refuses an oversized file WITH its size, so the human can still go open it", () => {
    const root = workspace();
    const load = makeInboxArtifactLoader(root, {
      statSync: () => ({ size: INBOX_IMAGE_MAX_BYTES + 1, isFile: () => true }),
      readFileSync: () => {
        throw new Error("must not read a file it already refused");
      },
    });
    const content = load(path.join(root, "huge.png"), "image");
    expect(content).toEqual({ unavailable: expect.stringContaining("too large to preview inline") });
    // the refusal happens BEFORE the read — the budget is a budget, not a post-hoc complaint
    expect(content).toEqual({ unavailable: expect.stringContaining("MB") });
  });

  it("refuses an image extension it has no mime for, rather than guessing one", () => {
    const root = workspace();
    const file = path.join(root, "evidence.tiff");
    fs.writeFileSync(file, PNG);
    expect(makeInboxArtifactLoader(root)(file, "image")).toEqual({ unavailable: "unsupported image format" });
  });

  it("refuses a directory that happens to end in .png", () => {
    const root = workspace();
    fs.mkdirSync(path.join(root, "shots.png"));
    expect(makeInboxArtifactLoader(root)(path.join(root, "shots.png"), "image")).toEqual({ unavailable: "not a file" });
  });
});

describe("Human Inbox artifact loader — a prototype is sanitized, never linked", () => {
  it("strips scripts and injects the CSP, exactly like a task prototype", () => {
    const root = workspace();
    const file = path.join(root, "proto.html");
    fs.writeFileSync(file, "<html><head><title>p</title></head><body><h1>hi</h1><script>fetch('/steal')</script></body></html>");
    const content = makeInboxArtifactLoader(root)(file, "prototype");
    expect(content).toHaveProperty("prototype");
    const html = (content as { prototype: string }).prototype;
    // the whole point: repository HTML never executes, and never gets a URL to fetch from either —
    // it arrives as srcdoc for a sandbox="" iframe, the same contract Task detail already uses.
    expect(html).not.toContain("fetch('/steal')");
    expect(html).not.toContain("<script");
    expect(html).toContain("Content-Security-Policy");
    expect(html).toContain("script-src 'none'");
    expect(html).toContain("<h1>hi</h1>");
  });
});
