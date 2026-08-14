import fs from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { containsUnsafeFramingCharacter } from "./framingSafety.js";

/** Explicit, project-owned onboarding sources declared in tachyon.yml. */
export interface ProjectGuidanceSettings {
  files: string[];
}

export interface LoadedProjectGuidanceFile {
  /** Normalized POSIX-relative path as declared by the project. */
  sourcePath: string;
  /** Strictly decoded UTF-8 content. No newline or whitespace normalization is applied. */
  content: string;
}

export interface RenderedProjectGuidanceBundle {
  body: string;
  sourceCount: number;
}

export const PROJECT_GUIDANCE_MAX_FILES = 8;
export const PROJECT_GUIDANCE_MAX_PATH_BYTES = 256;
export const PROJECT_GUIDANCE_MAX_FILE_BYTES = 64 * 1024;
export const PROJECT_GUIDANCE_MAX_TOTAL_BYTES = 64 * 1024;

export const PROJECT_GUIDANCE_START = "── PROJECT GUIDANCE (PROJECT-OWNED) ──";
export const PROJECT_GUIDANCE_END = "── END PROJECT GUIDANCE ──";

const WINDOWS_DRIVE_RE = /^[a-zA-Z]:/;

/**
 * Return a human-readable reason when a normalized value is not a conservative
 * POSIX-relative project-guidance path. The config parser trims only the outer
 * whitespace before calling this validator; spaces and Unicode inside segments
 * remain valid.
 */
export function projectGuidancePathError(sourcePath: string): string | undefined {
  if (sourcePath.length === 0) return "must be a non-empty workspace-relative path";
  if (sourcePath !== sourcePath.trim()) return "must not contain leading or trailing whitespace";
  if (Buffer.byteLength(sourcePath, "utf8") > PROJECT_GUIDANCE_MAX_PATH_BYTES) {
    return `must be at most ${PROJECT_GUIDANCE_MAX_PATH_BYTES} UTF-8 bytes`;
  }
  if (containsUnsafeFramingCharacter(sourcePath)) return "must not contain control characters";
  if (sourcePath.includes("\\")) return "must use POSIX '/' separators (backslashes are not allowed)";
  if (path.posix.isAbsolute(sourcePath) || WINDOWS_DRIVE_RE.test(sourcePath)) {
    return "must be workspace-relative (absolute and drive-letter paths are not allowed)";
  }

  const segments = sourcePath.split("/");
  if (segments.some((segment) => WINDOWS_DRIVE_RE.test(segment))) {
    return "must not contain Windows drive-relative path segments";
  }
  if (segments.some((segment) => segment.length === 0)) {
    return "must not contain empty path segments or a trailing slash";
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return "must not contain '.' or '..' path segments";
  }
  return undefined;
}

function settingsPaths(settings: ProjectGuidanceSettings): string[] {
  const files = (settings as { files?: unknown })?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("settings.projectGuidance.files must be a non-empty list");
  }
  if (files.length > PROJECT_GUIDANCE_MAX_FILES) {
    throw new Error(`settings.projectGuidance.files must contain at most ${PROJECT_GUIDANCE_MAX_FILES} paths`);
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < files.length; index++) {
    const raw = files[index];
    if (typeof raw !== "string") {
      throw new Error(`settings.projectGuidance.files[${index}] must be a path string`);
    }
    // Spaces at the edges are config formatting, but control characters are
    // never path syntax and must not disappear through trim().
    if (containsUnsafeFramingCharacter(raw)) {
      throw new Error(`settings.projectGuidance.files[${index}] must not contain control characters`);
    }
    const sourcePath = raw.trim();
    const reason = projectGuidancePathError(sourcePath);
    if (reason) throw new Error(`settings.projectGuidance.files[${index}] (${JSON.stringify(sourcePath)}): ${reason}`);
    if (seen.has(sourcePath)) {
      throw new Error(`settings.projectGuidance.files[${index}] duplicates ${JSON.stringify(sourcePath)}`);
    }
    seen.add(sourcePath);
    normalized.push(sourcePath);
  }
  return normalized;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sourceError(sourcePath: string, detail: string): Error {
  return new Error(`project guidance source ${JSON.stringify(sourcePath)}: ${detail}`);
}

