# 490 — formation-authority-bootstrap — tasks

_Generated from `plan.md` on 2026-08-04. Work top-to-bottom. Check boxes as tasks complete. If a task reveals the plan is wrong, update `plan.md` before continuing._

## Implementation

### Fatia A — the bootstrap door (delivered)

- [x] Let `beginMutationBarrier` express the bootstrap CAS (`expectedGenerationSha256` absent = "there
      must be no prior generation"), so moment zero produces the same durable receipt every other
      mutation does instead of a second audit format.
- [x] `bootstrapTransaction.ts` — `FormationBootstrapService`: derive generation 1 from the bytes on
      disk, bind profile and lane digests, publish under the barrier, `inspect` and `recover`.
- [x] `adoptionHost.ts` — the write host, granting `bootstrap` for a `human` caller in this workspace
      and nothing else. The spawn host in `lifecycleHost.ts` stays read-only, untouched.
- [x] `Workspace.adoptFormationAuthority` / `inspectFormationAuthority` / `recoverFormationAdoption` —
      in-process only: no protocol action, no editor command, not on the studio target interface.

### Fatia A — not done, and named rather than implied

- [ ] The Agent Studio gesture that calls the door. Until it ships nobody can adopt through the
      product. Constraint carried into the follow-up: in-process call only — adding an
      `ExtensionCommandV1` action, a `vscode.commands` id, or a `WorkspaceAgentStudioTarget` member
      would each hand the mutation to any agent on the control socket.

## Verification

_Acceptance checks tied to `spec.md`. Each should map to a checklist item there._

- [x] Generation 1 is atomic, digest-bound, identity-bound, and leaves a durable who/when receipt;
      a second generation 1, a second operation id, and bytes that moved are each refused.
- [x] An unadopted agent delivers nothing however its `agent.yml` declares its lanes, and the adopted
      Soul reaches the composed prompt through the same lifecycle port afterwards.
- [x] The single-door guard is an AST walk over `src/**/*.ts`, covers dynamic pass-throughs, and was
      watched fail — both on synthetic input and on a real second-door file dropped into `src/`.
- [x] The three agent-reachable routes (control-socket action, editor command, studio target
      interface) are each asserted absent.

**Headless check:** `npx vitest run test/unit/agentFormationBootstrap.test.ts`

**Verify:** `npx vitest run test/unit/agentFormationBootstrap.test.ts`
<!-- A mechanical command an agent can run to validate this spec's implementation
     without a human (tests / build / lint). Kept green = the spec stays delivered.
     To make `/sdd verify` re-run it, also declare it on a **Verify:** line, e.g.:
       **Verify:** `npm test`
     `/sdd verify` reads the FIRST backtick span per **Verify:** line, previews by
     default, and runs only with --run. Multiple **Verify:** lines run in order. -->

## Dogfood

**Dogfood-Opt-Out:** the shipped behaviour is an in-process extension-host door with no CLI or Bridge
surface — by construction, since any headless entry point would be an agent-reachable route. The
end-to-end path it enables (adopt, then spawn and see the Soul arrive) is exercised in-process by
`agentFormationBootstrap.test.ts` against the real lifecycle port, and becomes dogfoodable once the
Agent Studio gesture ships.
<!-- A representative command that exercises the shipped behavior end-to-end.
     `/sdd dogfood` previews by default and runs only with --run, then logs under
     notes.md `## Dogfood log`. If no meaningful headless dogfood exists, replace
     the Dogfood line with: **Dogfood-Opt-Out:** <non-empty reason>. -->

**Human dogfood:** optional
<!-- Opt-in: a short walkthrough a human follows to approve the spec (demo steps,
     UI routes, things to eyeball). Name the steps here when human sign-off matters. -->

## Visual QA

_Optional for UI/interface/rendered-output work. Keep prose-based: real surface inspected, evidence captured, verdict recorded. If not useful, declare `**Visual QA Opt-Out:** <reason>`._

_Do not create a prototype or evidence file just to satisfy this section. If a durable spec-specific artifact is useful, store it inside this spec directory (for example under `prototypes/` or `evidence/`) and reference its path in backticks after `Prototype:` or `Evidence:`. If it must live elsewhere, declare `**Artifact-Location-Opt-Out:** <reason>`._

**Visual QA Opt-Out:** Fatia A ships no rendered surface. It belongs on the Agent Studio follow-up,
where the anchor is already written by spec.md: an unadopted agent's lane fields must state that it
has no authority yet and name the adoption action — never present, inviting and inert.

## Cookbook

_Optional operator/agent how-to. Not scaffolded by `new`. When this ship adds a Bridge tool, CLI, registry lifecycle, or other usable surface, add `cookbook.md` (via `sdd-cookbook.sh <490>`) and declare **Cookbook:** yes — or **Cookbook-Opt-Out:** &lt;reason&gt;. `close` warns (does not hard-fail) if a likely operator surface ships without either._

<!-- **Cookbook:** yes -->
<!-- **Cookbook-Opt-Out:** pure internal refactor; no new operator surface -->
