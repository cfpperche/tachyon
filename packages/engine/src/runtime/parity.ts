/** SDD 508 — the first-class runtimes whose parity is currently attested. */
export const PARITY_RUNTIMES = ["claude", "codex", "grok"] as const;
export type ParityRuntime = (typeof PARITY_RUNTIMES)[number];

/** SDD 508 slice 1 — start with product decisions that can be derived without a live CLI. */
export const PARITY_DIMENSIONS = ["session-hooks", "headless-probe"] as const;
export type ParityDimension = (typeof PARITY_DIMENSIONS)[number];

export type ParityCell =
  | { verdict: "wired" }
  | { verdict: "measured"; runtimeVersion: string; measuredAt: string }
  | { verdict: "cannot"; reason: string };

export type ParityDeclaration = Record<ParityDimension, Record<ParityRuntime, ParityCell>>;

/** The runtime-only product decision used after Workspace has checked agent/session eligibility. */
export function runtimeUsesSilentPersistenceHooks(runtime: string): boolean {
  return runtime === "claude" || runtime === "codex" || runtime === "grok";
}

/**
 * The code declaration is intentionally separate from every product decision below. Tests derive
 * the product verdict through its real callable door and compare it with these cells.
 */
export const RUNTIME_PARITY = {
  "session-hooks": {
    claude: { verdict: "wired" },
    codex: { verdict: "wired" },
    grok: { verdict: "wired" },
  },
  "headless-probe": {
    claude: { verdict: "wired" },
    codex: { verdict: "wired" },
    grok: { verdict: "wired" },
  },
} as const satisfies ParityDeclaration;

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Runtime validation complements `satisfies`: persisted/generated declarations cannot bypass it. */
export function parityDeclarationErrors(input: unknown): string[] {
  const errors: string[] = [];
  const declaration = input && typeof input === "object" ? input as Record<string, unknown> : {};
  for (const dimension of PARITY_DIMENSIONS) {
    const row = declaration[dimension] && typeof declaration[dimension] === "object"
      ? declaration[dimension] as Record<string, unknown>
      : {};
    for (const runtime of PARITY_RUNTIMES) {
      const label = `${dimension}/${runtime}`;
      const cell = row[runtime] && typeof row[runtime] === "object"
        ? row[runtime] as Record<string, unknown>
        : undefined;
      if (!cell) {
        errors.push(`${label}: missing parity cell`);
        continue;
      }
      if (cell.verdict === "wired") continue;
      if (cell.verdict === "cannot") {
        if (!nonEmpty(cell.reason)) errors.push(`${label}: cannot requires a written reason`);
        continue;
      }
      if (cell.verdict === "measured") {
        if (!nonEmpty(cell.runtimeVersion)) errors.push(`${label}: measured requires runtimeVersion`);
        if (!nonEmpty(cell.measuredAt) || !/^\d{4}-\d{2}-\d{2}$/.test(cell.measuredAt)) {
          errors.push(`${label}: measured requires measuredAt as YYYY-MM-DD`);
        }
        continue;
      }
      errors.push(`${label}: unknown parity verdict`);
    }
  }
  return errors;
}
