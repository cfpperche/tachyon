# 414 — browser-user-companion

_Created 2026-07-19._

**Status:** draft
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred.
     When this ships, add a **Closure:** line here recording what shipped (commit/evidence);
     `/sdd close` flags a shipped spec that still lacks one (alongside unchecked boxes,
     placeholders, and missing dogfood proof or opt-out). -->

**Board task:** `t-dec8a9` (design) · **Source pin:** `p-2112a8`  
**Kind of this document:** concept brief + SDD seed (intent-first; plan/tasks after design ratify)

## Intent

Tachyon agents and humans collaborate inside the VS Code shell and the engine/Bridge, but most product
work, research, bug repros and operational tools live in the **user's everyday browser**. Today the
only browser path is **agent-owned automation** (`agent-browser`, specs 267/268/271): a headless or
agent-session Chrome driven over CDP. That cannot see the human's real logged-in tabs, cannot surface
approvals where the human already is, and forces copy-paste of URLs, selections and screenshots into
tasks.

This seed proposes a **Browser User Companion**: a user-installed extension (Chromium first;
Firefox/Safari later) that **pairs with the local Tachyon engine/Bridge** as another thin shell —
not a second orchestrator and not a reimplementation of Mission Control. v1 turns the browser into a
**sensor + approval surface**: pair, capture tab context into Tasks/notes, receive and resolve
approvals. Later phases may add consented in-page assist and tightly scoped actuation on the user's
session.

"Done" for the full product line means: a human can install an extension, pair it to a running
workspace engine, send the active tab into the board without leaving the browser, and receive
delegation approvals there — while agents consume only **human-authorized, cookie-free captures** via
Bridge tools. This seed only locks the problem, boundaries, MVP shape and open forks; implementation
is out of scope until design is ratified.

**Affected Product Invariants:** none — design seed; no registered product promise changes.

## Concept brief

### Product form

| Name | Browser User Companion |
|---|---|
| Form | Browser extension (MV3 Chromium v1) + engine pairing module + optional agent skill |
| Audience | Humans running Tachyon locally (or later a remote engine they control) |
| Primary job | Bring real web work context into Tachyon and bring Tachyon approvals back to the browser |
| Non-job | Replace VS Code Control; replace agent-browser; become a general RPA product |

### Two browser products (must not conflate)

| | **agent-browser (267+)** | **Browser User Companion (this seed)** |
|---|---|---|
| Who owns the browser | Agent / Tachyon-provisioned session | The human's daily browser |
| Session | Isolated, often headless | User cookies, extensions, SSO as-is |
| Direction | Engine → CDP automation | User browser ↔ engine/Bridge |
| v1 risk class | Tool + skill provision | Privacy + pairing + shell auth |
| Tool namespace (sketch) | existing `agent-browser` launcher | `user_browser_*` (read/capture only in v1) |

### Value for agents assisting projects

1. **Context without paste** — active tab URL, title, selection, optional screenshot become Task body /
   journal / evidence, so agents implement against real repros and research sources.
2. **Approvals where the human is** — `request_human_approval` / needs-input style surfaces in the
   extension UI, with resolution still host-authoritative (`get_approval_status` remains truth).
3. **Project loop** — dogfood a webapp, file a task with rich context, agents fix, human verifies in
   the same browser surface.
4. **Later automation** (not v1) — consented fills/clicks on **user** sessions for internal tools,
   release checklists, multi-SaaS ops — under Bridge approval and per-host scopes.

### Architecture sketch (non-normative until plan)

```text
[User browser extension]  --pair token / loopback-->  [Engine control + Bridge auth]
        |                                                      |
   capture / approvals UI                          tasks · approvals · agents · notify
        |                                                      |
   (no cookies to agents)  <--- Bridge tools ---  agents via user_browser_* (v1 read)
```

Aligns with system-design: engine owns orchestration; shells adapt. VS Code remains the primary
human shell; the extension is a **second shell**, same class as the deferred mobile companion
(`t-fe52f0` frente 2) and any future CLI/web shell. Likely depends on a durable external-client /
service-layer path (`t-784bc8` lineage) for clean pairing outside the VSIX process.

### Security posture (v1 principles)

- **Least privilege:** default `activeTab` + user gesture; avoid always-on `<all_urls>`.
- **No credential exfil:** agents never receive cookies, passwords, or raw auth headers; captures are
  content the human chose to send (URL/title/selection/screenshot bytes as evidence).
- **Pairing:** short-lived codes / local loopback; token storage hardened; unpair is one click.
- **No self-approval:** extension UI is a presentation + human gesture channel; approval records stay
  engine/host authored (same anti-laundering rules as Control → Approvals).
- **Engine offline:** degrade to local draft queue or clear error — never invent orchestration in the
  extension.
- **Fail closed** on unknown host, expired pair, or missing scope.

### Phased delivery (proposal)