function canonicalWorkspaceRoot(workspaceRoot: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync.native(workspaceRoot);
  } catch (error) {
    throw new Error(`cannot resolve project-guidance workspace root ${JSON.stringify(workspaceRoot)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(canonical);
  } catch (error) {
    throw new Error(`cannot inspect project-guidance workspace root ${JSON.stringify(workspaceRoot)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stat.isDirectory()) throw new Error(`project-guidance workspace root ${JSON.stringify(workspaceRoot)} is not a directory`);
  return canonical;
}

function readBoundedFile(fd: number, sourcePath: string, aggregateRemaining: number): Buffer {
  const allowed = Math.min(PROJECT_GUIDANCE_MAX_FILE_BYTES, aggregateRemaining);
  // One extra byte distinguishes an exact-limit file from a file that grew
  // after fstat. The allocation remains bounded at 64 KiB + 1.
  const buffer = Buffer.allocUnsafe(allowed + 1);
  let offset = 0;
  try {
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
  } catch (error) {
    throw sourceError(sourcePath, `cannot read through its validated descriptor: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (offset > PROJECT_GUIDANCE_MAX_FILE_BYTES) {
    throw sourceError(sourcePath, `exceeds the ${PROJECT_GUIDANCE_MAX_FILE_BYTES}-byte per-file limit`);
  }
  if (offset > aggregateRemaining) {
    throw sourceError(sourcePath, `would exceed the ${PROJECT_GUIDANCE_MAX_TOTAL_BYTES}-byte aggregate limit`);
  }
  return buffer.subarray(0, offset);
}

function loadOne(root: string, sourcePath: string, aggregateRemaining: number): { file: LoadedProjectGuidanceFile; bytes: number } {
  const lexical = path.resolve(root, ...sourcePath.split("/"));
  if (!isContained(root, lexical) || lexical === root) {
    throw sourceError(sourcePath, "resolves outside the workspace");
  }

  let canonicalParent: string;
  try {
    canonicalParent = fs.realpathSync.native(path.dirname(lexical));
  } catch (error) {
    throw sourceError(sourcePath, `cannot resolve its parent directory: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isContained(root, canonicalParent)) {
    throw sourceError(sourcePath, "has a parent directory that resolves outside the workspace");
  }

  const candidate = path.join(canonicalParent, path.basename(lexical));
  let beforeOpen: fs.Stats;
  try {
    beforeOpen = fs.lstatSync(candidate);
  } catch (error) {
    throw sourceError(sourcePath, `cannot inspect the declared file: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (beforeOpen.isSymbolicLink()) throw sourceError(sourcePath, "must not be a symbolic-link leaf");
  if (!beforeOpen.isFile()) throw sourceError(sourcePath, "must be a regular file");
  if (beforeOpen.size > PROJECT_GUIDANCE_MAX_FILE_BYTES) {
    throw sourceError(sourcePath, `exceeds the ${PROJECT_GUIDANCE_MAX_FILE_BYTES}-byte per-file limit`);
  }
  if (beforeOpen.size > aggregateRemaining) {
    throw sourceError(sourcePath, `would exceed the ${PROJECT_GUIDANCE_MAX_TOTAL_BYTES}-byte aggregate limit`);
  }

  let fd: number;
  try {
    // O_NONBLOCK prevents a raced replacement with a FIFO/device from hanging
    // before fstat; it has no effect on ordinary regular-file reads. Some platforms do not expose
    // O_NOFOLLOW/O_NONBLOCK, so feature-detect them and retain the lstat + post-open identity checks
    // as the portable fallback rather than relying on an undefined bitwise operand.
    const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
    const nonBlock = typeof fs.constants.O_NONBLOCK === "number" ? fs.constants.O_NONBLOCK : 0;
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow | nonBlock);
  } catch (error) {
    throw sourceError(sourcePath, `cannot open with no-follow protection: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw sourceError(sourcePath, "must remain a regular file when opened");
    if (opened.dev !== beforeOpen.dev || opened.ino !== beforeOpen.ino) {
      throw sourceError(sourcePath, "changed while it was being opened");
    }
    if (opened.size > PROJECT_GUIDANCE_MAX_FILE_BYTES) {
      throw sourceError(sourcePath, `exceeds the ${PROJECT_GUIDANCE_MAX_FILE_BYTES}-byte per-file limit`);
    }
    if (opened.size > aggregateRemaining) {
      throw sourceError(sourcePath, `would exceed the ${PROJECT_GUIDANCE_MAX_TOTAL_BYTES}-byte aggregate limit`);
    }

    // Re-resolve after opening and compare the path identity to the descriptor.
    // This makes canonical containment and the no-follow descriptor refer to
    // the same file instead of trusting a pre-open pathname check alone.
    let canonicalOpenedPath: string;
    let pathStat: fs.Stats;
    try {
      canonicalOpenedPath = fs.realpathSync.native(candidate);
      pathStat = fs.statSync(canonicalOpenedPath);
    } catch (error) {
      throw sourceError(sourcePath, `changed while its canonical path was validated: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isContained(root, canonicalOpenedPath)) throw sourceError(sourcePath, "resolves outside the workspace");
    if (pathStat.dev !== opened.dev || pathStat.ino !== opened.ino) {
      throw sourceError(sourcePath, "changed while its canonical path was validated");
    }

    const bytes = readBoundedFile(fd, sourcePath, aggregateRemaining);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw sourceError(sourcePath, "must contain valid UTF-8");
    }
    if (content.includes("\0")) throw sourceError(sourcePath, "must not contain NUL characters");
    return { file: { sourcePath, content }, bytes: bytes.length };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read every configured source from the canonical workspace. Nothing is cached:
 * each injection observes current, workspace-local content. A failure throws
 * before a loaded set is returned, so callers cannot render a partial block.
 */
export function loadProjectGuidance(workspaceRoot: string, settings: ProjectGuidanceSettings): LoadedProjectGuidanceFile[] {
  const sourcePaths = settingsPaths(settings);
  const root = canonicalWorkspaceRoot(workspaceRoot);
  const loaded: LoadedProjectGuidanceFile[] = [];
  let totalBytes = 0;
  for (const sourcePath of sourcePaths) {
    const result = loadOne(root, sourcePath, PROJECT_GUIDANCE_MAX_TOTAL_BYTES - totalBytes);
    totalBytes += result.bytes;
    loaded.push(result.file);
  }
  return loaded;
}

/** Render one provenance-labelled project-owned block without rewriting source content. */
export function renderProjectGuidance(files: readonly LoadedProjectGuidanceFile[]): string {
  if (files.length === 0) throw new Error("cannot render an empty project-guidance file list");
  let rendered = `${PROJECT_GUIDANCE_START}\n`;
  for (const file of files) {
    rendered += `Source: ${file.sourcePath}\n`;
    rendered += file.content;
    if (!file.content.endsWith("\n")) rendered += "\n";
  }
  return `${rendered}${PROJECT_GUIDANCE_END}`;
}

/** Load and render when a project explicitly opts in; absent settings emit no block. */
export function loadAndRenderProjectGuidanceBundle(
  workspaceRoot: string,
  settings?: ProjectGuidanceSettings,
): RenderedProjectGuidanceBundle | undefined {
  if (!settings) return undefined;
  const files = loadProjectGuidance(workspaceRoot, settings);
  return { body: renderProjectGuidance(files), sourceCount: files.length };
}

/** Compatibility renderer for callers that need only the project-owned body. */
export function loadAndRenderProjectGuidance(workspaceRoot: string, settings?: ProjectGuidanceSettings): string | undefined {
  return loadAndRenderProjectGuidanceBundle(workspaceRoot, settings)?.body;
}
