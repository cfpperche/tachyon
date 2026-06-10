# 195 — tachyon-agent-studio — plan

_Drafted from `spec.md` on 2026-06-10. Update this file if implementation reveals the plan is wrong; do NOT silently diverge._

## Approach

_One or two paragraphs. The strategy in plain language — what we'll build, in what order, and why this shape (not just any shape)._

Layered: (1) config — `instructions:` field + INSTRUCTION_ARG per-runtime map + shellQuote + composeCommand wired into spawn/restart; (2) YamlConfigEditor.upsertAgent (full-def create/edit/rename, comment-preserving); (3) webview/formLogic.ts — FLAG_SUGGESTIONS, toggleFlag, suggestName, validateForm/blockingErrors (instructions note non-blocking), toEntry (defaults omitted), fromDef; (4) webview/cliDetect.ts (which over KNOWN_AI_CLIS, injectable); (5) webview/AgentForm.ts — panel + CSP/nonce + message protocol (ready/init, inferKind, browse, submit/errors, cancel), HTML/CSS on --vscode-* vars; (6) extension — shared sync studioSubmit pipeline (also registered as _upsertAgent for integration tests), ✚ → Studio, Edit Agent… context item, quick flow kept on palette.

## Files to touch

_Concrete list of files to be created, modified, or deleted. Group by category if it helps._

**Create:** `src/webview/{AgentForm,formLogic,cliDetect}.ts`, `test/unit/agentStudio.test.ts`.

**Modify:** `src/config/loadConfig.ts` (+instructions/composeCommand/shellQuote), schema, `src/config/YamlConfigEditor.ts` (+upsertAgent), `src/agents/AgentManager.ts` (spawn via composeCommand), `src/extension.ts`, `package.json`, integration suite, `README.md`.

**Delete:** none.

## Alternatives considered

_At least one rejected approach with its reasoning. If there genuinely was no alternative, state that explicitly ("no real alternative — only viable approach is X because Y")._

### Multi-step quick-pick wizard instead of a webview

Rejected: official UX guidance explicitly warns against quick-picks as wizards; chips/flags/collapsible/all-fields-visible need a form.

### vscode-elements component library

Rejected: dependency on a community lib for ~8 controls; hand-rolled CSS over theme variables is smaller and theme-proof. (Official toolkit is deprecated since Jan/2025.)

### Instructions delivered via write_input after spawn

Rejected: requires fragile "agent is ready" detection per runtime; positional-arg delivery is deterministic for the CLIs that support it.

## Risks and unknowns

_What could go wrong, what we're not sure about, what assumptions we're making. Spell them out — surprises during implementation are usually pre-implementation risks that weren't named._

- Webview HTML is not headless-testable — mitigated: all logic extracted (formLogic/upsertAgent unit-tested), submit pipeline integration-tested via _upsertAgent, HTML verified in dogfood.
- Initial executeCommand-based onSubmit returned a Thenable where sync was expected (errors would be swallowed) — caught in review, refactored to a shared sync studioSubmit.
- Flag/instruction maps will age with runtimes — curated data, one-line updates.

## Research / citations

_Sources consulted (docs, blog posts, code references) that informed this plan. Satisfies `.agent0/context/rules/research-before-proposing.md`._

- vscode-webview-ui-toolkit deprecation (#561); Quick Picks UX guidelines; webview API docs (CSP/nonce); HiveTerm modal screenshot.