| Phase | Scope | Ship gate (sketch) |
|---|---|---|
| **v1 — Companion** | Pair; fleet badge; send tab → task/note; show + resolve approvals | Chromium unpacked dogfood + Bridge tools read |
| **v1.1** | Firefox; selection/screenshot quality; multi-workspace picker | Store packaging optional |
| **v2 — In-page assist** | Overlay/side panel anchored to page; agent suggestions without write | Visual QA + consent copy |
| **v3 — Actuation** | Scoped click/fill on allowlisted hosts with per-action confirm | Trust policy sibling to 271 |

### Packaging sketch

- **Extension** — separate package (store / sideload); not a Tachyon runtime plugin in the 250 sense.
- **Engine module** — pairing, scopes, Bridge tools, approval projection.
- **Optional skill** — teaches agents when/how to call `user_browser_*` if a companion is paired.
- A Tachyon "plugin" entry may later **distribute or document** the extension; it does not replace the
  browser store package.

## Acceptance criteria

_These criteria define the **design seed** being complete enough to ratify — not the product shipped.
Implementation acceptance will replace/extend this list in a later revision after plan._

- [ ] **Scenario: design distinguishes user companion from agent-browser**
  - **Given** a reader of this seed and specs 267/268/271
  - **When** they compare ownership, session model and tool namespaces
  - **Then** the two products are explicitly non-substitutable and non-merged in intent
- [ ] **Scenario: v1 MVP is bounded**
  - **Given** the ratified concept
  - **When** implementation is scoped
  - **Then** v1 is limited to pair + capture + approval surface (no form-driving, no full Control clone)
- [ ] **Scenario: agent-visible context is human-authorized and cookie-free**
  - **Given** a paired extension and an agent using Bridge tools
  - **When** the human sends a tab capture
  - **Then** agents can only observe the authorized capture fields; cookies/credentials are not in the tool result
- [ ] **Scenario: approval resolution stays host-authoritative**
  - **Given** an approval shown in the extension
  - **When** the human accepts or denies
  - **Then** the engine records the resolution and agents must confirm via the existing status path (not the UI string alone)
- [ ] Concept brief sections (intent, form, security, phases, non-goals, open questions) are present and maintainer-reviewed
- [ ] Board design task `t-dec8a9` links this SDD and pin `p-2112a8`
- [ ] Related work (`t-fe52f0`, agent-browser, external-client/API gap) is named so decomposition does not reinvent them

_Product implementation scenarios (to be promoted after design ratify):_

- [ ] **Scenario: pair extension to local engine** _(implementation — deferred)_
  - **Given** a running Tachyon engine for a workspace and an installed Chromium extension
  - **When** the human completes pairing with a short-lived code from Control (or equivalent)
  - **Then** the extension shows connected state for that workspace and can call authorized companion endpoints
- [ ] **Scenario: send active tab into a Task** _(implementation — deferred)_
  - **Given** a paired extension on an ordinary page and a user gesture
  - **When** the human chooses "Send to Tachyon"
  - **Then** a Task (or journal/note) appears with URL, title and optional selection/screenshot evidence
- [ ] **Scenario: receive and resolve an approval in the browser** _(implementation — deferred)_
  - **Given** a pending human approval in the engine
  - **When** the extension is paired and online
  - **Then** the human can Accept/Deny from the extension and `get_approval_status` reflects the host record

## Non-goals

- Replacing or forking Mission Control / Control as a full browser app in v1
- Merging with `agent-browser` CDP automation or reusing its session store as the user session
- Agent-initiated arbitrary DOM/JS execution or always-on full-history scraping
- Safari first-class support in v1 (Chromium first; Firefox next)
- Mobile companion UX (tracked under `t-fe52f0`; may share pairing protocols later)
- Marketplace monetization or multi-tenant SaaS hosting of engines
- Changing PI-001 or any registered product invariant in this seed
- Implementation code, VSIX packaging of the extension binary, or store submission in this design task

## Open questions

1. **Umbrella ownership** — Is this a child of `t-fe52f0` (companion family) or a standalone product line with a sibling link only?  
   _Owner: maintainer. Path: decide at design ratify; affects task tree and naming._

2. **MVP depth** — Ship **capture-only** first, or capture + approval surface together?  
   _Owner: maintainer. Recommendation in discussion: both in v1 if pairing cost is paid once._

3. **External client substrate** — Block on `t-784bc8` / service-layer generalization, or allow a
   minimal loopback pairing prototype against today's engine control channel?  
   _Owner: maintainer + engine owners. Path: spike after ratify._

4. **Tool surface v1** — Human-push only (`send tab` creates task; agents read task artifacts) vs
   agent-pull (`user_browser_context` requests a fresh capture with human prompt)?  
   _Owner: design. Recommendation: human-push only in v1; agent-pull in v1.1._

5. **Multi-workspace** — One extension ↔ one engine, or picker for multiple local engines?  
   _Owner: design. Recommendation: one active pair in v1; multi later._

6. **Evidence store** — Screenshots as Task attachments (spec 273/274 lineage) vs pin blobs vs new
   companion evidence kind?  
   _Owner: implementation plan after ratify._

7. **Name** — "Browser User Companion" vs "Tachyon Browser Companion" vs shorter product name?  
   _Owner: maintainer branding._
