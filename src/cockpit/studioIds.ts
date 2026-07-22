/**
 * t-610705 (SDD 410 Phase D, D0) — the ONE runtime source for which studios are Control routes.
 * `STUDIO_IDS` is the closed set; `StudioId` is derived from it (never hand-declared separately),
 * per the studios-routes-design.md dueto's R2-F14 rule: a cast or a second parallel list is exactly
 * how a registry silently drifts from the type. Each Phase D PR appends its studio(s) here AND to
 * every exhaustive switch in route.ts/studioRegistry.ts — the compiler is the checklist.
 *
 * D0 shipped "command" (the pilot). D1a added terminal/runbook/schedule. D1b (this PR) adds agent —
 * its evolution/soul-profile domain messages are substantially larger than the other three's shared
 * shape, hence its own PR. D2 adds task (closes C.1b). D3 adds pin (closes C.4).
 */
export const STUDIO_IDS = ["command", "terminal", "runbook", "schedule", "agent", "task", "pin"] as const;

export type StudioId = (typeof STUDIO_IDS)[number];

export function isStudioId(value: unknown): value is StudioId {
  return typeof value === "string" && (STUDIO_IDS as readonly string[]).includes(value);
}
