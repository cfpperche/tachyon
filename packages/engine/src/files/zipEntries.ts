/**
 * 515 — what an archive CONTAINS, without unpacking it.
 *
 * The install picker offered every `.zip` on the disk, so an app package showed up where plugins
 * install. Telling them apart needs one thing — the names inside — and a zip already carries those in
 * plaintext, in its central directory at the end of the file. So this reads the tail and the directory
 * region and nothing else: no inflating, no temp dir, and no cost proportional to the payload. A 400MB
 * archive answers as fast as a 4KB one, which is what makes it affordable to ask of every candidate a
 * bounded scan turned up.
 *
 * ## The refusals are deliberate, and they answer "unknown", not "no"
 *
 * A truncated file, a zip64 archive, a name table that does not parse — all return `undefined`, and the
 * caller treats that as *not measured* rather than as *not a plugin*. That distinction is the whole
 * reason this module returns an optional instead of an empty array: hiding a real plugin because its
 * archive was unusual would be an empty answer wearing a measured one's clothes.
 *
 * zip64 is refused rather than parsed because reaching it means an archive above 4GB or past 65535
 * entries. A plugin package is neither, and a second header format carried for a case that does not
 * occur is code no one can check against reality.
 */
import fs from "node:fs";

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
/** EOCD is 22 bytes plus a comment that the format caps at 65535. */
const EOCD_MAX = 22 + 0xffff;
const ZIP64_MARK = 0xffffffff;

/**
 * The entry names inside `file`, or `undefined` when the archive could not be read as one.
 *
 * `maxNames` bounds a hostile or generated archive: the callers only need to spot one manifest near
 * the root, so a directory with a million entries is answered from its head rather than walked whole.
 */
export function listZipEntryNames(file: string, maxNames = 4096): string[] | undefined {
  let fd: number;
  let size: number;
  try {
    size = fs.statSync(file).size;
    fd = fs.openSync(file, "r");
  } catch {
    return undefined;
  }
  try {
    const tailLength = Math.min(size, EOCD_MAX);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(fd, tail, 0, tailLength, size - tailLength);

    // Scan backwards: the EOCD is last, and its signature can also appear inside a file comment, so the
    // LAST match is the one the format means.
    let eocd = -1;
    for (let at = tail.length - 22; at >= 0; at--) {
      if (tail.readUInt32LE(at) === EOCD_SIG) { eocd = at; break; }
    }
    if (eocd < 0) return undefined;

    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    if (cdOffset === ZIP64_MARK || cdSize === ZIP64_MARK) return undefined; // zip64 — see the header
    if (cdOffset + cdSize > size) return undefined; // truncated or not a zip at all

    const cd = Buffer.alloc(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);

    const names: string[] = [];
    let at = 0;
    while (at + 46 <= cd.length && names.length < maxNames) {
      if (cd.readUInt32LE(at) !== CD_SIG) return undefined; // the directory does not parse; say so
      const nameLength = cd.readUInt16LE(at + 28);
      const extraLength = cd.readUInt16LE(at + 30);
      const commentLength = cd.readUInt16LE(at + 32);
      const end = at + 46 + nameLength;
      if (end > cd.length) return undefined;
      names.push(cd.toString("utf8", at + 46, end));
      at = end + extraLength + commentLength;
    }
    return names;
  } catch {
    return undefined;
  } finally {
    try { fs.closeSync(fd); } catch { /* the answer is already decided */ }
  }
}

/** What a Tachyon archive turned out to be. `undefined` means it could not be measured. */
export type ZipPayloadKind = "plugin" | "app";

const MANIFEST_OF: Record<ZipPayloadKind, string> = {
  plugin: "tachyon-plugin.json",
  app: "app.json",
};

/**
 * Classify an archive by the manifest it carries.
 *
 * Root or one folder deep, because "download this release" produces the second shape and the loaders
 * accept both. Deeper is not looked at: a manifest three levels down is a file that happens to be in
 * the archive, not the archive's identity.
 *
 * An archive carrying BOTH manifests is `undefined` — ambiguous, and guessing which one the human
 * meant is exactly the kind of answer this module exists to refuse.
 */
export function classifyZipPayload(names: readonly string[]): ZipPayloadKind | undefined {
  const found = (Object.keys(MANIFEST_OF) as ZipPayloadKind[]).filter((kind) => {
    const manifest = MANIFEST_OF[kind];
    return names.some((raw) => {
      const name = raw.replace(/\\/g, "/");
      const depth = name.split("/").length;
      return (depth === 1 || depth === 2) && name.endsWith(manifest) && name.split("/").pop() === manifest;
    });
  });
  return found.length === 1 ? found[0] : undefined;
}

/** Read `file` and say what kind of Tachyon archive it is, or `undefined` when that is not measurable. */
export function zipPayloadKind(file: string): ZipPayloadKind | undefined {
  const names = listZipEntryNames(file);
  return names ? classifyZipPayload(names) : undefined;
}
