/**
 * SDD 490 Fatia A — moment zero.
 *
 * Two kinds of test live here and they answer different questions.
 *
 * **Behavioral** — does the door do what adoption means? Generation 1, atomic, bound to the exact
 * bytes and identity, with a durable who/when receipt; a file that still cannot activate itself; an
 * unadopted agent that is honest rather than broken.
 *
 * **Reachability** — is it the ONLY door? A green behavioral test proves the door you called works;
 * it never proves it was the only one. `0.56.159` shipped a coalescing fix with green units and
 * changed nothing live, because the tests called the one coalesced entry point while five other call
 * sites bypassed it. So the reachability half enumerates the routes an agent can actually reach and
 * asserts none of them arrives here — and the scanner behind it is fed a synthetic violation first,
 * because on 2026-08-03 a static guard written for exactly this purpose passed on every violation it
 * was supposed to catch. A guard nobody has watched fail is not a guard.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { createFormationAdoptionHost } from "../../src/agents/formation/adoptionHost.js";
import { createFormationLifecycleHost } from "../../src/agents/formation/lifecycleHost.js";
import { FormationAuthorityStore } from "../../src/agents/formation/authorityStore.js";
import { HumanLaneTransactionService } from "../../src/agents/formation/humanLaneTransactions.js";
import { formationDigest } from "../../src/agents/formation/domain.js";
import {
  bootstrapCallSites,
  BOOTSTRAP_DOOR_MODULE,
  DYNAMIC_MUTATION_CALL_SITES,
} from "../helpers/formationBootstrapScan.js";

const HOST_KEY = Buffer.alloc(32, 9);
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const PROFILE_ID = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_ID = "workspace-test";
const HUMAN = { principal: "editor.workspace-test", kind: "human" as const };
const INSPECTOR = { adapter: "codex", id: "inspector", version: "1", sha256: "c".repeat(64) };
const EFFECTIVE = "d".repeat(64);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** A canonical profile agent exactly as it exists on disk before anyone adopts it. */
function unadoptedWorkspace(options: { soul?: boolean; instructions?: boolean } = {}): {
  root: string;
  profileDir: string;
  soulBody: string;
  instructionsBody: string;
  profileSha256: string;
  soulSha256: string;
  instructionsSha256: string;
} {
  const withSoul = options.soul !== false;
  const withInstructions = options.instructions !== false;
  const root = temporaryRoot("tachyon-490-ws-");
  const profileDir = path.join(root, ".tachyon", "agents", "codex");
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(root, ".tachyon"), 0o700);
  fs.chmodSync(path.join(root, ".tachyon", "agents"), 0o700);
  fs.chmodSync(profileDir, 0o700);

  const soulBody = "# Soul\n\nSteady, precise, and candid.\n";
  const instructionsBody = "Prefer small, reviewable commits.\n";
  if (withSoul) {
    fs.writeFileSync(path.join(profileDir, "SOUL.md"), soulBody, { mode: 0o600 });
    fs.writeFileSync(path.join(profileDir, "profile.json"), `${JSON.stringify({
      schemaVersion: 2,
      profileId: PROFILE_ID,
      owner: "codex",
      state: "active",
      agentId: AGENT_ID,
    }, null, 2)}\n`, { mode: 0o600 });
  }
  if (withInstructions) fs.writeFileSync(path.join(profileDir, "instructions.md"), instructionsBody, { mode: 0o600 });

  const profileText = stringify({
    schemaVersion: 1,
    agentId: AGENT_ID,
    runtime: { adapter: "codex", executable: "codex" },
    prompt: {
      ...(withSoul ? { soul: "soul" } : {}),
      ...(withInstructions ? { instructions: "instructions" } : {}),
    },
    references: [
      ...(withSoul
        ? [{ id: "soul", kind: "soul", scope: "profile", owner: AGENT_ID, path: "SOUL.md", mode: "pinned", sha256: sha256(soulBody) }]
        : []),
      ...(withInstructions
        ? [{ id: "instructions", kind: "instructions", scope: "profile", owner: AGENT_ID, path: "instructions.md", mode: "pinned", sha256: sha256(instructionsBody) }]
        : []),
    ],
  });
  fs.writeFileSync(path.join(profileDir, "agent.yml"), profileText, { mode: 0o600 });
  return {
    root,
    profileDir,
    soulBody,
    instructionsBody,
    profileSha256: sha256(profileText),
    soulSha256: sha256(soulBody),
    instructionsSha256: sha256(instructionsBody),
  };
}

