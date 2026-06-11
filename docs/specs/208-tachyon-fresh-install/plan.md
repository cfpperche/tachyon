# 208 — tachyon-fresh-install — plan

_Built in ~/tachyon; SDD by hand._

Three changes:
1. **Lazy activation** — `activate()` boots (addWorkspace+start) only folders with
   a tachyon.yml. No-config folders aren't in the registry → views empty → welcome
   shows. A new `ensureWorkspaceFor` + `pickFolderForCreate` boot a folder on demand
   for the creation commands (New Agent / Agent Studio tabs), so acting is the opt-in.
   The empty-tree welcome bug fixes itself (no registry entry → no Bridge node).
2. **Native walkthrough** — `contributes.walkthroughs` "tachyon.welcome", 5 steps with
   real screenshots in media/walkthrough (in the .vsix), auto-completion events.
   `tachyon.getStarted` opens it on demand; `tachyon.checkRequirements` exposes doctor.
3. **viewsWelcome** — points at Init + the walkthrough.

**Files:** extension.ts (lazy activation, ensureWorkspaceFor, pickFolderForCreate,
getStarted/checkRequirements), package.json (walkthroughs + 2 commands), nls/l10n,
welcome content, README/landing, docs/screenshots/walkthrough.

## Alternatives considered
### Keep eager activation, just hide the Bridge node
Doesn't fix the real issue (a server you didn't ask for). Lazy activation is the honest fix and fixes the welcome for free.
### A custom onboarding webview
Reinvents `contributes.walkthroughs`, which auto-opens on install and is the platform idiom (GitLens/Docker/Copilot use it).

## Risks
- Activation timing: views activate the extension via onView; walkthrough buttons via onCommand. Fixture has config so the integration hot path is unchanged (regression-checked).
