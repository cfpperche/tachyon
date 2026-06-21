/**
 * EOF-bounded backward line reader (spec 239 inc 2). The reusable source primitive: read the LAST N complete
 * newline-delimited records ending at a stable EOF snapshot, without reading the whole (180 MB-class) file.
 *
 * It is byte/block based and line-boundary aware: it reads fixed blocks backward, counts newlines, and only
 * ever returns COMPLETE lines. A trailing partial line at EOF (a record mid-append) is returned separately as
 * `partial` so a forward append-tail can seed its buffer with it — no gap, no dup across the snapshot.
 *
 * UTF-8 is safe: a block boundary can split a multi-byte char, but that only ever lands in the discarded
 * leading fragment (everything before the first newline when we read mid-line); kept lines start right after a
 * single-byte '\n', a guaranteed char boundary, so they decode cleanly.
 *
 * The reader, NOT the normalizer, owns offsets — the normalizer stays pure (it just consumes the lines).
 */
import * as fs from "node:fs";

export interface TailWindow {
  /** Up to `maxLines` trailing COMPLETE records, in chronological (file) order, within [startOffset, endOffset). */
  lines: string[];
  /** Trailing incomplete bytes after the last '\n' — kept as RAW BYTES (not decoded) so a snapshot landing
   *  mid-codepoint doesn't corrupt the seam; a forward append tail concatenates these bytes before decoding.
   *  Zero-length when the file ends in '\n'. */
  partial: Buffer;
  /** Byte offset where `lines[0]` begins — the cursor for paging OLDER records (inc 4). When there are no
   *  complete lines, this is the start of the trailing `partial` (preserves byte-range continuity). */
  startOffset: number;
  /** Stable EOF snapshot the window was read against — a forward append tail resumes here. */
  endOffset: number;
}

const DEFAULT_BLOCK = 64 * 1024;
const NEWLINE = 0x0a;

export interface ForwardRead {
  /** Complete lines appended in [fromOffset, endOffset). */
  lines: string[];
  /** Trailing incomplete bytes (carry into the next read) — raw, UTF-8-safe across the seam. */
  partial: Buffer;
  /** New offset (the file size that was read to). */
  endOffset: number;
}

/** Read complete lines appended since `fromOffset`, prepending `priorPartial` bytes from the previous read.
 *  Byte-based (concatenate then split on '\n' bytes, decode complete lines only) so a chunk boundary splitting
 *  a multi-byte char never corrupts a line. Returns [] + unchanged offset when nothing was appended. */
export function readForward(path: string, fromOffset: number, priorPartial: Buffer = Buffer.alloc(0)): ForwardRead {
  const fd = fs.openSync(path, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size <= fromOffset) return { lines: [], partial: priorPartial, endOffset: fromOffset };
    const buf = Buffer.alloc(size - fromOffset);
    fs.readSync(fd, buf, 0, buf.length, fromOffset);
    const chunk = Buffer.concat([priorPartial, buf]);
    const lines: string[] = [];
    let start = 0;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === NEWLINE) { lines.push(chunk.subarray(start, i).toString("utf8")); start = i + 1; }
    }
    return { lines, partial: Buffer.from(chunk.subarray(start)), endOffset: size };
  } finally {
    fs.closeSync(fd);
  }
}

/** Read the last `maxLines` complete lines of `path` up to a stable EOF snapshot. Never reads the whole file
 *  when the tail fits in a few blocks. Splits on '\n' BYTES and decodes each complete line separately, so a
 *  block boundary OR the EOF snapshot splitting a multi-byte char never corrupts a kept line or the partial. */
export function readTailWindow(path: string, maxLines: number, opts: { blockSize?: number } = {}): TailWindow {
  const blockSize = Math.max(1, opts.blockSize ?? DEFAULT_BLOCK);
  const fd = fs.openSync(path, "r");
  try {
    const endOffset = fs.fstatSync(fd).size;
    if (endOffset === 0) return { lines: [], partial: Buffer.alloc(0), startOffset: 0, endOffset: 0 };

    // Read blocks backward until we have MORE than maxLines newlines (so, after discarding the incomplete
    // leading fragment, at least maxLines complete lines remain) or we reach the start of the file.
    let pos = endOffset;
    const blocks: Buffer[] = [];
    let newlines = 0;
    while (pos > 0 && newlines <= maxLines) {
      const readSize = Math.min(blockSize, pos);
      pos -= readSize;
      const buf = Buffer.alloc(readSize);
      fs.readSync(fd, buf, 0, readSize, pos);
      blocks.unshift(buf);
      for (let i = 0; i < readSize; i++) if (buf[i] === NEWLINE) newlines++;
    }

    // Split the byte range [pos, endOffset) on '\n' BYTES — never decode across a line boundary.
    const full = Buffer.concat(blocks);
    const segments: Buffer[] = [];
    let start = 0;
    for (let i = 0; i < full.length; i++) {
      if (full[i] === NEWLINE) { segments.push(full.subarray(start, i)); start = i + 1; }
    }
    const partial = full.subarray(start); // bytes after the last '\n' — raw, possibly mid-codepoint
    let lineBufs = pos > 0 ? segments.slice(1) : segments; // started mid-line → drop the incomplete leading fragment
    lineBufs = lineBufs.slice(-maxLines);
    const lines = lineBufs.map((b) => b.toString("utf8")); // each is a COMPLETE line → decodes cleanly

    const keptBytes = lineBufs.reduce((s, b) => s + b.length, 0) + lineBufs.length /* one '\n' per kept line */;
    const tailBytes = (lineBufs.length > 0 ? keptBytes : 0) + partial.length;
    return { lines, partial: Buffer.from(partial), startOffset: endOffset - tailBytes, endOffset };
  } finally {
    fs.closeSync(fd);
  }
}