function adoptionHost(hostRoot: string) {
  const host = createFormationAdoptionHost({ hostKey: HOST_KEY, hostRoot, workspaceId: WORKSPACE_ID });
  if (!host) throw new Error("adoption host was unavailable");
  return host;
}

function lifecycleHost(hostRoot: string, workspaceRoot: string, suppressed: boolean) {
  const port = createFormationLifecycleHost({
    hostKey: HOST_KEY,
    hostRoot,
    workspaceId: WORKSPACE_ID,
    workspaceRoot,
    runtimeAdapterOf: () => "codex",
    agentIdOf: () => AGENT_ID,
    nativeSuppressionConfirmed: () => suppressed,
    runtimeTrustClassOf: (adapter) => adapter,
  });
  if (!port) throw new Error("lifecycle port was unavailable");
  return port;
}

function adoptInput(workspaceRoot: string, extra: Record<string, unknown> = {}) {
  return {
    operationId: `formation-adopt.${crypto.randomBytes(8).toString("hex")}`,
    caller: HUMAN,
    workspaceId: WORKSPACE_ID,
    workspaceRoot,
    agentName: "codex",
    runtimeInspector: INSPECTOR,
    effectiveSha256: EFFECTIVE,
    ...extra,
  };
}

describe("formation authority bootstrap — the adoption door", () => {
  it("publishes generation 1 bound to the exact bytes, identity and workspace, with a durable receipt", async () => {
    const workspace = unadoptedWorkspace();
    const hostRoot = temporaryRoot("tachyon-490-host-");
    const host = adoptionHost(hostRoot);

    const record = await host.service.adopt(adoptInput(workspace.root, { expectedProfileSha256: workspace.profileSha256 }));

    expect(record.vector.generation.generation).toBe(1);
    expect(record.vector.generation.priorGeneration).toBe(0);
    expect(record.vector.generation.retired).toBe(false);
    expect(record.vector.profile.revision).toBe(1);
    expect(record.vector.profile.workspaceId).toBe(WORKSPACE_ID);
    expect(record.vector.profile.agentId).toBe(AGENT_ID);
    expect(record.vector.profile.agentName).toBe("codex");
    // Bound to the exact bytes on disk, not to a name or a path.
    expect(record.vector.profile.canonicalSha256).toBe(workspace.profileSha256);
    expect(record.vector.profile.lanes.soul).toMatchObject({ mode: "profile", sourceSha256: workspace.soulSha256, subjectId: PROFILE_ID });
    expect(record.vector.profile.lanes.instructions).toMatchObject({ mode: "profile", sourceSha256: workspace.instructionsSha256 });
    // Evolution and memory have their own publishers; adoption does not author them.
    expect(record.vector.profile.lanes.evolution).toEqual({ mode: "disabled" });
    expect(record.vector.profile.lanes.memory).toEqual({ mode: "disabled" });

    // Who, when, from which bytes — durable, not reconstructed.
    expect(record.receipt).toMatchObject({ mutation: "bootstrap", outcome: "committed", agentId: AGENT_ID, workspaceId: WORKSPACE_ID });
    expect(record.receipt.priorGenerationSha256).toBeUndefined();
    expect(record.receipt.nextGenerationSha256).toBe(formationDigest(record.vector.generation));
    expect(Number.isFinite(Date.parse(record.receipt.completedAt))).toBe(true);
    expect(host.store.mutationReceipt(record.receipt.operationId, HUMAN)).toMatchObject({ outcome: "committed" });
    expect(record.source).toMatchObject({
      agentId: AGENT_ID,
      profileSha256: workspace.profileSha256,
      soulSha256: workspace.soulSha256,
      instructionsSha256: workspace.instructionsSha256,
    });
    // The transaction left no barrier behind: the bracket is closed, not abandoned.
    expect(host.store.mutationBarrier(AGENT_ID, HUMAN)).toBeUndefined();
  });

  it("refuses to adopt bytes the human did not see, and refuses a second generation 1", async () => {
    const workspace = unadoptedWorkspace();
    const host = adoptionHost(temporaryRoot("tachyon-490-host-"));

    await expect(host.service.adopt(adoptInput(workspace.root, { expectedProfileSha256: sha256("other bytes") })))
      .rejects.toThrow("agent.yml changed since it was read");

    await host.service.adopt(adoptInput(workspace.root));
    await expect(host.service.adopt(adoptInput(workspace.root))).rejects.toThrow("already under formation authority");
    // And the raw store CAS is the backstop under the door's own check.
    expect(() => host.store.replaceVector({
      operationId: "second-bootstrap",
      caller: HUMAN,
      mutation: "bootstrap",
      vector: host.store.currentVector(AGENT_ID)!,
    })).toThrow("formation generation CAS mismatch");
  });

  it("replays one operation id instead of publishing a second generation", async () => {
    const workspace = unadoptedWorkspace();
    const host = adoptionHost(temporaryRoot("tachyon-490-host-"));
    const input = adoptInput(workspace.root);

    const first = await host.service.adopt(input);
    const replayed = await host.service.adopt(input);

    expect(formationDigest(replayed.vector)).toBe(formationDigest(first.vector));
    expect(replayed.vector.generation.generation).toBe(1);
    expect(replayed.receipt.operationId).toBe(first.receipt.operationId);
  });

  it("refuses a declared lane it cannot bind rather than adopting with the lane quietly off", async () => {
    const workspace = unadoptedWorkspace();
    const host = adoptionHost(temporaryRoot("tachyon-490-host-"));
    // The human edited SOUL.md without re-pinning agent.yml. Adopting here would report success and
    // deliver nothing — the "appearance of a fix" this spec exists to remove.
    fs.writeFileSync(path.join(workspace.profileDir, "SOUL.md"), "# Soul\n\nEdited without re-pinning.\n", { mode: 0o600 });

    await expect(host.service.adopt(adoptInput(workspace.root))).rejects.toThrow();
    expect(host.store.currentVector(AGENT_ID)).toBeUndefined();
  });

  it("refuses an agent with no human lane at all, because there is nothing to place under authority", async () => {
    const workspace = unadoptedWorkspace({ soul: false, instructions: false });
    const host = adoptionHost(temporaryRoot("tachyon-490-host-"));

    await expect(host.service.adopt(adoptInput(workspace.root))).rejects.toThrow("nothing to place under authority");
    expect(host.store.currentVector(AGENT_ID)).toBeUndefined();
  });

  it("rolls a crashed adoption back to unadopted rather than leaving a half-open barrier", async () => {
    const workspace = unadoptedWorkspace();
    const host = adoptionHost(temporaryRoot("tachyon-490-host-"));
    // Exactly the state a process death between barrier and vector leaves behind.
    host.store.beginMutationBarrier({
      operationId: "interrupted-adoption",
      mutation: "bootstrap",
      caller: HUMAN,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      intent: { schemaVersion: 1, kind: "formation-adoption", agentId: AGENT_ID },
    });

    expect(host.service.recover(AGENT_ID, HUMAN)).toBe("rolled-back");
    expect(host.store.currentVector(AGENT_ID)).toBeUndefined();
    expect(host.store.mutationBarrier(AGENT_ID, HUMAN)).toBeUndefined();
    expect(host.store.mutationReceipt("interrupted-adoption", HUMAN)).toMatchObject({ outcome: "rolled-back", mutation: "bootstrap" });
    // Rolled back means genuinely unadopted: the door still works afterwards.
    await expect(host.service.adopt(adoptInput(workspace.root))).resolves.toMatchObject({ vector: { generation: { generation: 1 } } });
  });
});

