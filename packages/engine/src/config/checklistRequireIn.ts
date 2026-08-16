/**
 * t-73885b / t-c94207 — `settings.checklist.requireIn` in tachyon.yml.
 *
 * Kind is a free string, not an enum. Invalid input warns and is ignored;
 * the product never blocks on this block. A kind that no task uses does
 * not warn — a warning that generates no action was cut twice in this
 * project.
 */

export interface ChecklistConfig {
  requireIn: string[];
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
 * Read the `settings.checklist` mapping. Bad shape or a non-list `requireIn`
 * discards the whole block (nobody is required). Bad items in an otherwise
 * valid list are dropped; the rest stay.
 */
export function parseChecklistBlock(raw: unknown, discarded: string[]): ChecklistConfig | undefined {
  if (!isPlainObject(raw)) {
    discarded.push("settings.checklist: must be a mapping");
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (key !== "requireIn") discarded.push(`settings.checklist: unknown key '${key}'`);
  }
  if (raw.requireIn === undefined) return { requireIn: [] };
  if (!Array.isArray(raw.requireIn)) {
    discarded.push("settings.checklist.requireIn: must be a list of kind strings");
    return undefined;
  }
  const requireIn: string[] = [];
  raw.requireIn.forEach((item, index) => {
    if (typeof item !== "string") {
      discarded.push(`settings.checklist.requireIn[${index}]: must be a string`);
      return;
    }
    if (item.trim() === "") {
      discarded.push(`settings.checklist.requireIn[${index}]: must be a non-empty string`);
      return;
    }
    requireIn.push(item);
  });
  return { requireIn };
}

type RequireInTokens = {
  includeAll: boolean;
  excludeAll: boolean;
  include: Set<string>;
  exclude: Set<string>;
};

function tokensOf(requireIn: readonly unknown[] | undefined): RequireInTokens | undefined {
  if (!requireIn || requireIn.length === 0) return undefined;
  const include = new Set<string>();
  const exclude = new Set<string>();
  let includeAll = false;
  let excludeAll = false;
  let hasPositive = false;
  for (const raw of requireIn) {
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

/** Whether `settings.checklist.requireIn` requires a checklist for this task kind. */
export function checklistRequiresKind(requireIn: readonly unknown[] | undefined, taskKind?: string): boolean {
  const tokens = tokensOf(requireIn);
  if (!tokens || tokens.excludeAll) return false;
  const kind = normalizeKind(taskKind);
  if (kind && tokens.exclude.has(kind)) return false;
  if (tokens.includeAll) return true;
  if (!kind) return false;
  return tokens.include.has(kind);
}
