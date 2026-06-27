/*
 * spec 274 — named FleetVM fixtures for the dev preview harness.
 * v1 keeps these as plain JS (a follow-up types them against FleetVM via a build step — OQ2/fail-on-drift).
 * `default` → undefined: let the bundle render its own built-in SAMPLE (no inject).
 */
// a complete FleetVM minus `agents` — every required array present (missing ones crash searchIndex/countOf;
// that drift is intentionally fatal per spec 274, and a follow-up types these against FleetVM at build).
const base = {
  bridge: { port: "42551", connected: true },
  terminals: [],
  pipelines: [],
  proposals: [],
  schedules: [],
  commands: [],
  runbooks: [],
  pins: [],
};

export const FIXTURES = {
  // let the webview bundle render its own SAMPLE (the richest default)
  default: undefined,

  empty: { ...base, agents: [] },

  // spec 273 — the evidence-badge state: worktree agents carrying non-binary evidence indicators
  "evidence-badge": {
    ...base,
    agents: [
      { name: "feature-auth", status: "running", worktree: "tachyon/feature-auth", verify: "pass", verifiable: true, ai: true,
        evidence: { total: 3, stale: 0, warn: 1, error: 0 } },
      { name: "feature-billing", status: "idle", worktree: "tachyon/feature-billing", verify: "stale", verifiable: true, ai: true,
        evidence: { total: 2, stale: 2, warn: 0, error: 0 } },
      { name: "migration", status: "running", worktree: "tachyon/migration", verify: "fail", verifiable: true, ai: true,
        evidence: { total: 5, stale: 1, warn: 2, error: 1 } },
    ],
  },

  error: {
    ...base,
    agents: [{ name: "migration", status: "crashed", sub: "exited (1)", verify: "fail", verifiable: true, ai: true }],
  },
};