describe("formation authority bootstrap — the file still cannot activate itself", () => {
  it("delivers nothing for an agent nobody adopted, however its agent.yml declares its lanes", async () => {
    const workspace = unadoptedWorkspace();
    const hostRoot = temporaryRoot("tachyon-490-host-");
    // Suppression confirmed, so nothing but the missing authority can be the reason for the refusal.
    const port = lifecycleHost(hostRoot, workspace.root, true);

    expect(await port.resolveSoul({ agentName: "codex", operationId: "spawn-unadopted" })).toEqual({ state: "absent" });
    // And the spawn path created nothing by looking.
    expect(adoptionHost(hostRoot).store.currentVector(AGENT_ID)).toBeUndefined();
  });

  it("delivers the adopted Soul once — and only once — a human has adopted it", async () => {
    const workspace = unadoptedWorkspace();
    const hostRoot = temporaryRoot("tachyon-490-host-");

    expect(await lifecycleHost(hostRoot, workspace.root, true).resolveSoul({ agentName: "codex", operationId: "before-adoption" }))
      .toEqual({ state: "absent" });

    await adoptionHost(hostRoot).service.adopt(adoptInput(workspace.root));

    const resolved = await lifecycleHost(hostRoot, workspace.root, true).resolveSoul({ agentName: "codex", operationId: "after-adoption" });
    expect(resolved.state).toBe("resolved");
    if (resolved.state !== "resolved") throw new Error("unreachable");
    expect(resolved.soul.sha256).toBe(workspace.soulSha256);
    expect(resolved.soul.body).toContain("Steady, precise, and candid.");
  });

  it("still refuses out loud after adoption while native suppression is unmeasured", async () => {
    const workspace = unadoptedWorkspace();
    const hostRoot = temporaryRoot("tachyon-490-host-");
    await adoptionHost(hostRoot).service.adopt(adoptInput(workspace.root));

    // Production hard-codes `nativeSuppressionConfirmed` false for every adapter today. Adoption must
    // not paper over that: the refusal names the remaining prerequisite instead of delivering.
    const outcome = await lifecycleHost(hostRoot, workspace.root, false).resolveSoul({ agentName: "codex", operationId: "unsuppressed" });
    expect(outcome).toMatchObject({ state: "refused" });
    if (outcome.state !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toContain("not confirmed suppressed");
  });
});

describe("formation authority bootstrap — an unadopted agent is honest, not broken", () => {
  it("reports unadopted-and-adoptable for an agent whose lanes are ready", async () => {
    const workspace = unadoptedWorkspace();
    const host = adoptionHost(temporaryRoot("tachyon-490-host-"));

    expect(await host.service.inspect({ workspaceRoot: workspace.root, agentName: "codex", caller: HUMAN }))
      .toMatchObject({ state: "unadopted", agentId: AGENT_ID, profileSha256: workspace.profileSha256, adoptable: true });
  });

  it("names what blocks adoption instead of presenting an inert field", async () => {
    const workspace = unadoptedWorkspace({ soul: false, instructions: false });
    const host = adoptionHost(temporaryRoot("tachyon-490-host-"));

    const state = await host.service.inspect({ workspaceRoot: workspace.root, agentName: "codex", caller: HUMAN });
    expect(state).toMatchObject({ state: "unadopted", adoptable: false });
    if (state.state !== "unadopted") throw new Error("unreachable");
    expect(state.reason).toContain("nothing to place under authority");
  });

  it("reports adopted once authority exists, and not-a-profile-agent when there is no profile", async () => {
    const workspace = unadoptedWorkspace();
    const host = adoptionHost(temporaryRoot("tachyon-490-host-"));
    await host.service.adopt(adoptInput(workspace.root));

    expect(await host.service.inspect({ workspaceRoot: workspace.root, agentName: "codex", caller: HUMAN }))
      .toMatchObject({ state: "adopted", agentId: AGENT_ID });
    expect(await host.service.inspect({ workspaceRoot: workspace.root, agentName: "nobody", caller: HUMAN }))
      .toEqual({ state: "not-a-profile-agent" });
  });
});

describe("formation authority bootstrap — one door, and the ones that are shut", () => {
  it("refuses a non-human caller at the door and again at the host", async () => {
    const workspace = unadoptedWorkspace();
    const host = adoptionHost(temporaryRoot("tachyon-490-host-"));

    for (const kind of ["agent", "system"] as const) {
      await expect(host.service.adopt(adoptInput(workspace.root, { caller: { principal: "someone", kind } })))
        .rejects.toThrow("formation adoption is a human act");
      // The door's check is the outer one; the host refuses the same call independently.
      expect(() => host.store.beginMutationBarrier({
        operationId: `direct-${kind}`,
        mutation: "bootstrap",
        caller: { principal: "someone", kind },
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        intent: {},
      })).toThrow("not authorized for this caller");
    }
    expect(host.store.currentVector(AGENT_ID)).toBeUndefined();
  });

  it("grants nothing but bootstrap on the adoption host, and nothing at all on the spawn host", async () => {
    const workspace = unadoptedWorkspace();
    const hostRoot = temporaryRoot("tachyon-490-host-");
    const host = adoptionHost(hostRoot);
    await host.service.adopt(adoptInput(workspace.root));
    const generation = formationDigest(host.store.currentVector(AGENT_ID)!.generation);

    for (const mutation of ["profile-edit", "evolution-promotion", "memory-promotion", "retire"] as const) {
      expect(() => host.store.beginMutationBarrier({
        operationId: `adoption-host-${mutation}`,
        mutation,
        caller: HUMAN,
        workspaceId: WORKSPACE_ID,
        agentId: AGENT_ID,
        expectedGenerationSha256: generation,
        intent: {},
      })).toThrow("not authorized for this caller");
    }
    // A human in ANOTHER workspace cannot reach this workspace's authority either.
    expect(() => host.store.beginMutationBarrier({
      operationId: "cross-workspace-bootstrap",
      mutation: "bootstrap",
      caller: HUMAN,
      workspaceId: "workspace-other",
      agentId: AGENT_ID,
      intent: {},
    })).toThrow("not authorized for this caller");

    // The spawn path's port answers exactly one question and offers no publication surface at all.
    expect(Object.keys(lifecycleHost(hostRoot, workspace.root, true))).toEqual(["resolveSoul"]);
  });

  it("closes the dynamic pass-through: a human-lane commit cannot be steered into a bootstrap", async () => {
    const workspace = unadoptedWorkspace();
    // `HumanLaneTransactionService.commit` forwards `barrier.mutation` verbatim to `replaceVector`,
    // so a bootstrap barrier is a live second route to the mutation unless its intent parser rejects
    // one. This is that assertion, made against the store that would let it through.
    const store = new FormationAuthorityStore(path.join(temporaryRoot("tachyon-490-open-"), "formation"), {
      authorizeLaunch: () => true,
      authorizeMutation: () => true,
      authorizeSelectorRevocation: () => true,
      authorizeSelectorRead: () => true,
      resolvePayload: () => {
        throw new Error("unused");
      },
    });
    store.beginMutationBarrier({
      operationId: "smuggled-bootstrap",
      mutation: "bootstrap",
      caller: HUMAN,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      intent: {
        schemaVersion: 1,
        kind: "human-lane-profile-edit",
        workspaceRoot: fs.realpathSync.native(workspace.root),
        agentName: "codex",
        agentId: AGENT_ID,
        expectedGenerationSha256: "e".repeat(64),
        nextVector: {},
        entries: { agentProfile: { priorSha256: null, prior: null, nextSha256: null, next: null } },
      },
    });

    expect(() => new HumanLaneTransactionService(store).commit(AGENT_ID, "smuggled-bootstrap", HUMAN)).toThrow();
    expect(store.currentVector(AGENT_ID)).toBeUndefined();
  });

  it("keeps the bootstrap CAS honest: only a bootstrap may omit a prior generation, and only it must", () => {
    const store = new FormationAuthorityStore(path.join(temporaryRoot("tachyon-490-cas-"), "formation"), {
      authorizeLaunch: () => true,
      authorizeMutation: () => true,
      authorizeSelectorRevocation: () => true,
      authorizeSelectorRead: () => true,
      resolvePayload: () => {
        throw new Error("unused");
      },
    });

    expect(() => store.beginMutationBarrier({
      operationId: "edit-without-prior",
      mutation: "profile-edit",
      caller: HUMAN,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      intent: {},
    })).toThrow("only formation bootstrap may prepare a mutation with no prior generation");

    expect(() => store.beginMutationBarrier({
      operationId: "bootstrap-with-prior",
      mutation: "bootstrap",
      caller: HUMAN,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      expectedGenerationSha256: "f".repeat(64),
      intent: {},
    })).toThrow("formation bootstrap cannot name a prior generation");
  });
});

/**
 * The reachability half.
 *
 * These do not exercise the door; they assert that the routes an AGENT can reach do not arrive at it.
 * Three routes matter, and each one is a door that already exists in this repository:
 *
 * 1. `extension.invoke` over the control socket — whose nonce proves same-uid, not humanity, so every
 *    agent Tachyon spawns can present it.
 * 2. Any `vscode.commands` id — the shell's UI handler executes whatever command the daemon names.
 * 3. `WorkspaceAgentStudioTarget` — the interface `ClientWorkspaceStudioTarget` implements by putting
 *    each member on that same socket. Adding adoption there is the pressure that would create route 1.
 */
describe("formation authority bootstrap — unreachability from every agent-facing surface", () => {
  const sourceFiles = (): Array<{ file: string; text: string }> => {
    const collected: Array<{ file: string; text: string }> = [];
    const walk = (directory: string): void => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const child = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.isFile() && child.endsWith(".ts")) {
          collected.push({ file: path.relative(REPO_ROOT, child).split(path.sep).join("/"), text: fs.readFileSync(child, "utf8") });
        }
      }
    };
    walk(path.join(REPO_ROOT, "src"));
    return collected;
  };

  it("finds exactly one production call site that names mutation \"bootstrap\"", () => {
    const found = bootstrapCallSites(sourceFiles());
    expect(found.literal).toEqual([BOOTSTRAP_DOOR_MODULE]);
  });

  it("keeps every call site that could carry a NON-LITERAL mutation on the enumerated list", () => {
    // A pass-through like `mutation: barrier.mutation` is a door too — it just cannot be seen by
    // reading for the word "bootstrap". Each entry here is closed by a behavioral test above; a new
    // one appearing means a new door nobody enumerated.
    expect(bootstrapCallSites(sourceFiles()).dynamic).toEqual([...DYNAMIC_MUTATION_CALL_SITES]);
  });

  it("FAILS on an injected second door — the guard watched red before it was trusted green", () => {
    const injected = [
      ...sourceFiles(),
      {
        file: "src/agents/formation/sneakySecondDoor.ts",
        // Deliberately shaped like the real thing, and deliberately NOT adjacent to the word in a
        // comment: the 2026-08-03 guard failed precisely because it matched text rather than syntax.
        text: [
          "export function adoptQuietly(store: FormationAuthorityStore, vector: FormationAuthorityVector) {",
          "  return store.replaceVector({ operationId: \"x\", caller: { principal: \"p\", kind: \"human\" },",
          "    mutation: \"bootstrap\", vector });",
          "}",
        ].join("\n"),
      },
    ];
    expect(bootstrapCallSites(injected).literal).toEqual([BOOTSTRAP_DOOR_MODULE, "src/agents/formation/sneakySecondDoor.ts"]);
    // And the assertion the real test makes would fail on it.
    expect(bootstrapCallSites(injected).literal).not.toEqual([BOOTSTRAP_DOOR_MODULE]);
  });

  it("FAILS on an injected dynamic pass-through the enumerated list does not name", () => {
    const injected = [
      ...sourceFiles(),
      {
        file: "src/agents/formation/relayDoor.ts",
        text: [
          "export function relay(store: FormationAuthorityStore, barrier: FormationMutationBarrier, vector: unknown) {",
          "  return store.replaceVector({ operationId: barrier.operationId, caller: barrier.caller,",
          "    mutation: barrier.mutation, vector });",
          "}",
        ].join("\n"),
      },
    ];
    expect(bootstrapCallSites(injected).dynamic).not.toEqual([...DYNAMIC_MUTATION_CALL_SITES]);
    expect(bootstrapCallSites(injected).dynamic).toContain("src/agents/formation/relayDoor.ts");
  });

  it("exposes no control-socket action that reaches adoption", () => {
    // Route 1. `extension.invoke` can only name actions that exist in the protocol union, and the
    // operation service is the only thing that dispatches them.
    const protocol = fs.readFileSync(path.join(REPO_ROOT, "src", "engine-service", "protocol.ts"), "utf8");
    const service = fs.readFileSync(path.join(REPO_ROOT, "src", "engine-service", "extensionOperationService.ts"), "utf8");
    for (const surface of [protocol, service]) {
      expect(surface).not.toMatch(/adoptFormationAuthority|recoverFormationAdoption|formation\.adopt|formation-adopt/);
    }
    expect(service).not.toMatch(/inspectFormationAuthority/);
  });

  it("registers no editor command that reaches adoption", () => {
    // Route 2. The shell runs ANY command id the daemon names, so a registered id is a socket-reachable
    // door even though it looks like a UI affordance.
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      contributes?: { commands?: Array<{ command: string }> };
    };
    for (const contributed of manifest.contributes?.commands ?? []) {
      expect(contributed.command.toLowerCase()).not.toContain("formation");
    }
    for (const { file, text } of sourceFiles()) {
      if (!text.includes("registerCommand")) continue;
      for (const match of text.matchAll(/registerCommand\(\s*["'`]([^"'`]+)["'`]/g)) {
        expect(`${file}:${match[1]}`.toLowerCase()).not.toContain("formation");
      }
    }
  });

  it("keeps adoption off the studio target interface the remote client implements", () => {
    // Route 3. Anything on this interface has to exist on the other side of the control socket.
    const presentation = fs.readFileSync(path.join(REPO_ROOT, "src", "shell", "WorkspacePresentation.ts"), "utf8");
    const client = fs.readFileSync(path.join(REPO_ROOT, "src", "shell", "ClientWorkspaceStudioTarget.ts"), "utf8");
    for (const surface of [presentation, client]) {
      expect(surface).not.toMatch(/adoptFormationAuthority|inspectFormationAuthority|recoverFormationAdoption/);
    }
  });

  it("reads its own scanner as syntax, not as text", () => {
    // The scanner's own premise, asserted: a file that merely MENTIONS the mutation in prose is not a
    // door, and one that names it through a helper alias still is.
    expect(bootstrapCallSites([{
      file: "src/prose.ts",
      text: "// A caller could pass mutation: \"bootstrap\" here, but this file never calls replaceVector.\n",
    }]).literal).toEqual([]);
    expect(ts.version).toBeTruthy();
  });
});
