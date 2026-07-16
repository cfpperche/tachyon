# Cookbook — SDD cookbook opt-in (spec 394)

How to use the **opt-in cookbook** feature of the SDD plugin (v1.5.0+). Contract: [`spec.md`](./spec.md).

## When to use

- A ship adds Bridge tools, registry lifecycle, CLI, or another surface a sibling agent/human will invoke.
- You want `sdd close` to stop warning about a missing operator how-to.

## When not to use

- Pure internal refactors with no new operator surface → use `**Cookbook-Opt-Out:** <reason>` instead.
- Do not put acceptance criteria in the cookbook (that stays in `spec.md`).

## Happy path

1. Finish implementation; status toward `shipped` / `shipped-partial`.
2. Scaffold (from workspace root):

   ```bash
   bash .agents/skills/sdd/scripts/sdd-cookbook.sh docs/specs/NNN-<slug>
   # or: bash .agents/skills/sdd/scripts/sdd-cookbook.sh NNN
   ```

3. Fill `cookbook.md`: when to use / not / happy path / tools table / fail-closed / cleanup.
4. In `tasks.md` declare: `**Cookbook:** yes`
5. Audit:

   ```bash
   bash .agents/skills/sdd/scripts/sdd-close.sh docs/specs/NNN-<slug>
   ```

   Expect **no** `cookbook-missing` warning.

## Fail-closed / hygiene

- `close` only **warns** (does not hard-fail) for cookbook gaps.
- Empty `**Cookbook-Opt-Out:**` → `cookbook-opt-out-empty`.
- Heuristic looks for concrete tool ids in `spec.md` (e.g. `create_worktree`); explicit `**Cookbook:**` also requires the file.

## Install channel

```text
github:cfpperche/tachyon-plugins@v0.32.0#path=sdd
```

Plugin version **1.5.0+**.

## See also

- First dogfood vehicle: `docs/specs/392-managed-worktree-registry/cookbook.md`
- Plugin source: `tachyon-plugins/sdd`
