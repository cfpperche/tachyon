# 398 — pi-runtime-onboarding — plan

_Drafted from `spec.md` on 2026-07-18._

## Approach

1. Add Pi to the existing opening-prompt adapter using Pi's documented positional startup message.
2. Build a self-contained ESM Pi extension into `dist/engine/`. It uses Pi's extension API at load time and bundles its MCP client/schema dependencies, so no project/global Pi package installation is required.
3. Have the persistent engine pass the staged immutable extension path into `Workspace`, then into `AgentManager`. The shared runtime Bridge-injection step appends `--extension <path>` only for Pi, only while the Bridge URL and extension asset are available.
4. The extension reads URL and bearer only from the inherited process environment, opens a Streamable HTTP MCP client, lists tools, converts their JSON Schemas to TypeBox-compatible schemas, and registers native Pi tools that proxy `tools/call`.
5. Keep Bridge failure advisory: Pi remains usable for local coding, while a status command and TUI status expose disconnected state. Missing staged assets fail wiring before spawn and produce a Tachyon warning.
6. Cover command composition, primer support, schema/result mapping, manifest staging, and unchanged-runtime behavior. Dogfood the built asset through the installed Pi binary in RPC mode against a local fake MCP server.

## Key decisions

- **A bundled per-spawn extension, not `.pi` mutation** — additive `--extension` is documented by Pi, works alongside `--no-extensions`, and leaves user/project configuration untouched; rejected writing `.pi/extensions` because it changes the consumer repository and depends on project trust.
- **MCP SDK inside the extension asset** — preserves standard Streamable HTTP sessions, notifications, cancellation and result shapes; rejected hand-written JSON-RPC because it would duplicate protocol/session behavior already owned by the SDK.
- **Environment-only credentials** — prefer `TACHYON_AGENT_BRIDGE_TOKEN`, with the existing shared token only as compatibility fallback; rejected argv/config serialization because process listings and files would expose secrets.
- **Advisory connection failure but honest wiring stamp** — an absent asset is `wired:false`; a temporarily unavailable Bridge is visible inside Pi but does not destroy its local coding session, matching Tachyon's self-healing lifecycle model.
- **Foundational parity only** — Bridge and primer make Pi operational in the ecosystem; transcript resume and Activity require separate measured runtime contracts and are intentionally deferred.

## Files touched

- `docs/specs/398-pi-runtime-onboarding/*` — contract, plan, tasks and evidence.
- `src/agents/runtimePromptAdapters.ts` — Pi startup-prompt capability.
- `src/agents/AgentManager.ts` — additive Pi extension injection and wiring honesty.
- `src/workspace/Workspace.ts` / `src/engine-service/engineService.ts` — immutable staged asset path plumbing.
- `src/pi-bridge-extension/*` — Pi extension entry and testable MCP-to-Pi mapping.
- `esbuild.mjs` — standalone extension bundle and engine-manifest membership.
- `test/unit/*` — prompt, command, mapping and package-boundary coverage.
- `scripts/dogfood/pi-runtime-onboarding.mjs` — real Pi loader/MCP discovery exercise.
- `README.md` / `docs/runtimes/pi.md` — public integration mechanism, capability matrix and honest gaps.

## Risks & unknowns

- MCP input schemas are ordinary JSON Schema while Pi validates TypeBox schemas; prove `Type.Unsafe` conversion with the installed Pi version.
- Pi extension loading must accept the bundled ESM default export in TUI/RPC modes.
- The engine bundle manifest must include the asset or immutable staging will omit it.
- Pi positional startup prompts must remain after runtime-owned flags; command-order tests pin this.
- Tool-list change notifications can race extension shutdown/reload; handlers must be idempotent and the client must close on `session_shutdown`.

## Visual impact

The only visible change is Pi's terminal status/diagnostic when Bridge connection succeeds or fails. No VS Code webview changes. Headless RPC dogfood captures the same extension notification path; no screenshot is useful.

## Sources consulted

- `docs/specs/363-agent-onboarding/spec.md` and `docs/specs/383-primer-project-guidance-boundary/spec.md`
- `docs/system-design.md`
- `src/agents/AgentManager.ts`, `src/agents/runtimePromptAdapters.ts`, `src/bridge/Bridge.ts`
- `src/engine-service/engineBundleStore.ts`, `esbuild.mjs`
- Pi `README.md`, `docs/extensions.md`, and `docs/rpc.md` from the installed `@earendil-works/pi-coding-agent`
