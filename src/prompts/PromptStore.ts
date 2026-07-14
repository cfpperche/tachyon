/**
 * spec 381 — operator prompt templates under `.tachyon/prompts/<id>.md`.
 *
 * Workspace-local human macros injected mid-session into an agent composer.
 * Not tachyon.yml, not role contracts, not shell commands.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

/** Same name spirit as agents/commands (loadConfig NAME_RE). */
export const PROMPT_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export interface PromptTemplate {
  id: string;
  /** Display label — frontmatter title when set, else id. */
  title: string;
  /** Exact text staged/submitted into the composer. */
  body: string;
  /** Absolute path of the source file. */
  path: string;
}

export interface SkippedPrompt {
  file: string;
  reason: string;
}

export interface PromptLibrary {
  templates: PromptTemplate[];
  skipped: SkippedPrompt[];
}

export class PromptStore {
  constructor(private readonly workspaceRoot: string) {}

  get dir(): string {
    return path.join(this.workspaceRoot, ".tachyon", "prompts");
  }

  /** Relative path for human-facing messages. */
  get relDir(): string {
    return ".tachyon/prompts";
  }

  /**
   * Readdir + parse on demand. Missing directory → empty library (not an error).
   * Unreadable / invalid files are skipped with reasons; never throws for a single bad file.
   */
  list(): PromptLibrary {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch (err) {
      const code = err && typeof err === "object" && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
      if (code === "ENOENT") return { templates: [], skipped: [] };
      return {
        templates: [],
        skipped: [{ file: this.relDir, reason: err instanceof Error ? err.message : String(err) }],
      };
    }

    const templates: PromptTemplate[] = [];
    const skipped: SkippedPrompt[] = [];

    for (const name of names.sort()) {
      if (!name.endsWith(".md") || name.startsWith(".")) continue;
      const id = name.slice(0, -3);
      const abs = path.join(this.dir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch (err) {
        skipped.push({ file: name, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
      if (!st.isFile()) continue;

      if (!PROMPT_ID_RE.test(id)) {
        skipped.push({ file: name, reason: `invalid id '${id}' (must match ${PROMPT_ID_RE})` });
        continue;
      }

      let raw: string;
      try {
        raw = fs.readFileSync(abs, "utf8");
      } catch (err) {
        skipped.push({ file: name, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }

      const parsed = parsePromptMarkdown(raw, id);
      if (!parsed.ok) {
        skipped.push({ file: name, reason: parsed.reason });
        continue;
      }
      templates.push({ id, title: parsed.title, body: parsed.body, path: abs });
    }

    return { templates, skipped };
  }
}

export type ParsePromptResult =
  | { ok: true; title: string; body: string }
  | { ok: false; reason: string };

/**
 * Parse a prompt markdown file.
 * - Optional YAML frontmatter (`---` … `---`); only `title` is used; unknown keys ignored.
 * - No frontmatter → whole file is body; title defaults to id.
 * - Empty body after trim → not loadable.
 */
export function parsePromptMarkdown(raw: string, id: string): ParsePromptResult {
  const text = raw.replace(/^\uFEFF/, "");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);

  if (!fm) {
    const body = text.trim();
    if (!body) return { ok: false, reason: "empty body" };
    return { ok: true, title: id, body };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(fm[1]);
  } catch {
    return { ok: false, reason: "invalid YAML frontmatter" };
  }

  // Empty frontmatter is fine; non-mapping is not.
  if (parsed !== undefined && parsed !== null && (typeof parsed !== "object" || Array.isArray(parsed))) {
    return { ok: false, reason: "frontmatter must be a mapping" };
  }

  const meta = (parsed ?? {}) as Record<string, unknown>;
  const title =
    typeof meta.title === "string" && meta.title.trim().length > 0 ? meta.title.trim() : id;
  const body = (fm[2] ?? "").trim();
  if (!body) return { ok: false, reason: "empty body" };
  return { ok: true, title, body };
}
