# 318 — persistence-settings-ui — plan

_Drafted from `spec.md` on 2026-07-01. The approach, not the steps (those go in `tasks.md`)._

## Approach

Expose the existing workspace-level kill switch through the Tachyon sidebar instead of introducing a new settings
webview. The Agents/Terminals section header gets a compact "Persistence hooks settings" action, and any non-active
hook-health badge from spec 316 routes to the same command.

The host command shows the effective current value and writes `tachyon.yml` through `YamlConfigEditor`, keeping the file
as source of truth. Disabling writes `settings.persistence.silentHooks: false`; enabling removes that override so the
default remains canonical.

## Key decisions

- Workspace-only in this spec. Per-agent override is explicitly deferred because it needs a separate policy and UI
  model; hidden partial support would make hook state harder to reason about.
- Re-enable means "remove override", not write `true`. The default policy already enables silent hooks.
- Hook diagnostics stay read-only: spec 316 owns health state; this spec only provides a route from a failed/skipped
  badge to the setting that can change policy.
- Use a VS Code QuickPick command rather than a new panel. It is enough for a two-state setting and avoids duplicating
  YAML editing surfaces.

## Files touched

- `src/config/YamlConfigEditor.ts` — pure YAML mutation helper.
- `src/extension.ts` — `tachyon.persistenceSettings` command.
- `src/webview/SidebarPrototype.ts` — sidebar global message routing.
- `src/webview/sidebar/App.tsx` and `sidebar.css` — visible controls.
- `test/unit/yamlEditor.test.ts` — preservation/canonicalization tests.

## Risks & unknowns

- The QuickPick is not a full settings page; if persistence grows more options, a dedicated panel may become justified.
- Button copy must be explicit that disabling restores visible reminders; otherwise users can mistake it for disabling
  persistence entirely.
- Multi-root routing must pass `wsHash`; the sidebar global action already follows the same pattern as handoff/probes.

## Sources consulted

- `docs/specs/312-silent-persistence-hooks/`
- `docs/specs/316-persistence-hook-health-diagnostics/`
- `src/config/YamlConfigEditor.ts`
- `src/config/loadConfig.ts`
- `src/webview/AgentForm.ts`
