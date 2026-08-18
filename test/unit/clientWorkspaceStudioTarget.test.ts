import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  workspaceCommandSuccessV1,
  workspaceExtensionCommandSuccessV1,
  workspaceExtensionQuerySuccessV1,
} from "@tachyon/engine/engine-service/protocol.js";
import { ClientWorkspaceStudioTarget } from "../../apps/vscode-extension/src/shell/ClientWorkspaceStudioTarget.js";
import { FakeWorkspaceClient } from "../helpers/FakeWorkspaceClient.js";
import { TerminalStudioAdapter } from "../../apps/vscode-extension/src/webview/TerminalStudioAdapter.js";
import { blankTerminalFields } from "@tachyon/webview-ui/webview/terminal-studio-shell/domain.js";
import type { StudioDeps } from "../../apps/vscode-extension/src/webview/studioSubmit.js";
import { projectionIdentity, projectionSnapshot } from "./fixtures/workspaceProjection.js";
import type { AgentProfileStudioSnapshotV1 } from "@tachyon/shared/config/agentProfileStudio.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ClientWorkspaceStudioTarget", () => {
  it("keeps canonical profile pointers visible to the shell without legacy cmd", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-client-profile-pointer-"));
    roots.push(root);
    // t-ae221c — the shell measures the roster off `.tachyon/agents/`, so the DIRECTORY is what puts
    // `codex` in front of Agent Studio. The retired block below is left in deliberately: it must
    // change nothing either way.
    fs.mkdirSync(path.join(root, ".tachyon", "agents", "codex"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".tachyon", "agents", "codex", "agent.yml"),
      "schemaVersion: 1\nagentId: 11111111-1111-4111-8111-111111111111\nruntime:\n  adapter: codex\n  executable: codex\n",
      "utf8",
    );
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
      kind: "agent-instance",
      agentName: "Ada",
      agentId: "123e4567-e89b-42d3-a456-426614174000",
      revision: "a".repeat(64),
      enabled: false,
      readiness: { state: "limited", limitations: ["fork-unavailable"] },
      editable: {
        displayName: "Ada", runtime: { adapter: "codex", executable: "codex" },
        cwd: "", lifecycle: { autostart: false, restart: "never", attention: true },
        worktree: { enabled: false, branch: "", setup: [] }, instructions: "", isolation: "",
      },
      bindings: { grants: { proposeSavedAgent: false }, foreignWorkspaceCommands: false, foreignPersistentInstructions: false, environmentValueNames: [], secretNames: ["TOKEN"], prompt: { instructions: false }, capabilities: { skills: 0, mcp: 0, hooks: 0, pi: 0 }, tooling: { skills: [], mcp: [], hooks: [] }, externalReferences: 0 },
      provenance: { canonical: { scope: "profile", writable: true, sha256: "b".repeat(64) }, authority: { scope: "host", writable: false, revision: "lifecycle-one", grants: 0 }, projection: { scope: "runtime", writable: false, active: false } },
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
    await expect(target.commitAgentProfileStudio({ schemaVersion: 1, kind: "agent-instance", agentName: "Ada", expectedRevision: snapshot.revision, editable: snapshot.editable }))
      .resolves.toMatchObject({ revision: "c".repeat(64) });
    await expect(target.commitAgentProfileStudioLifecycle({ schemaVersion: 1, operation: "set-enabled", agentName: "Ada", expectedRevision: snapshot.revision, enabled: true }))
      .resolves.toMatchObject({ kind: "snapshot", snapshot: { revision: "d".repeat(64), enabled: true } });
    await expect(target.exportAgentProfileStudioBundle("Ada", snapshot.revision)).resolves.toMatchObject({ byteSize: 3, sha256: "e".repeat(64) });
    await expect(target.cloneAgentProfileStudioBundle("Ada", snapshot.revision, "Bea")).resolves.toMatchObject({ operation: "clone", snapshot: { agentName: "Bea", enabled: false } });
    await expect(target.importAgentProfileStudioBundle("Bea", Buffer.from("{}\n"))).resolves.toMatchObject({ operation: "import" });
    expect(fake.stagedPayloads.at(-1)?.discarded).toBe(true);
  });

  /**
   * t-746f0f — the launch-boundary fact crosses the engine↔shell wire or the remote shell reports a
   * live authorization as a plain success, which is the misreading the sentence exists to prevent.
   * Decoded permissively in both directions: an engine that never sends it behaves as it does today.
   */
  it("carries reachesAgentAtNextLaunch across the wire, and treats its absence as 'not said'", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-client-authorize-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "tachyon.yml"), "agents: {}\n", "utf8");
    const identity = projectionIdentity(root);
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      invoke: async (_operationId, command) => {
        if (command.method !== "extension.invoke") throw new Error("unexpected command");
        if (command.input.action === "agent-profile.authorize-skill") {
          return workspaceExtensionCommandSuccessV1(command as never, command.input.skillName === "atlas"
            ? { ok: true, outcome: "authorized", referenceId: "atlas", reachesAgentAtNextLaunch: true }
            : { ok: true, outcome: "authorized", referenceId: command.input.skillName });
        }
        return workspaceExtensionCommandSuccessV1(command as never, {
          ok: true, authorized: ["mapa"], outcomes: ["authorized"], reachesAgentAtNextLaunch: true,
        });
      },
    });
    let authorizeOperation = 0;
    const target = new ClientWorkspaceStudioTarget(fake, { extensionUri: {} as StudioDeps["extensionUri"], operationId: () => `authorize-operation-${++authorizeOperation}` });

    await expect(target.authorizeAgentSkill("Ada", "atlas")).resolves.toEqual({
      ok: true, outcome: "authorized", referenceId: "atlas", reachesAgentAtNextLaunch: true,
    });
    await expect(target.authorizeAgentSkill("Ada", "bussola")).resolves.toEqual({
      ok: true, outcome: "authorized", referenceId: "bussola",
    });
    await expect(target.authorizeAgentPlugin("Ada", "cartografia")).resolves.toMatchObject({
      ok: true, reachesAgentAtNextLaunch: true,
    });
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

    const adapter = new TerminalStudioAdapter(target);
    const loaded = adapter.load("lint");
    expect(loaded).toMatchObject({ status: "ok", entity: { name: "lint", fields: { cmd: "npm run lint" } } });
    expect(await target.studioDeps().detectClis()).toEqual(["codex"]);

    const saved = await adapter.save(undefined, { ...blankTerminalFields(), name: "deploy", cmd: "npm run deploy" });
    expect(saved).toEqual({ status: "ok", entityId: "deploy" });
    expect(operations).toEqual(["studio-operation-1"]);
    expect(fake.invocations[0]?.command).toMatchObject({ method: "studio.submit", input: { state: { name: "deploy" } } });
    expect(target.config?.agents.deploy?.cmd).toBe("npm run deploy");

    const beforeInvalid = fs.readFileSync(configPath, "utf8");
    await expect(adapter.save(undefined, { ...blankTerminalFields(), name: "invalid", cmd: "" }))
      .resolves.toMatchObject({ status: "error", error: { source: "validation" } });
    expect(fs.readFileSync(configPath, "utf8")).toBe(beforeInvalid);
    expect(operations).toEqual(["studio-operation-1", "studio-operation-2"]);

    fs.writeFileSync(configPath, "not: [valid", "utf8");
    expect(target.config?.agents.deploy?.cmd).toBe("npm run deploy");

    fs.rmSync(configPath);
    expect(target.config).toBeUndefined();
  });

  it("carries a partial Studio submit to the domain instead of failing it in transport (t-8247ec)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-client-studio-partial-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "tachyon.yml"), config("lint"), "utf8");
    const identity = projectionIdentity(root);
    let submits = 0;
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      invoke: async (_operationId, command) => {
        if (command.method !== "studio.submit") throw new Error("unexpected command");
        return workspaceCommandSuccessV1(command, []);
      },
    });
    const target = new ClientWorkspaceStudioTarget(fake, {
      extensionUri: {} as StudioDeps["extensionUri"],
      operationId: () => `studio-operation-partial-${++submits}`,
    });

    // Partial terminal/schedule forms — the remaining studio.submit arms. The editor-host probe
    // (`kind: "agent"`) is a different door and is asserted below; this case is t-8247ec only.
    const partial = { name: "dev", cmd: "npm run dev", kind: "terminal" };
    await expect(target.studioSubmit({ state: partial as never })).resolves.toBeUndefined();
    await expect(target.studioSubmit({ state: { name: "release", kind: "schedule", schedTarget: "claude" } as never })).resolves.toBeUndefined();
    expect(fake.invocations[0]?.command).toMatchObject({
      method: "studio.submit",
      input: { state: { name: "dev", kind: "terminal", schedTiming: "every", schedAction: "spawn", catchUp: false } },
    });
  });

  it("refuses the editor-host legacy agent form as domain, not transport (t-f533f6)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "tachyon-client-studio-legacy-agent-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "tachyon.yml"), config("lint"), "utf8");
    const identity = projectionIdentity(root);
    const fake = new FakeWorkspaceClient({
      identity,
      snapshot: projectionSnapshot(identity),
      invoke: async () => {
        throw new Error("retired agent form must not reach transport");
      },
    });
    const target = new ClientWorkspaceStudioTarget(fake, {
      extensionUri: {} as StudioDeps["extensionUri"],
      operationId: () => "studio-operation-legacy-agent",
    });

    // Exactly what `tachyon._upsertAgent` is handed by the editor-host suite. After SDD 496
    // slice 5 the wire refuses `kind: "agent"`; canonicalizing it and invoking is how the
    // real host surfaced `workspace command is invalid` instead of the domain refusal.
    const probe = {
      name: "studio-rev",
      cmd: "claude --permission-mode plan",
      kind: "agent",
      instructions: "you are a code reviewer",
      cwd: "",
      autostart: false,
      restartOnCrash: true,
      attention: true,
    };
    await expect(target.studioSubmit({ state: probe as never }))
      .resolves.toEqual(expect.arrayContaining([expect.stringContaining("inline agent editing is retired")]));
    expect(fake.invocations).toEqual([]);
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
    await expect(target.studioSubmit({ state: { ...blankTerminalFields(), name: "deploy", cmd: "npm run deploy" } }))
      .rejects.toThrow("engine write failed");
  });

});

function config(...terminals: string[]): string {
  const extra = terminals.map((name) => `  ${name}:\n    cmd: npm run ${name}\n`).join("");
  return `agents: {}\nterminals:\n  worker:\n    cmd: sh\n${extra}`;
}
