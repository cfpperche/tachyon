# 375 — persistent-workspace-bridge — plan

_Drafted from `spec.md` on 2026-07-13. The approach, not the steps (those go in `tasks.md`)._

## Approach

Keep the existing `Workspace` and `Bridge` engine intact. Add one small detached Node proxy per canonical workspace.
The proxy owns the stable public loopback port. The embedded Bridge binds an ephemeral private loopback port on each
Extension Host activation. A workspace-local Unix control socket lets the extension register that backend, query
health and explicitly stop the proxy. Requests are streamed to the backend; absence returns bounded HTTP 503 with
`HOST_UNAVAILABLE`. Extension disposal closes only the private backend.

## Key decisions

- **Persistent proxy, existing engine** — fixes the stable-endpoint failure without migrating the whole engine.
- **Unix control socket** — owner-only local control without writing a bearer token.
- **One process, no supervisor** — daemon failure is recovered on next activation; no supervisor tree.
- **Immediate 503 while detached** — bounded and honest; arbitrary request queueing is rejected.
- **Explicit upgrade restart** — no hot protocol migration in this slice.

## Files touched

- `src/bridge/persistentProxyProtocol.ts` — descriptor and control messages.
- `src/bridge/persistentProxyDaemon.ts` — detached proxy executable.
- `src/bridge/PersistentBridgeService.ts` — ensure/register/health/stop client.
- `src/bridge/Bridge.ts` — private listener versus advertised public endpoint.
- `src/workspace/Workspace.ts`, `src/extension.ts`, `package.json` — lifecycle and explicit commands.
- focused tests and `scripts/dogfood/persistent-bridge.mjs`.

## Risks & unknowns

- Stale control socket recovery must never signal a PID by number alone.
- Two simultaneous activations must converge on one proxy.
- Streaming MCP requests and headers must remain byte-transparent.
- Packaged VSIX must contain the daemon entrypoint.

## Visual impact

One new command-palette action, `Tachyon: Stop Bridge`. No layout change.

## Sources consulted

- `src/bridge/Bridge.ts`, `src/workspace/Workspace.ts`, `src/extension.ts`.
- `docs/specs/186-tachyon-vscode-extension` and `docs/specs/233-tachyon-engine-host-port`.
