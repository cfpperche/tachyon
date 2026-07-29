# MCP 2026-07-28 — what it changes, and what Tachyon should do about it

**Task:** `t-b3ddcd` · **Status:** research, no implementation · **Author:** claude-reviewer, 2026-07-29

Primary sources fetched for this report: the [specification index](https://modelcontextprotocol.io/specification/2026-07-28)
and the [Key Changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) document.
Local evidence: this repository's pinned SDK and Bridge implementation. The Anthropic announcement was
deliberately **not** used as a source — the task requires primary specification evidence.

---

## 0. The finding that governs every recommendation

**The installed SDK cannot speak this revision at all.**

- `package.json` pins `@modelcontextprotocol/sdk: ^1.12.0`; installed is **1.29.0**.
- The protocol versions that SDK knows are `2024-10-07`, `2024-11-05`, `2025-03-26`, `2025-06-18`,
  `2025-11-25`. **`2026-07-28` is absent.**

So nothing in this revision is adoptable today by writing code against the pinned dependency. Every
row below that looks attractive is gated on SDK support landing first. A report that recommended
"adopt" on any of it would be recommending we hand-roll a protocol revision our client library does
not implement.

That single fact is why almost nothing here is *adopt now*.

---

## 1. Normative changes (from Key Changes, verbatim in substance)

### Core, breaking

1. **Protocol-level sessions removed**, including the `Mcp-Session-Id` header. List endpoints no
   longer vary per connection. "Servers that need cross-call state use explicit, server-minted
   handles passed as ordinary tool arguments."
2. **MCP is stateless**: the `initialize` / `notifications/initialized` handshake is **removed**.
   Every request carries its protocol version and client capabilities in `_meta`. Version mismatch
   returns `UnsupportedProtocolVersionError`.
3. **`server/discover` — servers MUST implement it**, advertising supported versions, capabilities
   and identity.
4. **`subscriptions/listen`** replaces the HTTP GET endpoint and `resources/subscribe`/`unsubscribe`.
5. **`ping`, `logging/setLevel`, `notifications/roots/list_changed` removed.** Log level is per
   request via `_meta`.
6. **Tasks moved out of core into an official extension** (`io.modelcontextprotocol/tasks`): polling
   via `tasks/get`, `tasks/update` for client→server input, `tasks/list` removed.
7. **Multi Round-Trip Requests (MRTR)** replaces *all* server-initiated requests — `roots/list`,
   `sampling/createMessage`, `elicitation/create`. A server returns `InputRequiredResult`
   (`resultType: "input_required"`) and the client **retries the original request** carrying
   `inputResponses`.
8. **Every result carries a required `resultType`.**
9. **SSE resumability and message redelivery removed.** A broken stream loses the in-flight request;
   the client MUST re-issue it with a new request id.

### Deprecated (minimum twelve-month window, per the new lifecycle policy)

- **Roots, Sampling and Logging.** Suggested migrations: tool parameters / resource URIs / server
  config instead of Roots; direct LLM provider APIs instead of Sampling; `stderr` or OpenTelemetry
  instead of Logging.
- **HTTP+SSE transport** reclassified Deprecated.
- **OAuth 2.0 Dynamic Client Registration (RFC 7591)** deprecated in favour of **Client ID Metadata
  Documents**; DCR remains for authorization servers that lack CIMD.

### Auth hardening (all minor, all directly relevant to governed login)

- Authorization servers SHOULD include `iss` (RFC 9207); clients **MUST validate** a present `iss`
  against the recorded issuer before redeeming the code.
- Clients MUST specify `application_type` during DCR to avoid OIDC redirect-URI conflicts.
- **Credentials are bound to their issuer**: clients MUST key persisted credentials by issuer, MUST
  NOT reuse them across authorization servers, MUST re-register when the AS changes.

### Governance

- A **feature lifecycle policy** with Active / Deprecated / Removed states, a **minimum twelve-month
  deprecation window**, and a registry of deprecated features.

---

## 2. Maturity, stated precisely

The task asks to separate normative obligation from optional extension from real support. The
specification itself makes the distinction, and it is sharper than the marketing:

| Thing | What it actually is |
|---|---|
| Stateless core, `server/discover`, MRTR, `resultType` | **Normative core.** MUST-level. |
| **Tasks** | **Optional extension** `io.modelcontextprotocol/tasks`. Opt-in, negotiated. |
| **MCP Apps** | **Optional extension**. |
| **Skills over MCP** | **Not an extension at all** — a [community working group](https://modelcontextprotocol.io/community/working-groups/skills-over-mcp). |

Skills over MCP being a working-group item rather than a ratified extension is the single most
over-read item in the announcement cycle. It is not something to plan against yet.

---

## 3. Where this collides with Tachyon

### 3.1 The Bridge is built on precisely what was removed

`src/bridge/Bridge.ts` mints "a transport + McpServer pair kept in `sessions`" on an **initialize**
POST, keyed by the **`mcp-session-id`** header (`:87-88`, `:327-328`, `:358`). The revision deletes
both the handshake and the header. A move to 2026-07-28 is not a version bump for Tachyon; it is a
rewrite of how the Bridge holds anything across calls.

### 3.2 The adversarial finding — statelessness attacks Tachyon's identity primitive

This is the item the task's adversarial clause exists to catch, and it is a genuine hazard rather
than a theoretical one.

Tachyon's authority model rests on **Bridge-resolved caller identity**. Every governed door —
`propose_saved_agent`, `cancel_saved_agent_proposal`, `notify_agent`, the grant gate — refuses with
`CALLER_REQUIRED` unless the Bridge itself resolved a named agent caller, and **no tool takes a
`proposer`/`agent` parameter**, precisely so there is nothing to forge. That property is what several
recent reviews (`t-3bde32`, SDD 482 phase 4) verified and depend on.

The revision's replacement for cross-call state is: *"explicit, server-minted handles passed as
ordinary tool arguments."* Applied naively to identity, that converts a Bridge-resolved fact into a
**client-supplied argument** — exactly the spoofing surface the current design refuses to have. A
server-minted handle is unforgeable only if the client cannot obtain another agent's handle; in a
fleet where agents share a workspace and can read each other's files, that assumption needs proving,
not assuming.

**Recommendation: do not move caller identity onto the wire as a tool argument.** If Tachyon ever
goes stateless, identity must stay bound to the authenticated transport (the Bridge already
authenticates), with the handle carrying *session scope*, never *principal*.

### 3.3 MRTR versus approvals and the Human Inbox — the genuinely attractive one

MRTR is the closest thing in this revision to something Tachyon already built by hand. Today a
governed approval is: agent asks → proposal persisted → human decides in the Inbox → agent learns
later. MRTR's shape is: server returns `input_required` → client retries with `inputResponses`.

They are *not* the same, and the difference matters. MRTR is a **retry-based** protocol with no
durable handle by itself — the elicitation changelog entry says so explicitly: the completion
notification and `elicitationId` were removed because "the client learns the outcome of an
out-of-band interaction by retrying the original request", and servers needing correlation "encode
their own identifier in `requestState`".

Tachyon's approvals are durable, digest-bound, expiring, single-use and auditable. MRTR alone does
not provide any of those. It is a decent **transport** for mid-turn input; it is not a replacement
for the governance around it.

### 3.4 MCP Tasks versus Board Tasks — do not conflate

MCP Tasks are a transport-level handle for one long-running *operation*. Board Tasks are the unit of
governed work with assignee, journal, evidence and lifecycle. The names collide; the concepts do not
overlap. If MCP Tasks is ever adopted it should be an implementation detail beneath a long-running
Bridge call, and the report recommends never surfacing the word "task" from that layer into product
vocabulary.

### 3.5 Deprecations that are free wins

Roots, Sampling and Logging are deprecated with a twelve-month window. **Tachyon should confirm it
does not depend on them** and, if it does, plan removal on that clock rather than discovering it at
removal. This is cheap to check and cheap to fix now.

### 3.6 Auth — the one place to act early

The `iss` validation MUST, the issuer-keying MUST/MUST NOT, and the DCR→CIMD deprecation are all
independent of the stateless rewrite and independent of SDK support for the new revision. They are
about how Tachyon persists and reuses OAuth credentials for runtimes — a surface where this project
already had a P0 (`t-de73e0`, a credential destroyed by writing through a symlink).

---

## 4. The matrix

| Change | Normative? | Real support today | Tachyon today | Benefit | Risk | Recommendation |
|---|---|---|---|---|---|---|
| Stateless core, no sessions | MUST | **SDK 1.29.0 does not know 2026-07-28** | Bridge is session-keyed on `mcp-session-id` | Serverless/remote Bridge, restart recovery | Identity becomes a wire argument (§3.2) | **Monitor** until SDK ships; design identity binding first |
| `server/discover` | MUST | None | n/a | Up-front version selection | Low | **Monitor** |
| MRTR | MUST | None | Approvals + Human Inbox (durable, digest-bound) | Standard mid-turn input transport | Retry-based, no durability of its own | **Prototype** behind the existing governance, never replacing it |
| `resultType` on results | MUST | None | n/a | Cheap | Low | **Monitor** |
| SSE resumability removed | MUST | None | Bridge uses Streamable HTTP | Simpler | A broken stream now loses the request | **Monitor**; note the reliability regression |
| Tasks | Extension | None | Long ops are bespoke | Standard polling + mid-flight input | Name collision with Board Tasks | **Prototype** only after SDK support |
| MCP Apps | Extension | None | Webview surfaces (Inbox, Studio, previews) | Inline interactive UI | Would move trusted UI to a server-driven surface | **Reject for governed surfaces**; monitor for previews |
| Skills over MCP | **Community WG, not an extension** | None | Skills/plugins are authority-bound | — | Planning against an unratified idea | **Reject for now** |
| Roots / Sampling / Logging deprecated | Deprecation, 12mo | n/a | Unknown — needs a check | Avoid a forced migration later | Discovering it at removal | **Adopt now**: audit dependence |
| `iss` validation, issuer-keyed credentials, `application_type` | MUST / SHOULD | Independent of revision support | Governed runtime login | Real security hardening | Low | **Adopt now** (own Task) |
| DCR → Client ID Metadata Documents | Deprecation | Unknown | Unknown | Simpler registration | — | **Monitor** |

---

## 5. Adversarial review of my own top recommendations

- **"Go stateless for a remote Bridge"** is the most attractive-sounding item and the one I most
  distrust. It trades a mature, governed, identity-bound primitive for an unimplemented protocol
  revision, and its replacement mechanism pushes state into client-supplied arguments. The benefit is
  real but speculative; the risk lands directly on the property every authority check depends on.
  Held at *monitor* deliberately.
- **"Replace approvals with MRTR"** would be the classic trap the task warns about. MRTR carries no
  durability, no digest binding, no expiry, no single-use guarantee, no audit trail. Adopting it as a
  transport is reasonable; adopting it as the governance would delete controls that took several
  slices to build and were adversarially reviewed.
- **"Use MCP Apps for the Human Inbox"** is rejected outright rather than monitored, because the
  Inbox is where a human authorizes durable authority. A server-driven UI surface is the wrong
  trust boundary for the one screen whose integrity the whole creation door depends on.

---

## 6. What this report did NOT verify

Stated rather than implied, because the task asks for evidence-based conclusions:

- The **Tasks and Apps extension documents** were not fetched; their treatment here rests on the
  specification index and changelog descriptions only.
- **Per-runtime client support** (Claude, Codex, Grok, OpenCode, Pi, Hermes) was not measured. The
  SDK finding makes it moot for adoption timing, but the matrix's "real support" column is therefore
  evidenced only for this repository, not for every client Tachyon talks to.
- **No parity dimension was measured**, so `docs/runtimes/parity.md` is deliberately left untouched —
  the task says to update it only if there is a measured MCP parity dimension, and there is not.

---

## 7. Follow-up Tasks proposed

Only concrete and independent items, per the task's instruction:

1. **Audit Tachyon's dependence on Roots, Sampling and Logging** and plan removal inside the
   twelve-month window. Independent of everything else here.
2. **Harden OAuth credential handling to the new MUSTs**: validate `iss` before redeeming, key
   persisted credentials by issuer and never reuse across authorization servers, send
   `application_type` on DCR. Independent of the revision's transport changes.

Both are filed separately. Nothing else here is actionable until the SDK speaks `2026-07-28`.
