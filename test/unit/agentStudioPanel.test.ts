import { describe, it, expect, beforeEach } from "vitest";
import { Uri } from "vscode";
import { __createdPanels, __resetVscodeMock, __setOpenDialogResult } from "../mocks/vscode.js";
import { AgentStudioPanelManager } from "../../src/webview/AgentStudioPanel.js";
import { envelope } from "../../src/webview/shared/studio/protocol.js";
import { blankAgentFields } from "../../src/webview/agent-studio-shell/domain.js";
import type { Workspace } from "../../src/workspace/Workspace.js";
import type { StudioSubmit } from "../../src/webview/studioSubmit.js";
import type { AgentDef } from "../../src/config/loadConfig.js";
import { SoulError } from "../../src/agents/soul.js";

/**
 * spec 350 Phase 3 T2 — AgentStudioPanelManager's full shell lifecycle against a REAL AgentStudioAdapter (not
 * a synthetic fake): load new/edit, patch, dirty, validation-blocked save, save success/failure, cancel,
 * reveal-on-reopen, refreshAll, panel restore, the one registered domain action (browse), and closed-on-
 * malformed-message — the same coverage shape as pipelineStudioPanel.test.ts (Fake 1's full-lifecycle proof).
 */

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => __resetVscodeMock());

function findType(posted: unknown[], type: string) {
  return posted.filter((m) => (m as { type?: string }).type === type);
}

function agentDef(overrides: Partial<AgentDef> = {}): AgentDef {
  return {
    cmd: "claude",
    kind: "agent",
    watch: [],
    autostart: false,
    restart: "never",
    attention: { enabled: true },
    ...overrides,
  } as AgentDef;
}

function fakeWorkspace(opts: { agents?: Record<string, AgentDef>; submitResult?: string[] | undefined } = {}) {
  const agents = opts.agents ?? {};
  const submits: StudioSubmit[] = [];
  const ws = {
    wsHash: "ws1",
    workspaceRoot: "/ws/root",
    config: { agents },
    studioDeps: () => ({
      detectClis: async () => [],
      takenNames: () => Object.keys(agents),
      commandNames: () => [],
      verifyCandidates: () => [],
      defaultCwd: "/ws/root",
      inferKind: () => "agent",
      onSubmit: () => undefined,
    }),
    studioSubmit: (submit: StudioSubmit) => {
      submits.push(submit);
      return opts.submitResult;
    },
  } as unknown as Workspace;
  return { ws, submits };
}

const patchMsg = (patch: unknown) => envelope({ type: "patch" as const, patch });
const dirtyMsg = (dirty: boolean) => envelope({ type: "dirty" as const, dirty });
const saveMsg = () => envelope({ type: "save" as const });
const cancelMsg = () => envelope({ type: "cancel" as const });
const browseMsg = () => envelope({ type: "browse" as const });

