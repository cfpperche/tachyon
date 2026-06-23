/**
 * spec 251 — pure parser/validator for a plugin skill's `SKILL.md` frontmatter. A skill is a directory
 * `<name>/SKILL.md` (+ optional scripts/references/assets) shipped in a plugin's NEUTRAL `skills/` payload
 * (written once, materialized per-runtime by the adapters: claude → `.claude/skills/`, codex → `.agents/skills/`).
 *
 * This is the UNTRUSTED-author boundary (mirrors manifest.ts): fail-closed, error-accumulating, never throws,
 * size-capped. v1 needs only the two mandatory frontmatter fields (`name`, `description`); the body is opaque.
 */

import { parse as parseYaml } from "yaml";

/** skill names: lowercase kebab, leading letter — also a safe single path segment (it IS the install dir name). */
const SKILL_NAME_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_SKILL_BYTES = 64 * 1024; // cap the whole SKILL.md (untrusted)
const MAX_STR = 1024;
/** leading YAML frontmatter block: `---\n …yaml… \n---` at the very top of the file. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

export interface SkillFrontmatter {
  name: string;
  description: string;
}

export interface SkillParseResult {
  frontmatter?: SkillFrontmatter;
  errors: string[];
}

/** Parse + validate the leading YAML frontmatter of a `SKILL.md`. Fail-closed; returns errors, never throws. */
export function parseSkillFrontmatter(rawMd: string): SkillParseResult {
  if (typeof rawMd !== "string" || Buffer.byteLength(rawMd, "utf8") > MAX_SKILL_BYTES) {
    return { errors: [`empty or exceeds ${MAX_SKILL_BYTES} bytes`] };
  }
  const m = FRONTMATTER_RE.exec(rawMd);
  if (!m) return { errors: ["missing YAML frontmatter (--- … ---) at the top of the file"] };

  let data: unknown;
  try {
    // untrusted frontmatter needs only scalars → disable anchors/aliases entirely (YAML-bomb defense,
    // independent of the `yaml` package's default maxAliasCount, so a future default change can't reopen it).
    data = parseYaml(m[1], { maxAliasCount: 0 });
  } catch (e) {
    return { errors: [`frontmatter: invalid YAML (${e instanceof Error ? e.message : String(e)})`] };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { errors: ["frontmatter: must be a YAML mapping"] };
  }

  const errors: string[] = [];
  const rec = data as Record<string, unknown>;

  const name = rec.name;
  if (typeof name !== "string" || name.length > MAX_STR || !SKILL_NAME_RE.test(name)) {
    errors.push("frontmatter 'name': required, lowercase kebab-case (e.g. 'pdf-processing')");
  }

  const description = rec.description;
  if (typeof description !== "string" || description.trim().length === 0 || description.length > MAX_STR) {
    errors.push("frontmatter 'description': required, a non-empty string");
  }

  if (errors.length > 0) return { errors };
  return { frontmatter: { name: name as string, description: (description as string).trim() }, errors: [] };
}
