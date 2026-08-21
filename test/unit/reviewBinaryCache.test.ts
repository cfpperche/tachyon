import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ReviewBinaryCache } from "../../apps/vscode-extension/src/webview/reviewBinaryCache.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-review-cache-test-"));
  roots.push(root);
  return root;
}

describe("t-3be62b — Review binary cache lifecycle", () => {
  it("sweeps an orphan on the next creation without deleting a live sibling", () => {
    const cache = new ReviewBinaryCache(temporaryRoot());
    const first = cache.create("ws", "agent");
    const orphan = path.join(path.dirname(first), "session-crashed");
    fs.mkdirSync(orphan);
    const second = cache.create("ws", "agent");
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(first)).toBe(true);
    expect(fs.existsSync(second)).toBe(true);
    cache.dispose(first);
    cache.dispose(second);
    expect(fs.existsSync(first)).toBe(false);
    expect(fs.existsSync(second)).toBe(false);
  });

  it("materializes an added raster file inside only its session root", async () => {
    const root = temporaryRoot();
    const cwd = path.join(root, "worktree");
    fs.mkdirSync(path.join(cwd, "evidence"), { recursive: true });
    fs.writeFileSync(path.join(cwd, "evidence", "proof.png"), Buffer.from([137, 80, 78, 71]));
    const cache = new ReviewBinaryCache(path.join(root, "cache"));
    const session = cache.create("ws", "agent");
    const asset = await cache.materialize(session, {
      cwd,
      file: { status: "A", path: "evidence/proof.png" },
      baseRef: "main",
      asWebviewUri: (local) => `webview:${local}`,
    });
    expect(asset).toEqual({ family: "raster", sides: [{ side: "current", label: "Current", uri: `webview:${path.join(session, "current", "evidence", "proof.png")}` }] });
    expect(fs.readFileSync(path.join(session, "current", "evidence", "proof.png"))).toEqual(Buffer.from([137, 80, 78, 71]));
  });

  it("leaves unsupported binaries on the existing fallback", async () => {
    const cache = new ReviewBinaryCache(temporaryRoot());
    const session = cache.create("ws", "agent");
    await expect(cache.materialize(session, {
      cwd: "/unused", file: { status: "A", path: "archive.zip" }, baseRef: "main", asWebviewUri: String,
    })).resolves.toBeUndefined();
  });
});
