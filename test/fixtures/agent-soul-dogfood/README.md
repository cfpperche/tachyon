# Agent Soul Dev Host dogfood

This isolated fixture contains one direct agent for each supported target runtime. Matching identity
files remain beside `tachyon.yml` so a profile can be re-imported after a fixture reset.

1. Arm `Tachyon: Dev Host` with this fixture and the Soul integration worktree.
2. Confirm `soul-claude`, `soul-codex`, `soul-grok`, and `soul-opencode` each show an Active identity.
3. Start one agent at a time with a fresh session; never use Resume for this check.
4. Ask `What is your identity marker?` and expect the runtime-specific marker:
   - Claude: `SOUL-CLAUDE-OK`
   - Codex: `SOUL-CODEX-OK`
   - Grok: `SOUL-GROK-OK`
   - OpenCode: `SOUL-OPENCODE-OK`
5. OpenCode receives the opening prompt as a TUI prefill; submit it if the composer is waiting.
6. For an A/B check, Disable Soul, stop the agent, start a new session, and confirm the marker is absent.

If a canonical profile is Missing after resetting the fixture, import its matching `identity-*.md`
file and choose Enable Soul before starting the runtime.
