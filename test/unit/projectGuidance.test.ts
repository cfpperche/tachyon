import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROJECT_GUIDANCE_END,
  PROJECT_GUIDANCE_MAX_FILE_BYTES,
  PROJECT_GUIDANCE_MAX_FILES,
  PROJECT_GUIDANCE_MAX_TOTAL_BYTES,
  PROJECT_GUIDANCE_START,
  loadAndRenderProjectGuidance,
  loadProjectGuidance,
  projectGuidancePathError,
  renderProjectGuidance,
} from "../../src/config/projectGuidance.js";

const roots: string[] = [];

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-project-guidance-"));
  roots.push(root);
  return root;
}

function write(root: string, relative: string, content: string | Buffer): string {
  const absolute = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  return absolute;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("projectGuidancePathError", () => {
  it("accepts conservative POSIX-relative Unicode paths and spaces inside segments", () => {
    expect(projectGuidancePathError("docs/regras do projeto/ação.md")).toBeUndefined();
  });

  it.each([
    ["", "non-empty"],
    ["/etc/passwd", "workspace-relative"],
    ["C:/outside.md", "workspace-relative"],
    ["docs/C:../outside.md", "drive-relative"],
    ["docs/C:/outside.md", "drive-relative"],
    ["docs\\outside.md", "backslashes"],
    ["../outside.md", "'..'"],
    ["docs/../outside.md", "'..'"],
    ["./guide.md", "'.'"],
    ["docs//guide.md", "empty path segments"],
    ["docs/", "trailing slash"],
    ["docs/\0guide.md", "control characters"],
    ["docs/guide\u009b.md", "control characters"],
    ["docs/guide\u2028spoof.md", "control characters"],
    [" docs/guide.md ", "leading or trailing"],
    [`docs/${"é".repeat(130)}.md`, "256 UTF-8 bytes"],
  ])("rejects %j", (sourcePath, expected) => {
    expect(projectGuidancePathError(sourcePath)).toContain(expected);
  });
});

describe("loadProjectGuidance", () => {
  it("loads configured files in order and render labels sources outside verbatim content", () => {
    const root = workspace();
    write(root, "docs/regras do projeto.md", "primeira\r\nlinha\n");
    write(root, "docs/ação.md", "segunda sem newline");

    const loaded = loadProjectGuidance(root, { files: ["docs/regras do projeto.md", "docs/ação.md"] });
    expect(loaded).toEqual([
      { sourcePath: "docs/regras do projeto.md", content: "primeira\r\nlinha\n" },
      { sourcePath: "docs/ação.md", content: "segunda sem newline" },
    ]);
    expect(renderProjectGuidance(loaded)).toBe(
      `${PROJECT_GUIDANCE_START}\n` +
        "Source: docs/regras do projeto.md\n" +
        "primeira\r\nlinha\n" +
        "Source: docs/ação.md\n" +
        "segunda sem newline\n" +
        PROJECT_GUIDANCE_END,
    );
  });

  it("trims only configured path edges and preserves a UTF-8 BOM in content", () => {
    const root = workspace();
    write(root, "docs/guia com espaço.md", Buffer.from([0xef, 0xbb, 0xbf, 0x41]));
    expect(loadProjectGuidance(root, { files: ["  docs/guia com espaço.md  "] })).toEqual([
      { sourcePath: "docs/guia com espaço.md", content: "\uFEFFA" },
    ]);
  });

  it("reads on every call without leaking or caching another workspace's content", () => {
    const first = workspace();
    const second = workspace();
    write(first, "docs/guide.md", "first-v1");
    write(second, "docs/guide.md", "second");
    const settings = { files: ["docs/guide.md"] };

    expect(loadProjectGuidance(first, settings)[0].content).toBe("first-v1");
    expect(loadProjectGuidance(second, settings)[0].content).toBe("second");
    write(first, "docs/guide.md", "first-v2");
    expect(loadProjectGuidance(first, settings)[0].content).toBe("first-v2");
    expect(loadProjectGuidance(second, settings)[0].content).toBe("second");
    expect(loadAndRenderProjectGuidance(first, undefined)).toBeUndefined();
  });

  it("rejects malformed direct settings before touching sources", () => {
    const root = workspace();
    expect(() => loadProjectGuidance(root, { files: [] })).toThrow(/non-empty list/);
    expect(() => loadProjectGuidance(root, { files: Array.from({ length: PROJECT_GUIDANCE_MAX_FILES + 1 }, (_, index) => `docs/${index}.md`) })).toThrow(
      /at most 8 paths/,
    );
    expect(() => loadProjectGuidance(root, { files: ["docs/a.md", " docs/a.md "] })).toThrow(/duplicates/);
    expect(() => loadProjectGuidance(root, { files: ["../outside.md"] })).toThrow(/'\.\.'/);
  });

  it("fails with the declared source when a file is missing or non-regular", () => {
    const root = workspace();
    fs.mkdirSync(path.join(root, "docs", "folder"), { recursive: true });
    expect(() => loadProjectGuidance(root, { files: ["docs/missing.md"] })).toThrow(/missing\.md.*cannot inspect/);
    expect(() => loadProjectGuidance(root, { files: ["docs/folder"] })).toThrow(/docs\/folder.*regular file/);
  });

  it("rejects symbolic-link leaves and parent links that escape the canonical workspace", () => {
    if (process.platform === "win32") return;
    const root = workspace();
    const outside = workspace();
    const target = write(root, "docs/real.md", "inside");
    fs.symlinkSync(target, path.join(root, "docs", "leaf.md"));
    write(outside, "outside.md", "outside");
    fs.symlinkSync(outside, path.join(root, "escaped"), "dir");

    expect(() => loadProjectGuidance(root, { files: ["docs/leaf.md"] })).toThrow(/symbolic-link leaf/);
    expect(() => loadProjectGuidance(root, { files: ["escaped/outside.md"] })).toThrow(/parent directory.*outside/);
  });

  it("allows a parent symlink only when its canonical target remains in the workspace", () => {
    if (process.platform === "win32") return;
    const root = workspace();
    write(root, "real/guide.md", "inside");
    fs.symlinkSync(path.join(root, "real"), path.join(root, "linked"), "dir");
    expect(loadProjectGuidance(root, { files: ["linked/guide.md"] })).toEqual([
      { sourcePath: "linked/guide.md", content: "inside" },
    ]);
  });

  it("rejects unreadable files at the protected descriptor open", () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const root = workspace();
    const file = write(root, "docs/private.md", "private");
    fs.chmodSync(file, 0o000);
    try {
      expect(() => loadProjectGuidance(root, { files: ["docs/private.md"] })).toThrow(/private\.md.*cannot open/);
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  it("rejects invalid UTF-8 and NUL content", () => {
    const root = workspace();
    write(root, "docs/invalid.md", Buffer.from([0xc3, 0x28]));
    write(root, "docs/nul.md", Buffer.from("before\0after", "utf8"));
    expect(() => loadProjectGuidance(root, { files: ["docs/invalid.md"] })).toThrow(/invalid\.md.*valid UTF-8/);
    expect(() => loadProjectGuidance(root, { files: ["docs/nul.md"] })).toThrow(/nul\.md.*NUL/);
  });

  it("enforces per-file and aggregate byte limits while accepting the exact limit", () => {
    const root = workspace();
    write(root, "docs/exact.md", Buffer.alloc(PROJECT_GUIDANCE_MAX_FILE_BYTES, 0x61));
    expect(loadProjectGuidance(root, { files: ["docs/exact.md"] })[0].content.length).toBe(PROJECT_GUIDANCE_MAX_FILE_BYTES);

    write(root, "docs/too-large.md", Buffer.alloc(PROJECT_GUIDANCE_MAX_FILE_BYTES + 1, 0x61));
    expect(() => loadProjectGuidance(root, { files: ["docs/too-large.md"] })).toThrow(/per-file limit/);

    const halfPlusOne = PROJECT_GUIDANCE_MAX_TOTAL_BYTES / 2 + 1;
    write(root, "docs/first.md", Buffer.alloc(halfPlusOne, 0x61));
    write(root, "docs/second.md", Buffer.alloc(halfPlusOne, 0x62));
    expect(() => loadProjectGuidance(root, { files: ["docs/first.md", "docs/second.md"] })).toThrow(/second\.md.*aggregate limit/);
  });

  it("does not return a partial result when a later declared source is invalid", () => {
    const root = workspace();
    write(root, "docs/valid.md", "valid");
    expect(() => loadProjectGuidance(root, { files: ["docs/valid.md", "docs/missing.md"] })).toThrow(/missing\.md/);
  });
});

describe("renderProjectGuidance", () => {
  it("refuses to create delimiters without a configured source", () => {
    expect(() => renderProjectGuidance([])).toThrow(/empty project-guidance/);
  });
});
