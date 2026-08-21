import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ChangedFile } from "@tachyon/engine/worktree/review.js";
import type { ReviewBinaryAsset, ReviewBinaryFamily, ReviewBinarySide } from "@tachyon/webview-ui/webview/review/messages";

const execFileAsync = promisify(execFile);
export const REVIEW_CACHE_ROOT = path.join(os.tmpdir(), "tachyon-review-cache");
const SUPPORTED = new Map<string, ReviewBinaryFamily>([
  [".png", "raster"], [".jpg", "raster"], [".jpeg", "raster"], [".webp", "raster"], [".gif", "raster"],
  [".svg", "svg"], [".pdf", "pdf"], [".glb", "model"], [".gltf", "model"],
]);

function familyOf(file: string): ReviewBinaryFamily | undefined {
  return SUPPORTED.get(path.extname(file).toLowerCase());
}

function contained(root: string, relative: string): string | undefined {
  if (!relative || path.isAbsolute(relative)) return undefined;
  const target = path.resolve(root, relative);
  const prefix = `${path.resolve(root)}${path.sep}`;
  return target.startsWith(prefix) ? target : undefined;
}

async function gitBlob(cwd: string, ref: string, relative: string): Promise<Buffer> {
  const { stdout } = await execFileAsync("git", ["show", `${ref}:${relative.replaceAll(path.sep, "/")}`], {
    cwd, encoding: "buffer", maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

async function writeSide(
  cacheDir: string,
  cwd: string,
  relative: string,
  side: "base" | "current",
  ref?: string,
): Promise<string> {
  const destination = contained(path.join(cacheDir, side), relative);
  if (!destination) throw new Error(`Review asset path is outside the worktree: ${relative}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const bytes = ref ? await gitBlob(cwd, ref, relative) : fs.readFileSync(contained(cwd, relative) ?? "");
  fs.writeFileSync(destination, bytes);
  if (path.extname(relative).toLowerCase() === ".gltf") {
    let json: { buffers?: Array<{ uri?: string }>; images?: Array<{ uri?: string }> };
    try { json = JSON.parse(bytes.toString("utf8")); } catch { return destination; }
    const dependencies = [...(json.buffers ?? []), ...(json.images ?? [])]
      .map((entry) => entry.uri)
      .filter((uri): uri is string => typeof uri === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(uri));
    for (const uri of dependencies) {
      const decoded = decodeURIComponent(uri.split(/[?#]/, 1)[0]);
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relative.replaceAll(path.sep, "/")), decoded));
      const dependencyDestination = contained(path.join(cacheDir, side), dependency);
      const dependencySource = contained(cwd, dependency);
      if (!dependencyDestination || (!ref && !dependencySource)) continue;
      fs.mkdirSync(path.dirname(dependencyDestination), { recursive: true });
      fs.writeFileSync(dependencyDestination, ref ? await gitBlob(cwd, ref, dependency) : fs.readFileSync(dependencySource!));
    }
  }
  return destination;
}

/** One manager instance is one Extension Host owner. New sessions sweep only directories it does not own. */
export class ReviewBinaryCache {
  private readonly active = new Set<string>();

  constructor(private readonly root = REVIEW_CACHE_ROOT) {}

  create(project: string, identity: string): string {
    const owner = `${project}-${identity}`.replace(/[^a-z0-9._-]/gi, "-").slice(0, 160) || "review";
    const root = path.join(this.root, owner);
    fs.mkdirSync(root, { recursive: true });
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      const candidate = path.join(root, entry.name);
      if (entry.isDirectory() && !this.active.has(candidate)) fs.rmSync(candidate, { recursive: true, force: true });
    }
    const session = fs.mkdtempSync(path.join(root, "session-"));
    this.active.add(session);
    return session;
  }

  dispose(session: string): void {
    this.active.delete(session);
    fs.rmSync(session, { recursive: true, force: true });
  }

  async materialize(
    cacheDir: string,
    opts: { cwd: string; file: ChangedFile; baseRef: string; headRef?: string; asWebviewUri(path: string): string },
  ): Promise<ReviewBinaryAsset | undefined> {
    const family = familyOf(opts.file.path);
    if (!family) return undefined;
    const sides: ReviewBinarySide[] = [];
    if (opts.file.status !== "A") {
      const relative = opts.file.from ?? opts.file.path;
      const local = await writeSide(cacheDir, opts.cwd, relative, "base", opts.baseRef);
      sides.push({ side: "base", label: "Base", uri: opts.asWebviewUri(local) });
    }
    if (opts.file.status !== "D") {
      const local = await writeSide(cacheDir, opts.cwd, opts.file.path, "current", opts.headRef);
      sides.push({ side: "current", label: "Current", uri: opts.asWebviewUri(local) });
    }
    return { family, sides };
  }
}