describe("AgentStudioPanelManager — Phase 3 pilot full lifecycle", () => {
  it("loads a blank new-mode entity and reveals instead of duplicating on reopen", async () => {
    const { ws } = fakeWorkspace();
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    manager.openNew(ws);
    await flush();
    expect(__createdPanels).toHaveLength(1);
    expect(__createdPanels[0].revealCount).toBe(1);
    const load = findType(__createdPanels[0].webview.posted, "load").at(-1);
    expect(load).toMatchObject({ entity: { fields: blankAgentFields() }, concurrency: { kind: "none" } });
  });

  it("uses the agent icon for the editor tab", async () => {
    const { ws } = fakeWorkspace();
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    expect(__createdPanels[0].iconPath).toEqual({
      light: Uri.file("/ext/media/icons/light/hubot.svg"),
      dark: Uri.file("/ext/media/icons/dark/hubot.svg"),
    });
  });

  it("loads the UI Kit token bridge and Tailwind utilities before Agent Studio styles", async () => {
    const { ws } = fakeWorkspace();
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    const html = __createdPanels[0].webview.html;
    const styles = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((match) => match[1]);
    expect(styles.map((style) => style.split("/").pop())).toEqual([
      "codicon.css",
      "design-system.css",
      "vscode-theme.css",
      "agent-studio-shell.tailwind.css",
      "studio-frame.css",
      "agent-studio-shell.css",
    ]);
  });

  it("edit mode loads the persisted agent-kind entry via formLogic's fromDef", async () => {
    const { ws } = fakeWorkspace({ agents: { frontend: agentDef({ cmd: "claude --model sonnet", autostart: true }) } });
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openExisting(ws, "frontend");
    await flush();
    const load = findType(__createdPanels[0].webview.posted, "load").at(-1);
    expect(load).toMatchObject({ entity: { name: "frontend", fields: { cmd: "claude --model sonnet", autostart: true } } });
  });

  it("blocks save (via the studioSubmit error path) until the form is valid, without disposing the panel", async () => {
    const { ws, submits } = fakeWorkspace({ submitResult: ["command: required"] });
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    const webview = __createdPanels[0].webview;
    webview.__receive(patchMsg({ ...blankAgentFields(), name: "frontend", cmd: "" }));
    webview.__receive(dirtyMsg(true));
    webview.__receive(saveMsg());
    await flush();

    expect(__createdPanels[0].disposed).toBe(false);
    expect(submits).toHaveLength(1);
    const err = findType(webview.posted, "error").at(-1);
    expect(err).toMatchObject({ code: "validation/agent-save-failed", source: "validation", blocking: true });
  });

  it("saves successfully once valid, then disposes the panel and fans out onChanged", async () => {
    let changed = 0;
    const { ws } = fakeWorkspace({ submitResult: undefined });
    const manager = new AgentStudioPanelManager(Uri.file("/ext"), () => { changed += 1; });
    manager.openNew(ws);
    await flush();
    const webview = __createdPanels[0].webview;
    const patch = { ...blankAgentFields(), name: "frontend", cmd: "claude" };
    webview.__receive(patchMsg(patch));
    webview.__receive(dirtyMsg(true));
    webview.__receive(saveMsg());
    await flush();

    expect(__createdPanels[0].disposed).toBe(true);
    expect(changed).toBe(1);
  });

  it("a second save on an existing panel passes the entity id through as editingName", async () => {
    const { ws, submits } = fakeWorkspace({ agents: { frontend: agentDef() }, submitResult: undefined });
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openExisting(ws, "frontend");
    await flush();
    const webview = __createdPanels[0].webview;
    webview.__receive(patchMsg({ ...blankAgentFields(), name: "frontend", cmd: "claude --model opus" }));
    webview.__receive(dirtyMsg(true));
    webview.__receive(saveMsg());
    await flush();
    expect(submits[0]?.editingName).toBe("frontend");
    expect(__createdPanels[0].disposed).toBe(true);
  });

  it("cancel disposes without persisting", async () => {
    const { ws, submits } = fakeWorkspace();
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    __createdPanels[0].webview.__receive(patchMsg({ ...blankAgentFields(), name: "abandoned" }));
    __createdPanels[0].webview.__receive(cancelMsg());
    await flush();
    expect(__createdPanels[0].disposed).toBe(true);
    expect(submits).toHaveLength(0);
  });

  it("refreshAll re-posts every open panel with the latest store state", async () => {
    const { ws } = fakeWorkspace({ agents: { frontend: agentDef() } });
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openExisting(ws, "frontend");
    await flush();
    manager.refreshAll();
    await flush();
    const loads = findType(__createdPanels[0].webview.posted, "load");
    expect(loads.length).toBeGreaterThanOrEqual(2);
  });

  it("the registered domain action (browse) round-trips a native folder pick to a 'cwd' reply", async () => {
    __setOpenDialogResult([Uri.file("/picked/dir")]);
    const { ws } = fakeWorkspace();
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    const webview = __createdPanels[0].webview;
    webview.__receive(browseMsg());
    await flush();
    const reply = findType(webview.posted, "cwd").at(-1);
    expect(reply).toMatchObject({ value: "/picked/dir" });
  });

  it("panel restore across a simulated reload: a dirty draft survives", async () => {
    const { ws } = fakeWorkspace();
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    __createdPanels[0].webview.__receive(patchMsg({ ...blankAgentFields(), name: "draft" }));
    __createdPanels[0].webview.__receive(dirtyMsg(true));
    const snapshot = manager.captureSnapshot(ws)!;
    expect(snapshot).toMatchObject({ mode: "new", patch: { name: "draft" } });

    __resetVscodeMock();
    const restored = new AgentStudioPanelManager(Uri.file("/ext"));
    restored.restoreFromSnapshot(ws, snapshot);
    await flush();
    const restoreMsg = findType(__createdPanels[0].webview.posted, "restore").at(-1);
    expect(restoreMsg).toMatchObject({ snapshot: { patch: { name: "draft" } } });
  });

  it("fails closed on a malformed/unversioned message instead of silently dropping it", async () => {
    const { ws } = fakeWorkspace();
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    __createdPanels[0].webview.__receive(envelope({ type: "totallyUnknownType" }));
    await flush();
    const err = findType(__createdPanels[0].webview.posted, "error").at(-1);
    expect(err).toMatchObject({ blocking: true });
  });

  it("binds profile actions to the saved panel entity and rejects cross-agent or extra-field tampering", async () => {
    const { ws } = fakeWorkspace({ agents: { Ada: agentDef() } });
    let creates = 0;
    Object.assign(ws, {
      createSoulProfile: async () => {
        creates += 1;
        return {
          status: {
            agent: "Ada",
            canonicalPath: "/private/workspace/.tachyon/agents/Ada/SOUL.md",
            relativePath: ".tachyon/agents/Ada/SOUL.md",
            lifecycle: "active",
            profileId: "123e4567-e89b-42d3-a456-426614174000",
            sha256: "a".repeat(64),
            soulEnabled: true,
            resolvable: true,
            transactionDegraded: false,
          },
        };
      },
    });
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openExisting(ws, "Ada");
    await flush();
    const webview = __createdPanels[0].webview;

    webview.__receive(envelope({ type: "createSoul" as const, agent: "Bea" }));
    webview.__receive(envelope({ type: "createSoul" as const, agent: "Ada", canonicalPath: "/tmp/tampered" }));
    await flush();
    expect(creates).toBe(0);
    expect(findType(webview.posted, "soulProfileError").at(-1)).toMatchObject({ agent: "Ada", code: "soul/path-invalid" });

    webview.__receive(envelope({ type: "createSoul" as const, agent: "Ada" }));
    await flush();
    expect(creates).toBe(1);
    const status = findType(webview.posted, "soulProfileStatus").at(-1);
    expect(status).toMatchObject({ status: { agent: "Ada", relativePath: ".tachyon/agents/Ada/SOUL.md" } });
    expect(JSON.stringify(status)).not.toContain("/private/workspace");
    expect(JSON.stringify(status)).not.toContain("canonicalPath");
  });

  it("rejects profile actions from an unsaved new-agent panel", async () => {
    const { ws } = fakeWorkspace();
    let creates = 0;
    Object.assign(ws, { createSoulProfile: async () => { creates += 1; throw new Error("must not run"); } });
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openNew(ws);
    await flush();
    const webview = __createdPanels[0].webview;
    webview.__receive(envelope({ type: "createSoul" as const, agent: "Ada" }));
    await flush();
    expect(creates).toBe(0);
    expect(findType(webview.posted, "soulProfileError").at(-1)).toMatchObject({ code: "soul/path-invalid" });
  });

  it("imports webview-selected bytes without invoking a VS Code file path or reflecting payload data", async () => {
    const body = "# Private identity\n";
    const contentBase64 = Buffer.from(body).toString("base64");
    let received: Buffer | undefined;
    const { ws } = fakeWorkspace({ agents: { Ada: agentDef() } });
    Object.assign(ws, {
      importSoulProfileBytes: async (_agent: string, bytes: Buffer) => {
        received = Buffer.from(bytes);
        throw new SoulError("soul/io-error", "Unable to import identity profile");
      },
    });
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openExisting(ws, "Ada");
    await flush();
    const webview = __createdPanels[0].webview;
    webview.__receive(envelope({ type: "importSoul" as const, agent: "Ada", contentBase64 }));
    await flush();
    const error = findType(webview.posted, "soulProfileError").at(-1);
    expect(received?.toString("utf8")).toBe(body);
    expect(error).toMatchObject({ agent: "Ada", code: "soul/io-error" });
    expect(JSON.stringify(error)).not.toContain(contentBase64);
  });

  it("routes only an explicit digest-backed replacement message", async () => {
    const body = "# Replacement identity\n";
    const contentBase64 = Buffer.from(body).toString("base64");
    const expectedDigest = "a".repeat(64);
    let received: { bytes: Buffer; expectedDigest: string } | undefined;
    const { ws } = fakeWorkspace({ agents: { Ada: agentDef() } });
    Object.assign(ws, {
      replaceSoulProfileBytes: async (_agent: string, bytes: Buffer, digest: string) => {
        received = { bytes: Buffer.from(bytes), expectedDigest: digest };
        return {
          status: {
            agent: "Ada",
            canonicalPath: "/private/workspace/.tachyon/agents/Ada/SOUL.md",
            relativePath: ".tachyon/agents/Ada/SOUL.md",
            lifecycle: "active",
            sha256: "b".repeat(64),
            soulEnabled: true,
            resolvable: true,
            transactionDegraded: false,
          },
        };
      },
    });
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openExisting(ws, "Ada");
    await flush();
    const webview = __createdPanels[0].webview;

    webview.__receive(envelope({ type: "replaceSoul" as const, agent: "Ada", contentBase64, expectedDigest: "stale" }));
    await flush();
    expect(received).toBeUndefined();

    webview.__receive(envelope({ type: "replaceSoul" as const, agent: "Ada", contentBase64, expectedDigest }));
    await flush();
    expect(received?.bytes.toString("utf8")).toBe(body);
    expect(received?.expectedDigest).toBe(expectedDigest);
    expect(findType(webview.posted, "soulProfileStatus").at(-1)).toMatchObject({ status: { action: "replace" } });
  });

  it("routes permanent identity deletion through the saved agent and returns a missing profile status", async () => {
    let deleted = 0;
    const { ws } = fakeWorkspace({ agents: { Ada: agentDef() } });
    Object.assign(ws, {
      deleteSoulProfile: async (agent: string) => {
        deleted += 1;
        expect(agent).toBe("Ada");
        return {
          status: {
            agent: "Ada",
            canonicalPath: "/private/workspace/.tachyon/agents/Ada/SOUL.md",
            relativePath: ".tachyon/agents/Ada/SOUL.md",
            lifecycle: "missing",
            soulEnabled: false,
            resolvable: false,
            transactionDegraded: false,
          },
        };
      },
    });
    const manager = new AgentStudioPanelManager(Uri.file("/ext"));
    manager.openExisting(ws, "Ada");
    await flush();
    const webview = __createdPanels[0].webview;
    webview.__receive(envelope({ type: "deleteSoulProfile" as const, agent: "Ada" }));
    await flush();
    expect(deleted).toBe(1);
    const status = findType(webview.posted, "soulProfileStatus").at(-1);
    expect(status).toMatchObject({ status: { lifecycle: "missing", soulEnabled: false, action: "delete" } });
    expect(JSON.stringify(status)).not.toContain("/private/workspace");
  });
});
