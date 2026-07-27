# Agent Soul Dev Host dogfood

> **This scenario cannot be run end to end right now — see t-e81ec5 before arming anything.**
> Soul has no reachable entry for a declared agent: `createSoulProfile` adds an inline `soul:` key,
> every declared agent is a canonical profile pointer, and the two cannot coexist. The canonical
> profile cannot carry Soul either — the projection defers `prompt.soul` to t-a2827d. Treat the
> steps below as staged material, not as a runnable checklist, until that lands.

> **Create the agents first (SDD 478).** This fixture declares no agents. An `agents:` entry is a
> pointer to a canonical profile, and the authority that attests it is custodied by the host (VS Code
> secret storage), so no checked-in fixture can ship one. `soul-claude`, `soul-codex` and `soul-grok`
> are created with **Tachyon: Agent Studio**. `soul-opencode` cannot be created at all: opencode is
> resumable but **not attested**, so it is not an agent runtime — that row of the matrix is
> unreachable by construction, not merely unconfigured.

The identity files remain beside `tachyon.yml` so a profile can be re-imported after a fixture reset.

1. Arm `Tachyon: Dev Host` with this fixture and the Soul integration worktree.
2. Create `soul-claude`, `soul-codex` and `soul-grok` in Agent Studio, autostart off, then enable
   Soul on each and confirm an Active identity.
3. Start one agent at a time with a fresh session; never use Resume for this check.
4. Ask `What is your identity marker?` and expect the runtime-specific marker:
   - Claude: `SOUL-CLAUDE-OK`
   - Codex: `SOUL-CODEX-OK`
   - Grok: `SOUL-GROK-OK`
   - OpenCode: `SOUL-OPENCODE-OK` — kept for if/when opencode becomes attested
5. OpenCode receives the opening prompt as a TUI prefill; submit it if the composer is waiting.
6. For an A/B check, Disable Soul, stop the agent, start a new session, and confirm the marker is absent.

If a canonical profile is Missing after resetting the fixture, import its matching `identity-*.md`
file and choose Enable Soul before starting the runtime.
