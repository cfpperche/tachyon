/** SDD 508 — the first-class runtimes whose parity is currently attested. */
export const PARITY_RUNTIMES = ["claude", "codex", "grok"] as const;
export type ParityRuntime = (typeof PARITY_RUNTIMES)[number];

/** SDD 508 slice 1 — start with product decisions that can be derived without a live CLI. */
export const PARITY_DIMENSIONS = [
  "session-hooks",
  "headless-probe",
  "observed-model-provenance",
  "probe-model-proof",
  "cross-runtime-task-continuation",
] as const;
export type ParityDimension = (typeof PARITY_DIMENSIONS)[number];

export type ProjectionParityFact =
  | { verdict: "wired" }
  | { verdict: "cannot"; reason: string };

export type RuntimeParityFact =
  | { verdict: "measured"; runtimeVersion: string; measuredAt: string }
  | { verdict: "cannot"; reason: string }
  | { verdict: "unmeasured" };

export interface ParityCell {
  projection: ProjectionParityFact;
  runtime: RuntimeParityFact;
}

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
    claude: { projection: { verdict: "wired" }, runtime: { verdict: "unmeasured" } },
    codex: { projection: { verdict: "wired" }, runtime: { verdict: "unmeasured" } },
    grok: { projection: { verdict: "wired" }, runtime: { verdict: "unmeasured" } },
  },
  "headless-probe": {
    claude: { projection: { verdict: "wired" }, runtime: { verdict: "unmeasured" } },
    codex: { projection: { verdict: "wired" }, runtime: { verdict: "unmeasured" } },
    grok: { projection: { verdict: "wired" }, runtime: { verdict: "unmeasured" } },
  },
  "observed-model-provenance": {
    claude: { projection: { verdict: "wired" }, runtime: { verdict: "unmeasured" } },
    codex: { projection: { verdict: "wired" }, runtime: { verdict: "unmeasured" } },
    grok: { projection: { verdict: "wired" }, runtime: { verdict: "unmeasured" } },
  },
  "probe-model-proof": {
    claude: { projection: { verdict: "wired" }, runtime: { verdict: "unmeasured" } },
    codex: { projection: { verdict: "wired" }, runtime: { verdict: "unmeasured" } },
    grok: { projection: { verdict: "wired" }, runtime: { verdict: "unmeasured" } },
  },
  "cross-runtime-task-continuation": {
    claude: { projection: { verdict: "wired" }, runtime: { verdict: "unmeasured" } },
    codex: { projection: { verdict: "wired" }, runtime: { verdict: "unmeasured" } },
    grok: { projection: { verdict: "wired" }, runtime: { verdict: "unmeasured" } },
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
      const projection = cell.projection && typeof cell.projection === "object"
        ? cell.projection as Record<string, unknown>
        : undefined;
      if (!projection) {
        errors.push(`${label}/projection: missing parity fact`);
      } else if (projection.verdict === "cannot") {
        if (!nonEmpty(projection.reason)) errors.push(`${label}/projection: cannot requires a written reason`);
      } else if (projection.verdict !== "wired") {
        errors.push(`${label}/projection: must be wired or cannot`);
      }

      const runtimeFact = cell.runtime && typeof cell.runtime === "object"
        ? cell.runtime as Record<string, unknown>
        : undefined;
      if (!runtimeFact) {
        errors.push(`${label}/runtime: missing parity fact`);
      } else if (runtimeFact.verdict === "cannot") {
        if (!nonEmpty(runtimeFact.reason)) errors.push(`${label}/runtime: cannot requires a written reason`);
      } else if (runtimeFact.verdict === "measured") {
        if (!nonEmpty(runtimeFact.runtimeVersion)) errors.push(`${label}/runtime: measured requires runtimeVersion`);
        if (!nonEmpty(runtimeFact.measuredAt) || !/^\d{4}-\d{2}-\d{2}$/.test(runtimeFact.measuredAt)) {
          errors.push(`${label}/runtime: measured requires measuredAt as YYYY-MM-DD`);
        }
      } else if (runtimeFact.verdict !== "unmeasured") {
        errors.push(`${label}/runtime: must be measured, cannot, or explicitly unmeasured; wired is projection-only`);
      }
    }
  }
  return errors;
}
