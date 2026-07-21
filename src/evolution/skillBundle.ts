import { createHash } from "node:crypto";
import { parseSkillFrontmatter, type SkillFrontmatter } from "../plugins/skill.js";
import type { EvolutionSkillFile } from "./domain.js";

const SHA256_RE = /^[0-9a-f]{64}$/;
const ALLOWED_NESTED_ROOTS = new Set(["scripts", "references", "assets"]);

function comparePath(a: EvolutionSkillFile, b: EvolutionSkillFile): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export interface EvolutionSkillBundleInput {
  operation: "create" | "update";
  name: string;
  reason: string;
  expectedTargetDigest?: string;
  files: EvolutionSkillFile[];
}

export interface ValidatedEvolutionSkillBundle extends EvolutionSkillBundleInput {
  frontmatter: SkillFrontmatter;
  files: EvolutionSkillFile[];
  digest: string;
}

export type EvolutionSkillBundleResult =
  | { ok: true; bundle: ValidatedEvolutionSkillBundle }
  | { ok: false; errors: string[] };

function validBundlePath(file: string): boolean {
  if (file === "SKILL.md") return true;
  if (!file || file.startsWith("/") || file.includes("\\") || file.includes("\0")) return false;
  const parts = file.split("/");
  return parts.length >= 2
    && ALLOWED_NESTED_ROOTS.has(parts[0]!)
    && parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function digestEvolutionSkillFiles(files: readonly EvolutionSkillFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort(comparePath)) {
    hash.update(file.path, "utf8");
    hash.update("\0");
    hash.update(file.executable === true ? "x" : "-");
    hash.update("\0");
    hash.update(file.content, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Validate and normalize one complete standard Agent Skills bundle. */
export function validateEvolutionSkillBundle(input: EvolutionSkillBundleInput): EvolutionSkillBundleResult {
  const errors: string[] = [];
  if (typeof input.reason !== "string" || input.reason.trim().length === 0) errors.push("skill reason must be a non-empty string");
  if (!Array.isArray(input.files) || input.files.length === 0) errors.push("skill files must contain a complete bundle");

  const seen = new Set<string>();
  for (const file of input.files ?? []) {
    if (!validBundlePath(file.path)) errors.push(`skill file '${file.path}' must be SKILL.md or live under scripts/, references/, or assets/`);
    if (seen.has(file.path)) errors.push(`skill file '${file.path}' is duplicated`);
    seen.add(file.path);
    if (typeof file.content !== "string") errors.push(`skill file '${file.path}' content must be a string`);
    if (file.executable !== undefined && typeof file.executable !== "boolean") errors.push(`skill file '${file.path}' executable must be a boolean`);
    if (file.executable === true && !file.path.startsWith("scripts/")) errors.push(`only files under scripts/ may be executable ('${file.path}')`);
  }

  if (input.operation === "create" && input.expectedTargetDigest !== undefined) {
    errors.push("create skill proposals must not declare expectedTargetDigest");
  }
  if (input.operation === "update" && (input.expectedTargetDigest === undefined || !SHA256_RE.test(input.expectedTargetDigest))) {
    errors.push("update skill proposals require a sha256 expectedTargetDigest");
  }

  const skillFile = input.files?.find((file) => file.path === "SKILL.md");
  let frontmatter: SkillFrontmatter | undefined;
  if (!skillFile) {
    errors.push("skill bundle requires SKILL.md");
  } else if (typeof skillFile.content === "string") {
    const parsed = parseSkillFrontmatter(skillFile.content);
    if (!parsed.frontmatter) errors.push(...parsed.errors.map((error) => `SKILL.md: ${error}`));
    else {
      frontmatter = parsed.frontmatter;
      if (parsed.frontmatter.name !== input.name) {
        errors.push(`SKILL.md name '${parsed.frontmatter.name}' must match target skill '${input.name}'`);
      }
    }
  }

  if (errors.length > 0 || !frontmatter) return { ok: false, errors };
  const files = input.files
    .map((file) => ({ path: file.path, content: file.content, ...(file.executable === true ? { executable: true } : {}) }))
    .sort(comparePath);
  return {
    ok: true,
    bundle: {
      operation: input.operation,
      name: input.name,
      reason: input.reason.trim(),
      ...(input.expectedTargetDigest !== undefined ? { expectedTargetDigest: input.expectedTargetDigest } : {}),
      files,
      frontmatter,
      digest: digestEvolutionSkillFiles(files),
    },
  };
}
