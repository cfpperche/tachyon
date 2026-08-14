import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  paneTranscriptDir,
  paneTranscriptPath,
  paneTranscriptExists,
  ensurePaneTranscriptFile,
  removePaneTranscript,
  rotatePaneTranscriptIfNeeded,
  readPaneTranscript,
  PANE_TRANSCRIPT_MAX_BYTES,
  PANE_TRANSCRIPT_RETAIN_BYTES,
} from "@tachyon/engine/agents/paneTranscript.js";

describe("paneTranscript (t-6a6a00 — durable per-agent pane transcripts)", () => {
  let ws: string;

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-pane-transcript-"));
  });

  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it("paneTranscriptPath is namespaced under .tachyon/pane-transcripts/<agent>.log", () => {
    expect(paneTranscriptPath(ws, "worker")).toBe(path.join(ws, ".tachyon", "pane-transcripts", "worker.log"));
    expect(paneTranscriptDir(ws)).toBe(path.join(ws, ".tachyon", "pane-transcripts"));
  });

  it("ensurePaneTranscriptFile creates dir 0700 and file 0600, and is idempotent", () => {
    const file = ensurePaneTranscriptFile(ws, "worker");
    expect(fs.existsSync(file)).toBe(true);
    const dirMode = fs.statSync(paneTranscriptDir(ws)).mode & 0o777;
    const fileMode = fs.statSync(file).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);

    // idempotent + preserves existing content (a restart must not truncate the durable log)
    fs.writeFileSync(file, "hello\n", "utf8");
    const file2 = ensurePaneTranscriptFile(ws, "worker");
    expect(file2).toBe(file);
    expect(fs.readFileSync(file, "utf8")).toBe("hello\n");
  });

  it("paneTranscriptExists reflects presence without creating anything", () => {
    expect(paneTranscriptExists(ws, "worker")).toBe(false);
    ensurePaneTranscriptFile(ws, "worker");
    expect(paneTranscriptExists(ws, "worker")).toBe(true);
  });

  it("removePaneTranscript deletes the file and is idempotent (missing file / missing dir)", () => {
    const file = ensurePaneTranscriptFile(ws, "worker");
    expect(fs.existsSync(file)).toBe(true);
    removePaneTranscript(ws, "worker");
    expect(fs.existsSync(file)).toBe(false);
    expect(() => removePaneTranscript(ws, "worker")).not.toThrow();
    expect(() => removePaneTranscript(ws, "never-existed")).not.toThrow();
  });

  it("rotatePaneTranscriptIfNeeded is a no-op under the byte cap", () => {
    const file = ensurePaneTranscriptFile(ws, "worker");
    fs.writeFileSync(file, "small content\n", "utf8");
    rotatePaneTranscriptIfNeeded(file, PANE_TRANSCRIPT_MAX_BYTES, PANE_TRANSCRIPT_RETAIN_BYTES);
    expect(fs.readFileSync(file, "utf8")).toBe("small content\n");
  });

  it("rotatePaneTranscriptIfNeeded truncates-with-marker, keeping only the tail, once over the cap", () => {
    const file = ensurePaneTranscriptFile(ws, "worker");
    const maxBytes = 1000;
    const retainBytes = 200;
    // distinct filler, sized well past maxBytes so rotation definitely triggers
    const filler = "A".repeat(maxBytes + 50);
    const tail = "TAIL-MARKER-CONTENT";
    fs.writeFileSync(file, filler + tail, "utf8");
    rotatePaneTranscriptIfNeeded(file, maxBytes, retainBytes);
    const after = fs.readFileSync(file, "utf8");
    expect(after).toContain("rotated");
    expect(after).toContain(tail);
    expect(after).not.toContain(filler);
    expect(Buffer.byteLength(after, "utf8")).toBeLessThan(maxBytes);
  });

  it("rotation happens IN PLACE (same inode) so a concurrently open append-mode writer keeps writing to the same path", () => {
    const file = ensurePaneTranscriptFile(ws, "worker");
    const maxBytes = 500;
    const retainBytes = 100;
    fs.writeFileSync(file, "X".repeat(maxBytes + 1), "utf8");
    const inodeBefore = fs.statSync(file).ino;

    // Simulate tmux's pipe-pane `cat >> file`: an fd opened in append mode BEFORE rotation.
    const writerFd = fs.openSync(file, "a");
    try {
      rotatePaneTranscriptIfNeeded(file, maxBytes, retainBytes);
      expect(fs.statSync(file).ino).toBe(inodeBefore); // truncated in place, not replaced

      fs.writeSync(writerFd, "AFTER-ROTATION\n");
      const finalContent = fs.readFileSync(file, "utf8");
      expect(finalContent).toContain("AFTER-ROTATION");
    } finally {
      fs.closeSync(writerFd);
    }
  });

  it("readPaneTranscript returns undefined when no transcript exists yet", () => {
    expect(readPaneTranscript(ws, "never-spawned")).toBeUndefined();
  });

  it("readPaneTranscript returns undefined for an empty (just-created) transcript", () => {
    ensurePaneTranscriptFile(ws, "worker");
    expect(readPaneTranscript(ws, "worker")).toBeUndefined();
  });

  it("readPaneTranscript strips ANSI escapes from the raw pty stream", () => {
    const file = ensurePaneTranscriptFile(ws, "worker");
    fs.writeFileSync(file, "\x1b[31mred text\x1b[0m plain\nsecond line\n", "utf8");
    const result = readPaneTranscript(ws, "worker");
    expect(result?.text).toBe("red text plain\nsecond line");
  });

  it("readPaneTranscript redacts known secrets and Bridge-token-shaped patterns (SECURITY: read-time only)", () => {
    const file = ensurePaneTranscriptFile(ws, "worker");
    const secret = "s".repeat(40);
    fs.writeFileSync(file, `echo ${secret}\nTACHYON_BRIDGE_TOKEN=${secret}\n`, "utf8");
    const result = readPaneTranscript(ws, "worker", { knownSecrets: [secret] });
    expect(result?.text).not.toContain(secret);
    expect(result?.text).toContain("[redacted]");

    // the ON-DISK file itself is never mutated by a read — redaction is read-time only
    expect(fs.readFileSync(file, "utf8")).toContain(secret);
  });

  it("readPaneTranscript applies a tail bound (maxLines/maxBytes) and reports truncation", () => {
    const file = ensurePaneTranscriptFile(ws, "worker");
    const lines = Array.from({ length: 10 }, (_, i) => `line-${i}`);
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
    const result = readPaneTranscript(ws, "worker", { maxLines: 3 });
    expect(result?.truncated).toBe(true);
    expect(result?.text.split("\n")).toEqual(["line-7", "line-8", "line-9"]);
  });

  it("readPaneTranscript rotates an oversized file before reading, so callers never read unbounded content", () => {
    const file = ensurePaneTranscriptFile(ws, "worker");
    fs.writeFileSync(file, "Z".repeat(PANE_TRANSCRIPT_MAX_BYTES + 1), "utf8");
    const result = readPaneTranscript(ws, "worker", { maxBytes: PANE_TRANSCRIPT_MAX_BYTES });
    expect(result).toBeDefined();
    expect(Buffer.byteLength(fs.readFileSync(file, "utf8"), "utf8")).toBeLessThanOrEqual(PANE_TRANSCRIPT_MAX_BYTES);
  });
});
