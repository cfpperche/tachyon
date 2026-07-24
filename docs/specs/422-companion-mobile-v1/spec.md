# 422 — companion-mobile-v1

_Created 2026-07-21._  
_Research: `docs/architecture/companion-mobile-v1-research.md` (`t-619157`)._  
_**Maintainer ratified M1–M8** 2026-07-21 (conversation)._

**Status:** shipped-partial
<!-- Bare enum only: draft | in-progress | shipped | shipped-partial | superseded | abandoned | deferred. -->

**Board:** umbrella `t-af2c9b` · product card `t-fe52f0` (frente 2) · research `t-619157` done · parent browser 414 shipped · dogfood `t-900149` done  
**Kind:** product SDD (Companion mobile external shell) — PWA + Tailscale pair + narrow fleet controls  
**Out of trail:** `t-784bc8` Runtime API extraction · browser residual `t-cb36c5` · reopen 414/420  
**Shipped-partial residual:** concurrent browser+mobile sessions; Headscale; deeper A2HS/PRIVACY; TLS v1.1  

## Intent

Tachyon already pairs a **browser** companion to the local engine (`/companion/v1`, SDD 414/420). Humans away from the desk still cannot see fleet attention or answer a short prompt / approval without the laptop.

This spec defines **Tachyon Companion Mobile v1**: a **local-first web app / installable PWA** (`apps/mobile` in `tachyon-companion`) that pairs with the **same engine** as a thin shell — observe roster/attention, send a bounded prompt, resolve host-authoritative approvals — over an **opt-in Tailscale mesh** reachability path (not multi-NIC raw Wi‑Fi). The phone is not a second orchestrator, not Mission Control cloud, and not a browser-tab automation client.

**Done for product v1:** human enables mobile companion (`lanAccess`), installs Tailscale on PC (engine host) + phone (same tailnet), scans a QR (`openUrl` → engine-served `/companion/app/#pair=`) from Control, sees agents, sends a short prompt or Accept/Deny an approval, and unpairs — without store apps, cloud companion SaaS, terminal scrollback, or Runtime API unificação.

**Affected Product Invariants:** none expected — external shell; re-check if LAN bind changes any registered trust boundary wording.

## Relation to 414 / 420

| | 414/420 (browser) | 422 (this) |
|---|---|---|
| Client | Chromium MV3 extension | Mobile PWA / local web |
| Repo | `tachyon-companion` `apps/browser` | `apps/mobile` |
| Protocol | `/companion/v1`, `client.kind` | Same; `kind: "mobile"` |
| Reachability | Loopback `127.0.0.1` | **Opt-in LAN** (+ loopback remains default) |
| Tab tools | `user_browser_*` (420) | **Out of scope** |

414 stays **shipped**. 420 stays **shipped-partial**. This SDD does not reopen them.

## Ratified decisions (M1–M8)

| # | Decision | Value |
|---|---|---|
| M1 | Form | PWA / local web in `apps/mobile` |
| M2 | Network | Opt-in bind + QR pair; **phone path = Tailscale mesh only** (v1) |
| M3 | Protocol | Reuse `/companion/v1` + existing pair; `client.kind=mobile` |
| M4 | Concurrent devices | **v1 = last-pair-wins** (one session); concurrent browser+mobile deferred |
| M5 | Caps v1 | Roster + attention + prompt + approvals only |
| M6 | ADE scope | Minimal: LAN flag, QR/baseUrl, static mobile assets if needed |
| M7 | Spec vehicle | **This SDD** (new); not fold into 414 |
| M8 | Board | Implement under umbrella `t-af2c9b` + `t-fe52f0` frente 2 |

**Deferred open (defaults for v1):** TLS on LAN → v1.1 trusted-LAN HTTP OK with doctor warning; serve mobile from engine static preferred for dogfood, monorepo dev server OK in development.

## Concept brief

| Field | Value |
|---|---|
| Product name | Tachyon Companion (Mobile) |
| Form | PWA + engine pairing |
| Audience | Humans with Tachyon on a local machine |
| Primary job | Fleet attention + short human→agent / approval from phone |
| Non-job | Full Control; terminal mux; git UI; cloud; tab RPA |

## Capabilities allowlist (fail-closed)

| Capability | v1 |
|---|---|
| Pair / unpair / status | Yes |
| Live roster (agents + coarse state) | Yes |
| Attention / needs-input | Yes |
| Send short prompt to named agent | Yes |
| List + resolve approvals (host-authoritative) | Yes |
| Terminal scrollback / read_output | **No** |
| Arbitrary write_input / keys | **No** |
| user_browser_* tab tools | **No** |
| Multi-engine picker | **No** |
| Cloud push / store native | **No** |

## Architecture sketch

```text
[Phone PWA apps/mobile]
    |  QR: { baseUrl, pairCode, protocolVersion }
    |  Bearer companion session token
    v
[Engine Bridge listener — companion routes]
    loopback default; mobile: bind 0.0.0.0 + Tailscale pair URL when lanAccess
    /companion/v1/* + GET /companion/app/* (PWA)
    |
    v
[Workspace fleet — same authority as Control]
```

## Acceptance criteria

### Design

- [x] Research doc exists and M1–M8 ratified by maintainer
- [x] This SDD captures intent without reopening 414/420
- [x] Board umbrella `t-af2c9b` lists implementation slices (`t-da645b` … `t-900149`)

### Product

- [ ] **Scenario: LAN off by default**
  - **Given** default settings
  - **When** phone tries to reach companion on LAN IP
  - **Then** connection fails; only loopback works (browser path unchanged)
- [ ] **Scenario: opt-in LAN + QR pair**
  - **Given** human enables LAN companion access and issues pair code
  - **When** phone scans QR / opens baseUrl and submits pair code with `client.kind=mobile`
  - **Then** session is established; Control Connected devices shows a mobile row
- [ ] **Scenario: roster + attention**
  - **Given** a paired mobile session and at least one managed agent
  - **When** mobile opens live state
  - **Then** agent names and coarse attention/need-input are visible without terminal scrollback
- [ ] **Scenario: prompt**
  - **Given** paired mobile and an idle agent
  - **When** human sends a short prompt from the phone
  - **Then** the engine delivers it under the same idle-safe rules as browser companion prompt
- [ ] **Scenario: approvals**
  - **Given** a pending host-authoritative approval
  - **When** mobile lists and resolves Accept or Deny
  - **Then** the host record updates; agents only see authorized outcomes
- [ ] **Scenario: unpair**
  - **Given** an active mobile session
  - **When** human unpairs from phone or force-unpairs from Control
  - **Then** further companion calls fail closed until re-pair
- [ ] **Scenario: fail-closed caps**
  - **Given** paired mobile
  - **When** client requests scrollback or tab tools
  - **Then** no such v1 surface is offered (404/omission); no agent-visible secret dump path

## Non-goals

- `t-784bc8` Runtime API / service-layer extraction  
- Replacing Control or Mission Control  
- Native iOS/Android store binaries in v1  
- Browser tab automation from phone  
- Full terminal read/write on phone  
- Cloud relay / multi-tenant accounts  
- Monorepoizing ADE (`t-e4348c`)  

## Open questions (non-blocking defaults above)

- Exact settings key name (`lanAccess` vs `allowLan`)  
- Whether companion can bind LAN without exposing full Bridge MCP on LAN (prefer companion-only if feasible)  
- mDNS / hostname discovery (post-v1)  
