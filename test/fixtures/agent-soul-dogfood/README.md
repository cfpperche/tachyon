# Agent Soul Dev Host dogfood

This fixture exercises the functional Identity panel without touching the fleet workspace.

1. Arm `Tachyon: Dev Host` with this fixture and the Soul integration worktree.
2. Open Agent Studio for `soul-alpha`: Create, Open, edit the template, Refresh, Preview, and Enable soul.
3. Open Agent Studio for `soul-beta`: Import `identity-beta.md`, Preview, and Enable soul.
4. Disable and re-enable one profile. Confirm the bytes remain and the status changes between retained/active.
5. Confirm all managed files stay under `.tachyon/agents/<agent>/` in the isolated Dev Host mirror.

No agent needs to start and no provider inference is required for this profile-action smoke.
