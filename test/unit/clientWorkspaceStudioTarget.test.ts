import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  workspaceCommandSuccessV1,
  workspaceExtensionCommandSuccessV1,
  workspaceExtensionQuerySuccessV1,
} from "../../src/engine-service/protocol.js";
import { SoulError } from "../../src/agents/soul.js";
import { EvolutionStoreError } from "../../src/evolution/EvolutionStore.js";
import { ClientWorkspaceStudioTarget } from "../../src/shell/ClientWorkspaceStudioTarget.js";
import { FakeWorkspaceClient } from "../../src/shell/FakeWorkspaceClient.js";
import { CommandStudioAdapter } from "../../src/webview/CommandStudioAdapter.js";
import { blankCommandFields } from "../../src/webview/command-studio-shell/domain.js";
import type { StudioDeps } from "../../src/webview/studioSubmit.js";
import { projectionIdentity, projectionSnapshot } from "./fixtures/workspaceProjection.js";
import type { AgentProfileStudioSnapshotV1 } from "../../src/config/agentProfileStudio.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ClientWorkspaceStudioTarget", () => {
  it("keeps canonical profile pointers visible to the shell without legacy cmd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-client-profile-pointer-"));
    roots.push(root);
    fs.writeFileSync(
      path.join(root, "tachyon.yml"),
      "agents:\n  codex:\n    profile: .tachyon/agents/codex/agent.yml\n",
      "utf8",
    );
    const identity = projectionIdentity(root);
    const fake = new FakeWorkspaceClient({ identity, snapshot: projectionSnapshot(identity) });
    const target = new ClientWorkspaceStudioTarget(fake, {
      extensionUri: {} as StudioDeps["extensionUri"],
    });

    expect(target.config?.agents.codex).toMatchObject({
      cmd: "codex",
      kind: "agent",
      profilePointer: true,
    });
  });

  it("routes canonical Studio inspect/commit through typed extension operations", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-client-profile-studio-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\n", "utf8");
    const identity = projectionIdentity(root);
    const snapshot: AgentProfileStudioSnapshotV1 = {
      schemaVersion: 1,
      kind: "canonical",
      agentName: "Ada",
      agentId: "123e4567-e89b-42d3-a456-426614174000",
      revision: "a".repeat(64),
      enabled: false,
      editable: {
        displayName: "Ada", runtime: { adapter: "codex", executable: "codex" }, role: "reviewer",
        cwd: "", lifecycle: { autostart: false, restart: "never", attention: true, watch: [] },
        worktree: { enabled: false, branch: "" }, isolation: "",
      },
      bindings: { environmentValueNames: [], secretNames: ["TOKEN"], prompt: { soul: false, instructions: false, evolution: false }, capabilities: { skills: 0, mcp: 0, hooks: 0, pi: 0 }, tooling: { skills: [], mcp: [], hooks: [] }, externalReferences: 0 },
      provenance: { canonical: { scope: "profile", writable: true, sha256: "b".repeat(64) }, authority: { scope: "host", writable: false, revision: "lifecycle-one", grants: 0 }, learned: { scope: "profile", writable: false, present: false }, projection: { scope: "runtime", writable: false, active: false } },
    };
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      query: async (query) => {
        if (query.method === "extension.query" && query.input.action === "agent-profile.studio-bundle-export") return workspaceExtensionQuerySuccessV1(query as never, { schemaVersion: 1, agentName: "Ada", revision: snapshot.revision, fileName: "Ada.tachyon-agent-profile.json", contentBase64: Buffer.from("{}\n").toString("base64"), byteSize: 3, sha256: "e".repeat(64), requiresReauthorization: [] });
        expect(query).toMatchObject({ method: "extension.query", input: { action: "agent-profile.studio-inspect", agent: "Ada" } });
        return workspaceExtensionQuerySuccessV1(query as never, snapshot);
      },
      invoke: async (_operationId, command) => {
        if (command.method !== "extension.invoke") throw new Error("unexpected command");
        if (command.input.action === "agent-profile.studio-commit") {
          expect(command).toMatchObject({ input: { mutation: { agentName: "Ada", expectedRevision: snapshot.revision } } });
          return workspaceExtensionCommandSuccessV1(command as never, { ...snapshot, revision: "c".repeat(64) });
        }
        if (command.input.action === "agent-profile.studio-bundle-clone" || command.input.action === "agent-profile.studio-bundle-import") return workspaceExtensionCommandSuccessV1(command as never, { schemaVersion: 1, kind: "created", operation: command.input.action.endsWith("clone") ? "clone" : "import", snapshot: { ...snapshot, agentName: "Bea", enabled: false }, bundleSha256: "e".repeat(64), requiresReauthorization: [] });
        expect(command).toMatchObject({ input: { action: "agent-profile.studio-lifecycle", mutation: { operation: "set-enabled", agentName: "Ada", expectedRevision: snapshot.revision, enabled: true } } });
        return workspaceExtensionCommandSuccessV1(command as never, {
          schemaVersion: 1,
          kind: "snapshot",
          snapshot: { ...snapshot, revision: "d".repeat(64), enabled: true },
        });
      },
    });
    const target = new ClientWorkspaceStudioTarget(fake, { extensionUri: {} as StudioDeps["extensionUri"], operationId: () => "profile-studio-operation" });

    await expect(target.inspectAgentProfileStudio("Ada")).resolves.toEqual(snapshot);
    await expect(target.commitAgentProfileStudio({ schemaVersion: 1, kind: "canonical", agentName: "Ada", expectedRevision: snapshot.revision, editable: snapshot.editable }))
      .resolves.toMatchObject({ revision: "c".repeat(64) });
    await expect(target.commitAgentProfileStudioLifecycle({ schemaVersion: 1, operation: "set-enabled", agentName: "Ada", expectedRevision: snapshot.revision, enabled: true }))
      .resolves.toMatchObject({ kind: "snapshot", snapshot: { revision: "d".repeat(64), enabled: true } });
    await expect(target.exportAgentProfileStudioBundle("Ada", snapshot.revision)).resolves.toMatchObject({ byteSize: 3, sha256: "e".repeat(64) });
    await expect(target.cloneAgentProfileStudioBundle("Ada", snapshot.revision, "Bea")).resolves.toMatchObject({ operation: "clone", snapshot: { agentName: "Bea", enabled: false } });
    await expect(target.importAgentProfileStudioBundle("Bea", Buffer.from("{}\n"))).resolves.toMatchObject({ operation: "import" });
    expect(fake.stagedPayloads.at(-1)?.discarded).toBe(true);
  });

  it("loads forms locally but routes every save through one idempotency-keyed engine command", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-client-studio-"));
    roots.push(root);
    const configPath = path.join(root, "tachyon.yml");
    fs.writeFileSync(configPath, config("lint"), "utf8");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }), "utf8");
    const identity = projectionIdentity(root);
    const operations: string[] = [];
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      invoke: async (operationId, command) => {
        operations.push(operationId);
        if (command.method !== "studio.submit") throw new Error("unexpected agent command");
        if (command.input.state.name === "invalid") {
          return workspaceCommandSuccessV1(command, ["forced validation failure"]);
        }
        expect(command.input.editingName).toBeUndefined();
        fs.writeFileSync(configPath, config("lint", command.input.state.name), "utf8");
        return workspaceCommandSuccessV1(command);
      },
    });
    let nextOperation = 0;
    const target = new ClientWorkspaceStudioTarget(fake, {
      extensionUri: {} as StudioDeps["extensionUri"],
      detectClis: async () => ["codex"],
      operationId: () => `studio-operation-${++nextOperation}`,
    });

    const adapter = new CommandStudioAdapter(target);
    const loaded = adapter.load("lint");
    expect(loaded).toMatchObject({ status: "ok", entity: { name: "lint", fields: { cmd: "npm run lint" } } });
    expect(await target.studioDeps().detectClis()).toEqual(["codex"]);
    expect(target.studioDeps().verifyCandidates()).toEqual(expect.arrayContaining(["npm test", "lint", "ship"]));

    const saved = await adapter.save(undefined, { ...blankCommandFields(), name: "deploy", cmd: "npm run deploy" });
    expect(saved).toEqual({ status: "ok", entityId: "deploy" });
    expect(operations).toEqual(["studio-operation-1"]);
    expect(fake.invocations[0]?.command).toMatchObject({ method: "studio.submit", input: { state: { name: "deploy" } } });
    expect(target.config?.commands.deploy?.cmd).toBe("npm run deploy");

    const beforeInvalid = fs.readFileSync(configPath, "utf8");
    await expect(adapter.save(undefined, { ...blankCommandFields(), name: "invalid", cmd: "" }))
      .resolves.toMatchObject({ status: "error", error: { source: "validation" } });
    expect(fs.readFileSync(configPath, "utf8")).toBe(beforeInvalid);
    expect(operations).toEqual(["studio-operation-1", "studio-operation-2"]);

    fs.writeFileSync(configPath, "not: [valid", "utf8");
    expect(target.config?.commands.deploy?.cmd).toBe("npm run deploy");

    fs.rmSync(configPath);
    expect(target.config).toBeUndefined();
  });

  it("surfaces an engine command failure as transport failure instead of a validation error", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-client-studio-error-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "tachyon.yml"), config("lint"), "utf8");
    const identity = projectionIdentity(root);
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      invoke: async (_operationId, command) => ({
        schemaVersion: 1,
        method: command.method,
        status: "error",
        code: "COMMAND_FAILED",
        message: "engine write failed",
      }),
    });
    const target = new ClientWorkspaceStudioTarget(fake, {
      extensionUri: {} as StudioDeps["extensionUri"],
      operationId: () => "studio-operation-error",
    });
    await expect(target.studioSubmit({ state: { ...blankCommandFields(), name: "deploy", cmd: "npm run deploy" } }))
      .rejects.toThrow("engine write failed");
  });

  it("routes Soul reads and mutations through the engine with private staged bytes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-client-studio-soul-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents:\n  Ada:\n    cmd: codex\n", "utf8");
    const identity = projectionIdentity(root);
    const status = {
      agent: "Ada",
      relativePath: ".tachyon/agents/Ada/SOUL.md",
      lifecycle: "active",
      profileId: "123e4567-e89b-42d3-a456-426614174000",
      sha256: "a".repeat(64),
      chars: 12,
      bytes: 12,
      soulEnabled: true,
      resolvable: true,
      transactionDegraded: false,
      preview: "# Ada",
    } as const;
    let fake!: FakeWorkspaceClient;
    let nextOperation = 0;
    fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      query: async (query) => {
        if (query.method !== "extension.query" || query.input.action !== "soul.profile.status") {
          throw new Error("unexpected query");
        }
        return workspaceExtensionQuerySuccessV1(query, { outcome: "ok", status });
      },
      invoke: async (_operationId, command) => {
        if (command.method !== "extension.invoke" || !command.input.action.startsWith("soul.profile.")) {
          throw new Error("unexpected command");
        }
        const input = command.input;
        if (input.action === "soul.profile.import") {
          const staged = fake.stagedPayloads.find((entry) => entry.ref.token === input.payload.token);
          expect(staged?.data.toString("utf8")).toBe("# Imported Ada\n");
          return workspaceExtensionCommandSuccessV1(command, { outcome: "ok", status, selfSelected: true });
        }
        if (command.input.action === "soul.profile.replace") {
          return workspaceExtensionCommandSuccessV1(command, { outcome: "error", code: "soul/digest-mismatch" });
        }
        return workspaceExtensionCommandSuccessV1(command, { outcome: "ok", status });
      },
    });
    const target = new ClientWorkspaceStudioTarget(fake, {
      extensionUri: {} as StudioDeps["extensionUri"],
      operationId: () => `soul-operation-${++nextOperation}`,
    });

    await expect(target.refreshSoulProfile("Ada")).resolves.toEqual(status);
    await expect(target.canonicalSoulPathForOpen("Ada"))
      .resolves.toBe(path.join(root, ".tachyon", "agents", "Ada", "SOUL.md"));
    await expect(target.importSoulProfileBytes("Ada", Buffer.from("# Imported Ada\n")))
      .resolves.toMatchObject({ status, selfSelected: true });
    expect(fake.stagedPayloads).toHaveLength(1);
    expect(fake.stagedPayloads[0]?.discarded).toBe(true);
    await expect(target.replaceSoulProfileBytes("Ada", Buffer.from("# Replacement\n"), "a".repeat(64)))
      .rejects.toMatchObject({ code: "soul/digest-mismatch" } satisfies Partial<SoulError>);
    expect(fake.stagedPayloads[1]?.discarded).toBe(true);
  });

  it("routes Agent Evolution overview/detail/actions through the persistent engine", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-client-studio-evolution-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents:\n  Ada:\n    cmd: codex\n    selfEvolution: { enabled: true }\n", "utf8");
    const identity = projectionIdentity(root);
    const summary = {
      agent: "Ada",
      enabled: true,
      profilePresent: true,
      activeVersion: 1,
      pendingCount: 1,
      activeLearnings: [],
      activeSkillNames: [],
    };
    const candidate = {
      id: "candidate-one",
      reviewId: "review-one",
      taskId: "t-123456",
      createdAt: "2026-07-21T18:00:00.000Z",
      status: "pending" as const,
      kind: "learning" as const,
      reason: "Reusable correction.",
    };
    let failResolve = false;
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      query: async (query) => {
        if (query.method !== "extension.query") throw new Error("unexpected query");
        if (query.input.action === "evolution.overview") {
          return workspaceExtensionQuerySuccessV1(query, { summary, candidates: [candidate] });
        }
        if (query.input.action === "evolution.candidate") {
          return workspaceExtensionQuerySuccessV1(query, {
            ...candidate,
            expectedActiveVersion: 1,
            learningContent: "Run the focused test first.",
          });
        }
        throw new Error("unexpected evolution query");
      },
      invoke: async (_operationId, command) => {
        if (command.method !== "extension.invoke"
          || (command.input.action !== "evolution.approve" && command.input.action !== "evolution.reject")) {
          throw new Error("unexpected evolution command");
        }
        if (failResolve) {
          return workspaceExtensionCommandSuccessV1(command, {
            outcome: "error",
            code: "evolution/promotion-conflict",
          });
        }
        return workspaceExtensionCommandSuccessV1(command, { outcome: "ok", candidateId: candidate.id, activeVersion: 2 });
      },
    });
    let evolutionOperation = 0;
    const target = new ClientWorkspaceStudioTarget(fake, {
      extensionUri: {} as StudioDeps["extensionUri"],
      operationId: () => `evolution-operation-${++evolutionOperation}`,
    });

    await expect(target.readAgentEvolutionOverview("Ada")).resolves.toEqual({ summary, candidates: [candidate] });
    await expect(target.readAgentEvolutionCandidate("Ada", candidate.id)).resolves.toMatchObject({
      id: candidate.id,
      learningContent: "Run the focused test first.",
    });
    await expect(target.approveAgentEvolutionCandidate("Ada", candidate.id, { expectedActiveVersion: 1 }))
      .resolves.toEqual({ candidateId: candidate.id, activeVersion: 2 });
    failResolve = true;
    await expect(target.rejectAgentEvolutionCandidate("Ada", candidate.id, { expectedActiveVersion: 1 }))
      .rejects.toMatchObject({ code: "evolution/promotion-conflict" } satisfies Partial<EvolutionStoreError>);
  });
});

function config(...commands: string[]): string {
  return `agents:\n  worker:\n    cmd: sh\ncommands:\n${commands.map((name) => `  ${name}:\n    cmd: npm run ${name}\n`).join("")}runbooks:\n  ship:\n    steps:\n      - lint\n`;
}
