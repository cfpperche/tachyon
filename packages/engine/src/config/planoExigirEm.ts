/**
 * t-73885b — `plano.exigir_em` in tachyon.yml.
 *
 * Kind is a free string, not an enum. Invalid input warns and is ignored;
 * the product never blocks on this block. A kind that no task uses does
 * not warn — a warning that generates no action was cut twice in this
 * project.
 */

export interface PlanoConfig {
  exigir_em: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeKind(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Read the `plano:` mapping. Bad shape or a non-list `exigir_em` discards
 * the whole block (nobody is required). Bad items in an otherwise valid
 * list are dropped; the rest stay.
 */
export function parsePlanoBlock(raw: unknown, discarded: string[]): PlanoConfig | undefined {
  if (!isPlainObject(raw)) {
    discarded.push("plano: must be a mapping");
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (key !== "exigir_em") discarded.push(`plano: unknown key '${key}'`);
  }
  if (raw.exigir_em === undefined) return { exigir_em: [] };
  if (!Array.isArray(raw.exigir_em)) {
    discarded.push("plano.exigir_em: must be a list of kind strings");
    return undefined;
  }
  const exigir_em: string[] = [];
  raw.exigir_em.forEach((item, index) => {
    if (typeof item !== "string") {
      discarded.push(`plano.exigir_em[${index}]: must be a string`);
      return;
    }
    if (item.trim() === "") {
      discarded.push(`plano.exigir_em[${index}]: must be a non-empty string`);
      return;
    }
    exigir_em.push(item);
  });
  return { exigir_em };
}

type ExigirTokens = {
  includeAll: boolean;
  excludeAll: boolean;
  include: Set<string>;
  exclude: Set<string>;
};

function tokensOf(exigirEm: readonly unknown[] | undefined): ExigirTokens | undefined {
  if (!exigirEm || exigirEm.length === 0) return undefined;
  const include = new Set<string>();
  const exclude = new Set<string>();
  let includeAll = false;
  let excludeAll = false;
  let hasPositive = false;
  for (const raw of exigirEm) {
    if (typeof raw !== "string") continue;
    const token = raw.trim();
    if (!token) continue;
    if (token === "*") {
      includeAll = true;
      hasPositive = true;
      continue;
    }
    if (token === "!*") {
      excludeAll = true;
      continue;
    }
    if (token.startsWith("!")) {
      const kind = normalizeKind(token.slice(1));
      if (kind) exclude.add(kind);
      continue;
    }
    const kind = normalizeKind(token);
    if (!kind) continue;
    include.add(kind);
    hasPositive = true;
  }
  if (!hasPositive && exclude.size > 0 && !excludeAll) includeAll = true;
  if (!includeAll && !excludeAll && include.size === 0 && exclude.size === 0) return undefined;
  return { includeAll, excludeAll, include, exclude };
}

/** Whether `plano.exigir_em` requires a plan for this task kind. */
export function planoRequiresKind(exigirEm: readonly unknown[] | undefined, taskKind?: string): boolean {
  const tokens = tokensOf(exigirEm);
  if (!tokens || tokens.excludeAll) return false;
  const kind = normalizeKind(taskKind);
  if (kind && tokens.exclude.has(kind)) return false;
  if (tokens.includeAll) return true;
  if (!kind) return false;
  return tokens.include.has(kind);
}
