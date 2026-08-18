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
  "persistent-instructions-launch",
] as const;
export type ParityDimension = (typeof PARITY_DIMENSIONS)[number];

export type ProjectionParityFact =
  | { verdict: "wired" }
  | { verdict: "cannot"; reason: string };

export type RuntimeParityFact =
  | { verdict: "measured"; runtimeVersion: string; measuredAt: string }
  | { verdict: "cannot"; reason: string }
  | { verdict: "unmeasured"; needed: string };

export interface ParityCell {
  projection: ProjectionParityFact;
  runtime: RuntimeParityFact;
}

export type ParityDeclaration = Record<ParityDimension, Record<ParityRuntime, ParityCell>>;

/**
 * The code declaration is intentionally separate from every product decision below. Tests derive
 * the product verdict through its real callable door and compare it with these cells.
 *
 * t-2a29a7 — a mute `unmeasured` is the same promise-without-a-deadline fatia 5 removed from
 * parity.md. The `needed` sentence is the measurement that would change the cell.
 */
const NEEDED = {
  "session-hooks-codex":
    "Authenticated `codex` TUI (the spawn argv Tachyon uses, including `-c hooks.Stop=…`) whose Stop hook is the only source of an opaque canary file after a completed turn; an otherwise identical session without that overlay must not write the file. `codex exec` on 0.147.0 (2026-08-15) completed the turn and did not fire Stop, so exec is not that channel.",
  "observed-model-provenance":
    "After one authenticated turn, the file the Activity normalizer reads contains the model identity; an invented field name in that file is not treated as a model. Record CLI version and date.",
} as const;

const MEASURED = {
  claude: { verdict: "measured", runtimeVersion: "2.1.233", measuredAt: "2026-08-15" },
  codex: { verdict: "measured", runtimeVersion: "0.147.0", measuredAt: "2026-08-15" },
  grok: { verdict: "measured", runtimeVersion: "1.0.4", measuredAt: "2026-08-15" },
} as const;

export const RUNTIME_PARITY = {
  "session-hooks": {
    claude: { projection: { verdict: "wired" }, runtime: MEASURED.claude },
    codex: { projection: { verdict: "wired" }, runtime: { verdict: "unmeasured", needed: NEEDED["session-hooks-codex"] } },
    grok: { projection: { verdict: "wired" }, runtime: MEASURED.grok },
  },
  "headless-probe": {
    claude: { projection: { verdict: "wired" }, runtime: MEASURED.claude },
    codex: { projection: { verdict: "wired" }, runtime: MEASURED.codex },
    grok: { projection: { verdict: "wired" }, runtime: MEASURED.grok },
  },
  "observed-model-provenance": {
    claude: { projection: { verdict: "wired" }, runtime: { verdict: "unmeasured", needed: NEEDED["observed-model-provenance"] } },
    codex: { projection: { verdict: "wired" }, runtime: MEASURED.codex },
    grok: { projection: { verdict: "wired" }, runtime: { verdict: "unmeasured", needed: NEEDED["observed-model-provenance"] } },
  },
  "probe-model-proof": {
    claude: { projection: { verdict: "wired" }, runtime: MEASURED.claude },
    codex: { projection: { verdict: "wired" }, runtime: MEASURED.codex },
    grok: { projection: { verdict: "wired" }, runtime: MEASURED.grok },
  },
  "cross-runtime-task-continuation": {
    claude: { projection: { verdict: "wired" }, runtime: MEASURED.claude },
    codex: { projection: { verdict: "wired" }, runtime: MEASURED.codex },
    grok: { projection: { verdict: "wired" }, runtime: MEASURED.grok },
  },
  "persistent-instructions-launch": {
    claude: {
      projection: { verdict: "wired" },
      runtime: {
        verdict: "cannot",
        reason: "Claude Code 2.1.233 automatic compact failed twice with compact_result=failed / too_few_groups; manual compact does not generalize",
      },
    },
    codex: {
      projection: { verdict: "wired" },
      runtime: { verdict: "measured", runtimeVersion: "0.147.0", measuredAt: "2026-08-15" },
    },
    grok: {
      projection: { verdict: "wired" },
      runtime: { verdict: "measured", runtimeVersion: "1.0.4", measuredAt: "2026-08-15" },
    },
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
      } else if (runtimeFact.verdict === "unmeasured") {
        if (!nonEmpty(runtimeFact.needed)) errors.push(`${label}/runtime: unmeasured requires needed`);
      } else {
        errors.push(`${label}/runtime: must be measured, cannot, or explicitly unmeasured; wired is projection-only`);
      }
    }
  }
  return errors;
}
