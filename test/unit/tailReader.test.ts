import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readTailWindow } from "../../src/activity/tailReader.js";

const tmp: string[] = [];
function write(content: string | Buffer): string {
  const p = path.join(os.tmpdir(), `tail-${tmp.length}-${content.length}.jsonl`);
  fs.writeFileSync(p, content);
  tmp.push(p);
  return p;
}
afterEach(() => { while (tmp.length) { try { fs.unlinkSync(tmp.pop()!); } catch { /* ignore */ } } });

describe("readTailWindow (spec 239 inc 2)", () => {
  it("returns the last N complete lines in chronological order", () => {
    const p = write("l1\nl2\nl3\nl4\nl5\n");
    const w = readTailWindow(p, 2);
    expect(w.lines).toEqual(["l4", "l5"]);
    expect(w.partial.toString()).toBe(""); // file ends in '\n'
    expect(w.endOffset).toBe(fs.statSync(p).size);
  });

  it("returns ALL lines when maxLines exceeds the file's line count", () => {
    const p = write("a\nb\n");
    expect(readTailWindow(p, 100).lines).toEqual(["a", "b"]);
  });

  it("separates a trailing partial line (no final newline) for the append tail to seed", () => {
    const p = write("done1\ndone2\nhalf-writt"); // last record still being appended
    const w = readTailWindow(p, 5);
    expect(w.lines).toEqual(["done1", "done2"]); // only COMPLETE records
    expect(w.partial.toString()).toBe("half-writt"); // the incomplete tail, carried forward (as bytes)
  });

  it("startOffset points at the first returned line; endOffset = the partial start when present", () => {
    const p = write("aaa\nbbb\nccc\n"); // 12 bytes
    const w = readTailWindow(p, 2);
    expect(w.lines).toEqual(["bbb", "ccc"]);
    expect(w.startOffset).toBe(4); // "aaa\n" = 4 bytes; bbb begins at byte 4
    expect(w.endOffset).toBe(12);
  });

  it("is correct when the tail spans MULTIPLE backward blocks (block boundary mid-line)", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line-${i}-${"x".repeat(20)}`);
    const p = write(lines.join("\n") + "\n");
    const w = readTailWindow(p, 5, { blockSize: 16 }); // tiny blocks force many backward reads + mid-line splits
    expect(w.lines).toEqual(lines.slice(-5));
    expect(w.partial.toString()).toBe("");
  });

  it("decodes multi-byte UTF-8 correctly even when a block boundary splits a character", () => {
    // each line has a 4-byte emoji + 3-byte CJK; tiny blocks WILL split these mid-char
    const lines = ["a😀b", "c日本d", "e🚀f", "g中文h"];
    const p = write(lines.join("\n") + "\n");
    const w = readTailWindow(p, 3, { blockSize: 3 });
    expect(w.lines).toEqual(["c日本d", "e🚀f", "g中文h"]); // kept lines decode cleanly (start on a '\n' boundary)
  });

  it("handles a single line with no trailing newline (whole file is one partial record)", () => {
    const p = write("only-partial-no-newline");
    const w = readTailWindow(p, 5);
    expect(w.lines).toEqual([]);
    expect(w.partial.toString()).toBe("only-partial-no-newline");
    expect(w.startOffset).toBe(0);
  });

  it("handles an empty file", () => {
    const p = write("");
    const w = readTailWindow(p, 5);
    expect(w.lines).toEqual([]);
    expect(w.partial.length).toBe(0);
    expect(w).toMatchObject({ startOffset: 0, endOffset: 0 });
  });

  it("snapshot→append seam: window.partial + appended bytes reconstruct records with no gap/dup", () => {
    const p = write("r1\nr2\nr3\nr4partial"); // r4 still mid-write at snapshot
    const w = readTailWindow(p, 2);
    expect(w.lines).toEqual(["r2", "r3"]);
    expect(w.partial.toString()).toBe("r4partial");
    // simulate the forward append tail resuming at endOffset (exactly what ActivityPanel does)
    fs.appendFileSync(p, "-done\nr5\n");
    const size = fs.statSync(p).size;
    const buf = Buffer.alloc(size - w.endOffset);
    const fd = fs.openSync(p, "r"); fs.readSync(fd, buf, 0, buf.length, w.endOffset); fs.closeSync(fd);
    const lines = Buffer.concat([w.partial, buf]).toString("utf8").split("\n"); // BYTE concat then decode
    const newPartial = lines.pop();
    expect(lines).toEqual(["r4partial-done", "r5"]); // r4 completed exactly; r2/r3 not re-emitted (no dup); nothing skipped (no gap)
    expect(newPartial).toBe("");
  });

  it("EOF splitting a multi-byte char keeps the partial as raw bytes so the seam reconstructs (codex fold)", () => {
    const emoji = Buffer.from("😀", "utf8"); // 4 bytes: F0 9F 98 80
    const p = write(Buffer.concat([Buffer.from("r1\n"), emoji.subarray(0, 2)])); // snapshot lands mid-emoji
    const w = readTailWindow(p, 5);
    expect(w.lines).toEqual(["r1"]);
    expect(w.partial.equals(emoji.subarray(0, 2))).toBe(true); // RAW bytes, NOT a replacement char
    // the rest of the emoji + newline arrive — the record must reconstruct exactly
    fs.appendFileSync(p, Buffer.concat([emoji.subarray(2), Buffer.from("\n")]));
    const size = fs.statSync(p).size;
    const buf = Buffer.alloc(size - w.endOffset);
    const fd = fs.openSync(p, "r"); fs.readSync(fd, buf, 0, buf.length, w.endOffset); fs.closeSync(fd);
    const reconstructed = Buffer.concat([w.partial, buf]).toString("utf8").split("\n");
    expect(reconstructed[0]).toBe("😀"); // no � — the multi-byte char survived the seam
  });
});
