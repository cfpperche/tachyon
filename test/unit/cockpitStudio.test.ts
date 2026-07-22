import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __createdPanels, __resetVscodeMock, __setWarningMessageResult, __getWarningMessageCalls, __setOpenDialogResult } from "../mocks/vscode.js";
import { Uri, window } from "vscode";
import { openCockpit, type CockpitMissionBoard } from "../../src/webview/Cockpit.js";
import type { CockpitStudios } from "../../src/cockpit/studioRegistry.js";
import { makeFakeCockpitDeps } from "../mocks/cockpitDeps.js";
import type { WorkspaceStudioTarget } from "../../src/shell/WorkspacePresentation.js";
import type { TachyonConfig } from "../../src/config/loadConfig.js";
import type { StudioDeps } from "../../src/webview/studioSubmit.js";
import { blankCommandFields } from "../../src/webview/command-studio-shell/domain.js";
import { envelope, STUDIO_PROTOCOL_VERSION } from "../../src/webview/shared/studio/protocol.js";
import { __resetStudioHostForTests } from "../../src/cockpit/studioHost.js";

/**
 * t-610705 (SDD 410 Phase D, D0) — the studio-routes-design.md navigation-transaction FSM, ROUTING
 * coverage for Control → the "command" pilot studio (fleet/... studio-new/studio-edit). Two
 * adversarial duetos (probe-ad112b99, probe-393d5244) hardened this design before implementation —
 * these tests exercise the load-bearing findings directly: mount-handshake nonce rejection
 * (round-2 F3), save-freezes-the-operation (round-1 F2), the 3-option dirty-nav modal + draft cache
 * where Discard actually discards (round-1 F6, round-2 F4), and a checkpoint-ack timeout never
 * authorizing navigation (round-2 F1).
 */

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  for (const p of __createdPanels) if (!p.disposed) p.dispose();
  vi.useRealTimers();
  __resetStudioHostForTests();
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakeConfig(commands: TachyonConfig["commands"] = {}): TachyonConfig {
  return { commands } as unknown as TachyonConfig;
}

function fakeStudioDeps(): StudioDeps {
  return {
    extensionUri: { fsPath: "/ext" } as never,
    detectClis: async () => [],
    takenNames: () => [],
    commandNames: () => [],
    verifyCandidates: () => [],
    defaultCwd: "/repo",
    inferKind: () => "agent",
    onSubmit: () => undefined,
  };
}

function commandStudioTarget(overrides: Partial<WorkspaceStudioTarget> = {}): WorkspaceStudioTarget {
  return {
    workspaceRoot: "/repo",
    wsHash: "ws-1",
    folderName: "repo",
    config: fakeConfig(),
    studioDeps: fakeStudioDeps,
    studioSubmit: () => undefined,
    ...overrides,
  };
}

function depsFor(studios: CockpitStudios, hooks: Partial<CockpitMissionBoard> = {}) {
  const missionBoard: CockpitMissionBoard = { getWorkspaces: () => [], openTaskStudio: () => {}, onTasksChanged: () => {}, ...hooks };
  return makeFakeCockpitDeps(missionBoard, { studios });
}

const studioMessages = () => __createdPanels[0].webview.posted.filter((m) => (m as { studioProtocolVersion?: number }).studioProtocolVersion === STUDIO_PROTOCOL_VERSION);
const loadMessages = () => studioMessages().filter((m) => (m as { type?: string }).type === "load") as Array<{ entity: { name?: string; fields: unknown } }>;
const checkpointMessages = () => __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "studioNavCheckpoint") as Array<{ txnId: string }>;

async function openStudioNew(deps: ReturnType<typeof depsFor>): Promise<{ routeKey: string; mountNonce: string }> {
  await openCockpit(deps, { route: { kind: "studio-new", studio: "command", wsHash: "ws-1" } });
  __createdPanels[0].webview.__receive({ type: "ready" });
  await flush();
  const model = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "model") as { model: { studioMountNonce?: string } } | undefined;
  const mountNonce = model?.model.studioMountNonce;
  expect(mountNonce).toBeTruthy();
  return { routeKey: "studio-new:command:ws-1", mountNonce: mountNonce! };
}

function sendStudioReady(routeKey: string, mountNonce: string): void {
  __createdPanels[0].webview.__receive(envelope({ type: "ready" as const, routeKey, mountNonce }));
}

/** t-610705 (round-5 blocker) — every message a real client posts now carries its routeKey+mountNonce
 *  (command-studio-shell/App.tsx's `post` wrapper); these tests construct messages by hand, so they
 *  must attach the same identity studioHost.ts now requires on every binding-scoped message. */
function scoped(routeKey: string, mountNonce: string, msg: { type: string } & Record<string, unknown>) {
  return envelope({ ...msg, routeKey, mountNonce });
}

describe("Control → studio (D0 pilot: command) routing", () => {
  it("mounting a fresh studio-new route posts a load envelope with a blank entity", async () => {
    const deps = depsFor({ getWorkspaces: () => [commandStudioTarget()], onChanged: () => {} });
    const { routeKey, mountNonce } = await openStudioNew(deps);
    sendStudioReady(routeKey, mountNonce);
    await flush();

    const msg = loadMessages().at(-1);
    expect(msg?.entity.name).toBeUndefined();
  });

  it("a stale ready (wrong mountNonce) from a torn-down mount is rejected — no load posted", async () => {
    const deps = depsFor({ getWorkspaces: () => [commandStudioTarget()], onChanged: () => {} });
    const { routeKey } = await openStudioNew(deps);
    sendStudioReady(routeKey, "not-the-real-nonce");
    await flush();

    expect(loadMessages()).toHaveLength(0);
  });

  it("a stale ready with the right nonce but wrong routeKey is also rejected", async () => {
    const deps = depsFor({ getWorkspaces: () => [commandStudioTarget()], onChanged: () => {} });
    const { mountNonce } = await openStudioNew(deps);
    sendStudioReady("studio-new:command:ws-999", mountNonce);
    await flush();

    expect(loadMessages()).toHaveLength(0);
  });

  it("save freezes the operation: onChanged fires and the entity is persisted via studioSubmit", async () => {
    let submitted: unknown;
    const ws = commandStudioTarget({ studioSubmit: (submit) => { submitted = submit; return undefined; } });
    let changed = 0;
    const deps = depsFor({ getWorkspaces: () => [ws], onChanged: () => { changed++; } });
    const { routeKey, mountNonce } = await openStudioNew(deps);
    sendStudioReady(routeKey, mountNonce);
    await flush();

    const fields = { ...blankCommandFields(), name: "build", cmd: "npm run build" };
    __createdPanels[0].webview.__receive(scoped(routeKey, mountNonce, { type: "patch", patch: fields, editRevision: 1 }));
    __createdPanels[0].webview.__receive(scoped(routeKey, mountNonce, { type: "save" }));
    await flush();

    expect(submitted).toEqual({ state: fields, editingName: undefined });
    expect(changed).toBe(1);
  });

  it("a second save while one is in flight is ignored (mutual exclusion)", async () => {
    let submitCount = 0;
    let resolveSubmit!: () => void;
    const wedged = new Promise<string[] | undefined>((res) => { resolveSubmit = () => res(undefined); });
    const ws = commandStudioTarget({ studioSubmit: () => { submitCount++; return wedged; } });
    const deps = depsFor({ getWorkspaces: () => [ws], onChanged: () => {} });
    const { routeKey, mountNonce } = await openStudioNew(deps);
    sendStudioReady(routeKey, mountNonce);
    await flush();

    const fields = { ...blankCommandFields(), name: "build", cmd: "npm run build" };
    __createdPanels[0].webview.__receive(scoped(routeKey, mountNonce, { type: "patch", patch: fields, editRevision: 1 }));
    __createdPanels[0].webview.__receive(scoped(routeKey, mountNonce, { type: "save" }));
    __createdPanels[0].webview.__receive(scoped(routeKey, mountNonce, { type: "save" }));
    await flush();
    resolveSubmit();
    await flush();

    expect(submitCount).toBe(1);
  });

  it("round-4/5: reopening the SAME studio-EDIT route while already on it is a no-op — no checkpoint, no hang", async () => {
    const ws = commandStudioTarget({ config: fakeConfig({ flaky: { cmd: "npm test" } } as unknown as TachyonConfig["commands"]) });
    const deps = depsFor({ getWorkspaces: () => [ws], onChanged: () => {} });
    await openCockpit(deps, { route: { kind: "studio-edit", studio: "command", wsHash: "ws-1", entityId: "flaky" } });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    const model0 = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "model") as { model: { studioMountNonce?: string } };
    const routeKey = "studio-edit:command:ws-1:flaky";
    const mountNonce = model0.model.studioMountNonce!;
    sendStudioReady(routeKey, mountNonce);
    await flush();

    // dirty the form first — a same-identity re-open must not trigger a discard-choice modal either.
    __createdPanels[0].webview.__receive(scoped(routeKey, mountNonce, { type: "patch", patch: { ...blankCommandFields(), name: "flaky" }, editRevision: 1 }));
    __createdPanels[0].webview.__receive(scoped(routeKey, mountNonce, { type: "dirty", dirty: true }));
    await flush();

    await openCockpit(deps, { route: { kind: "studio-edit", studio: "command", wsHash: "ws-1", entityId: "flaky" } });
    await flush();

    expect(checkpointMessages()).toHaveLength(0);
    expect(__getWarningMessageCalls()).toHaveLength(0);
    const model = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model").at(-1) as { model: { activeRoute?: { kind?: string } } };
    expect(model.model.activeRoute?.kind).toBe("studio-edit");
  });

  it("round-5: reopening 'new command' again while a DIRTY new-entity draft is open is NOT a no-op (studio-new never shortcuts)", async () => {
    __setWarningMessageResult("Discard");
    const deps = depsFor({ getWorkspaces: () => [commandStudioTarget()], onChanged: () => {} });
    const { routeKey, mountNonce } = await openStudioNew(deps);
    sendStudioReady(routeKey, mountNonce);
    await flush();

    __createdPanels[0].webview.__receive(scoped(routeKey, mountNonce, { type: "patch", patch: { ...blankCommandFields(), name: "wip" }, editRevision: 1 }));
    __createdPanels[0].webview.__receive(scoped(routeKey, mountNonce, { type: "dirty", dirty: true }));
    await flush();

    const openPromise = openCockpit(deps, { route: { kind: "studio-new", studio: "command", wsHash: "ws-1" } });
    await flush();
    const checkpoint = checkpointMessages().at(-1);
    expect(checkpoint).toBeTruthy(); // a checkpoint WAS requested — unlike studio-edit's shortcut
    __createdPanels[0].webview.__receive({ type: "studioNavCheckpointAck", txnId: checkpoint!.txnId, dirty: true, editRevision: 1, patch: { ...blankCommandFields(), name: "wip" } });
    await openPromise;
    await flush();

    // unlike studio-edit, a second "new command" invocation goes through the FULL checkpoint dance
    // (studio-new's routeKey can't distinguish "same session" from "a genuinely different creation
    // attempt" — round-5's finding: silently no-opping here would hide a real dirty-form question).
    expect(__getWarningMessageCalls().length).toBeGreaterThan(0);
  });

  it("navigating away from a CLEAN form commits immediately (checkpoint round-trip, no modal)", async () => {
    const deps = depsFor({ getWorkspaces: () => [commandStudioTarget()], onChanged: () => {} });
    const { routeKey, mountNonce } = await openStudioNew(deps);
    sendStudioReady(routeKey, mountNonce);
    await flush();

    __createdPanels[0].webview.__receive({ type: "setSection", section: "fleet" });
    await flush();
    const checkpoint = checkpointMessages().at(-1);
    expect(checkpoint).toBeTruthy();
    __createdPanels[0].webview.__receive({ type: "studioNavCheckpointAck", txnId: checkpoint!.txnId, dirty: false, editRevision: 0, patch: undefined });
    await flush();

    const model = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model").at(-1) as { model: { section: string; activeRoute?: unknown } };
    expect(model.model.section).toBe("fleet");
    expect(model.model.activeRoute).toBeUndefined();
    expect(__getWarningMessageCalls()).toHaveLength(0);
  });

  it("navigating away DIRTY + Discard commits and never populates the draft cache", async () => {
    __setWarningMessageResult("Discard");
    const deps = depsFor({ getWorkspaces: () => [commandStudioTarget()], onChanged: () => {} });
    const { routeKey, mountNonce } = await openStudioNew(deps);
    sendStudioReady(routeKey, mountNonce);
    await flush();

    __createdPanels[0].webview.__receive({ type: "setSection", section: "fleet" });
    await flush();
    const checkpoint = checkpointMessages().at(-1)!;
    const patch = { ...blankCommandFields(), name: "deploy" };
    __createdPanels[0].webview.__receive({ type: "studioNavCheckpointAck", txnId: checkpoint.txnId, dirty: true, editRevision: 3, patch });
    await flush();

    const warn = __getWarningMessageCalls().at(-1);
    expect(warn?.actions).toEqual(["Save", "Leave and keep draft", "Discard"]);
    const model = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model").at(-1) as { model: { section: string } };
    expect(model.model.section).toBe("fleet");

    // re-entering the SAME identity must NOT resurrect the discarded draft.
    await openCockpit(deps, { route: { kind: "studio-new", studio: "command", wsHash: "ws-1" } });
    await flush();
    const model2 = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model").at(-1) as { model: { studioMountNonce?: string } };
    sendStudioReady("studio-new:command:ws-1", model2.model.studioMountNonce!);
    await flush();
    const relogd = loadMessages().at(-1)!;
    expect((relogd as unknown as { restore?: unknown }).restore).toBeUndefined();
    const restoreMsgs = studioMessages().filter((m) => (m as { type?: string }).type === "restore");
    expect(restoreMsgs).toHaveLength(0);
  });

  it("navigating away DIRTY + 'Leave and keep draft' caches the checkpoint patch and re-hydrates it on return", async () => {
    __setWarningMessageResult("Leave and keep draft");
    const deps = depsFor({ getWorkspaces: () => [commandStudioTarget()], onChanged: () => {} });
    const { routeKey, mountNonce } = await openStudioNew(deps);
    sendStudioReady(routeKey, mountNonce);
    await flush();

    __createdPanels[0].webview.__receive({ type: "setSection", section: "fleet" });
    await flush();
    const checkpoint = checkpointMessages().at(-1)!;
    const patch = { ...blankCommandFields(), name: "deploy", cmd: "./deploy.sh" };
    __createdPanels[0].webview.__receive({ type: "studioNavCheckpointAck", txnId: checkpoint.txnId, dirty: true, editRevision: 5, patch });
    await flush();

    await openCockpit(deps, { route: { kind: "studio-new", studio: "command", wsHash: "ws-1" } });
    await flush();
    const model2 = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model").at(-1) as { model: { studioMountNonce?: string } };
    sendStudioReady("studio-new:command:ws-1", model2.model.studioMountNonce!);
    await flush();

    const restoreMsgs = studioMessages().filter((m) => (m as { type?: string }).type === "restore") as Array<{ snapshot: { patch?: unknown } }>;
    expect(restoreMsgs.at(-1)?.snapshot.patch).toEqual(patch);
  });

  it("a save validation failure keeps the binding open and posts a blocking error (no dispose)", async () => {
    const ws = commandStudioTarget({ studioSubmit: () => ["name: invalid"] });
    const deps = depsFor({ getWorkspaces: () => [ws], onChanged: () => {} });
    const { routeKey, mountNonce } = await openStudioNew(deps);
    sendStudioReady(routeKey, mountNonce);
    await flush();

    __createdPanels[0].webview.__receive(scoped(routeKey, mountNonce, { type: "patch", patch: { ...blankCommandFields(), name: "1bad" }, editRevision: 1 }));
    __createdPanels[0].webview.__receive(scoped(routeKey, mountNonce, { type: "save" }));
    await flush();

    expect(__createdPanels[0].disposed).toBe(false);
    const errors = studioMessages().filter((m) => (m as { type?: string }).type === "error") as Array<{ code: string; source: string }>;
    expect(errors.at(-1)).toMatchObject({ code: "validation/command-save-failed", source: "validation" });
  });

  it("round-trips the browse domain action through studioRegistry's per-studio handler", async () => {
    __setOpenDialogResult([Uri.file("/picked/dir")]);
    const deps = depsFor({ getWorkspaces: () => [commandStudioTarget()], onChanged: () => {} });
    const { routeKey, mountNonce } = await openStudioNew(deps);
    sendStudioReady(routeKey, mountNonce);
    await flush();

    __createdPanels[0].webview.__receive(scoped(routeKey, mountNonce, { type: "browse" }));
    await flush();

    const cwdMsgs = studioMessages().filter((m) => (m as { type?: string }).type === "cwd") as Array<{ value: string }>;
    expect(cwdMsgs.at(-1)?.value).toBe("/picked/dir");
  });

  it("Cancel is an unconfirmed direct discard and fires onChanged", async () => {
    let changed = 0;
    const deps = depsFor({ getWorkspaces: () => [commandStudioTarget()], onChanged: () => { changed++; } });
    const { routeKey, mountNonce } = await openStudioNew(deps);
    sendStudioReady(routeKey, mountNonce);
    await flush();

    __createdPanels[0].webview.__receive(scoped(routeKey, mountNonce, { type: "cancel" }));
    await flush();

    expect(changed).toBe(1);
    expect(__getWarningMessageCalls()).toHaveLength(0);
  });

  it("a checkpoint-ack timeout NEVER authorizes navigation (round-2 F1) — the route stays put", async () => {
    const deps = depsFor({ getWorkspaces: () => [commandStudioTarget()], onChanged: () => {} });
    await openCockpit(deps, { route: { kind: "studio-new", studio: "command", wsHash: "ws-1" } });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    const model0 = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "model") as { model: { studioMountNonce?: string } };
    sendStudioReady("studio-new:command:ws-1", model0.model.studioMountNonce!);
    await flush();

    vi.useFakeTimers();
    __createdPanels[0].webview.__receive({ type: "setSection", section: "fleet" });
    await vi.advanceTimersByTimeAsync(0);
    expect(checkpointMessages()).toHaveLength(1);
    // never send an ack — let the checkpoint time out.
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();

    const models = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model") as Array<{ model: { section: string; activeRoute?: { kind?: string } } }>;
    const latest = models.at(-1)!;
    expect(latest.model.activeRoute?.kind).toBe("studio-new");
  });

  it("round-3: a SECOND navigation while the discard-choice modal is still open is rejected as busy", async () => {
    let resolveModal!: (choice: string | undefined) => void;
    const wedgedModal = new Promise<string | undefined>((res) => { resolveModal = res; });
    const spy = vi.spyOn(window, "showWarningMessage").mockReturnValueOnce(wedgedModal as never);
    const deps = depsFor({ getWorkspaces: () => [commandStudioTarget()], onChanged: () => {} });
    const { routeKey, mountNonce } = await openStudioNew(deps);
    sendStudioReady(routeKey, mountNonce);
    await flush();

    // N1: navigate away with a dirty form — the ack arrives (activeAck resolves), but the modal
    // (wedgedModal) stays open. Round-3 blocker #1: the old code cleared its "busy" lock the moment
    // the ack arrived, letting a SECOND navigation slip in here.
    __createdPanels[0].webview.__receive({ type: "setSection", section: "fleet" });
    await flush();
    const checkpoint1 = checkpointMessages().at(-1)!;
    __createdPanels[0].webview.__receive({ type: "studioNavCheckpointAck", txnId: checkpoint1.txnId, dirty: true, editRevision: 1, patch: { ...blankCommandFields(), name: "n1" } });
    await flush(); // ack processed, modal now pending (wedged) — N1's transaction is still "in flight"

    // N2: a second navigation intent while N1's modal is open.
    __createdPanels[0].webview.__receive({ type: "setSection", section: "mission" });
    await flush();
    expect(checkpointMessages()).toHaveLength(1); // no second checkpoint was ever requested — N2 was rejected before touching the client

    const modelsBeforeResolve = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model") as Array<{ model: { activeRoute?: { kind?: string } } }>;
    expect(modelsBeforeResolve.at(-1)?.model.activeRoute?.kind).toBe("studio-new"); // neither N1 nor N2 has committed yet

    resolveModal("Discard");
    await flush();
    const modelsAfter = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model") as Array<{ model: { section: string } }>;
    expect(modelsAfter.at(-1)?.model.section).toBe("fleet"); // N1 (the only one that ever actually ran) committed
    spy.mockRestore();
  });

  it("round-3: a checkpoint-ack timeout posts studioNavAbort so the client actually unfreezes", async () => {
    const deps = depsFor({ getWorkspaces: () => [commandStudioTarget()], onChanged: () => {} });
    const { routeKey, mountNonce } = await openStudioNew(deps);
    sendStudioReady(routeKey, mountNonce);
    await flush();

    vi.useFakeTimers();
    __createdPanels[0].webview.__receive({ type: "setSection", section: "fleet" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();

    const aborts = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "studioNavAbort") as Array<{ txnId: string }>;
    expect(aborts.length).toBeGreaterThan(0);
    expect(aborts.at(-1)?.txnId).toBe(checkpointMessages().at(-1)?.txnId);
  });

  it("round-3: save posts studioSaveBegin before the adapter call and studioSaveEnd after, success or failure", async () => {
    const okWs = commandStudioTarget({ studioSubmit: () => undefined });
    const deps = depsFor({ getWorkspaces: () => [okWs], onChanged: () => {} });
    const { routeKey, mountNonce } = await openStudioNew(deps);
    sendStudioReady(routeKey, mountNonce);
    await flush();

    __createdPanels[0].webview.__receive(scoped(routeKey, mountNonce, { type: "patch", patch: { ...blankCommandFields(), name: "ok" }, editRevision: 1 }));
    __createdPanels[0].webview.__receive(scoped(routeKey, mountNonce, { type: "save" }));
    await flush();

    const types = __createdPanels[0].webview.posted.map((m) => (m as { type?: string }).type);
    const beginIdx = types.indexOf("studioSaveBegin");
    const endIdx = types.lastIndexOf("studioSaveEnd");
    expect(beginIdx).toBeGreaterThanOrEqual(0);
    expect(endIdx).toBeGreaterThan(beginIdx);
  });

  it("round-4: EVERY beginStudioSave exit path posts studioSaveEnd (no permanent client freeze)", async () => {
    // "save" with nothing dirty yet (b.patch undefined on the host — client never sent a patch) is
    // the reachable early-return case; the fix's real point is "no exit path skips studioSaveEnd."
    const deps = depsFor({ getWorkspaces: () => [commandStudioTarget()], onChanged: () => {} });
    const { routeKey, mountNonce } = await openStudioNew(deps);
    sendStudioReady(routeKey, mountNonce);
    await flush();

    __createdPanels[0].webview.__receive(scoped(routeKey, mountNonce, { type: "save" })); // no prior "patch" — b.patch is undefined
    await flush();

    const ends = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "studioSaveEnd");
    expect(ends.length).toBeGreaterThan(0);
  });

  it("round-4: an in-flight regular save blocks a navigation transaction from starting (busy)", async () => {
    let resolveSubmit!: () => void;
    const wedged = new Promise<string[] | undefined>((res) => { resolveSubmit = () => res(undefined); });
    const ws = commandStudioTarget({ studioSubmit: () => wedged });
    const deps = depsFor({ getWorkspaces: () => [ws], onChanged: () => {} });
    const { routeKey, mountNonce } = await openStudioNew(deps);
    sendStudioReady(routeKey, mountNonce);
    await flush();

    __createdPanels[0].webview.__receive(scoped(routeKey, mountNonce, { type: "patch", patch: { ...blankCommandFields(), name: "build" }, editRevision: 1 }));
    __createdPanels[0].webview.__receive(scoped(routeKey, mountNonce, { type: "save" }));
    await flush(); // save is now in flight (wedged)

    __createdPanels[0].webview.__receive({ type: "setSection", section: "fleet" });
    await flush();
    // t-610705 (round-4 NEW blocker) — no checkpoint should have been requested: a nav transaction
    // starting during an in-flight save is exactly the overlap that let studioSaveEnd prematurely
    // unfreeze a client whose freeze was ALSO needed by the (would-be) nav transaction's own modal.
    expect(checkpointMessages()).toHaveLength(0);
    const model = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model").at(-1) as { model: { activeRoute?: { kind?: string } } };
    expect(model.model.activeRoute?.kind).toBe("studio-new"); // still on the studio route — nav was rejected as busy

    resolveSubmit();
    await flush();
    // once the save completes, navigation works normally again.
    __createdPanels[0].webview.__receive({ type: "setSection", section: "fleet" });
    await flush();
    expect(checkpointMessages().length).toBeGreaterThan(0);
  });

  it("round-3: a load failure does NOT lose a previously kept draft (peek, not delete-on-read)", async () => {
    __setWarningMessageResult("Leave and keep draft");
    const commands = { flaky: { cmd: "npm test" } } as unknown as TachyonConfig["commands"];
    const ws = commandStudioTarget({ config: fakeConfig(commands) });
    const deps = depsFor({ getWorkspaces: () => [ws], onChanged: () => {} });
    await openCockpit(deps, { route: { kind: "studio-edit", studio: "command", wsHash: "ws-1", entityId: "flaky" } });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    const model0 = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "model") as { model: { studioMountNonce?: string } };
    sendStudioReady("studio-edit:command:ws-1:flaky", model0.model.studioMountNonce!);
    await flush();

    __createdPanels[0].webview.__receive({ type: "setSection", section: "fleet" });
    await flush();
    const checkpoint = checkpointMessages().at(-1)!;
    const patch = { ...blankCommandFields(), name: "flaky", cmd: "npm test --watch" };
    __createdPanels[0].webview.__receive({ type: "studioNavCheckpointAck", txnId: checkpoint.txnId, dirty: true, editRevision: 2, patch });
    await flush(); // "Leave and keep draft" — cached

    // re-entering with the SAME command now removed from config (adapter.load returns not-found).
    (ws.config as unknown as { commands: Record<string, unknown> }).commands = {};
    await openCockpit(deps, { route: { kind: "studio-edit", studio: "command", wsHash: "ws-1", entityId: "flaky" } });
    await flush();
    const model1 = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model").at(-1) as { model: { studioMountNonce?: string } };
    sendStudioReady("studio-edit:command:ws-1:flaky", model1.model.studioMountNonce!);
    await flush();
    expect(studioMessages().filter((m) => (m as { type?: string }).type === "error").length).toBeGreaterThan(0); // load failed
    expect(studioMessages().filter((m) => (m as { type?: string }).type === "restore")).toHaveLength(0); // not applied — never even attempted

    // restore the command and re-enter again — the draft must STILL be there (round-3: a failed
    // load must not have silently deleted it).
    (ws.config as unknown as { commands: Record<string, unknown> }).commands = commands;
    await openCockpit(deps, { route: { kind: "studio-edit", studio: "command", wsHash: "ws-1", entityId: "flaky" } });
    await flush();
    const model2 = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model").at(-1) as { model: { studioMountNonce?: string } };
    sendStudioReady("studio-edit:command:ws-1:flaky", model2.model.studioMountNonce!);
    await flush();
    const restoreMsgs = studioMessages().filter((m) => (m as { type?: string }).type === "restore") as Array<{ snapshot: { patch?: unknown } }>;
    expect(restoreMsgs.at(-1)?.snapshot.patch).toEqual(patch);
  });

  it("round-3: a draft whose fingerprint no longer matches the loaded entity is discarded, never silently applied", async () => {
    __setWarningMessageResult("Leave and keep draft");
    const commands = { flaky: { cmd: "npm test" } } as unknown as TachyonConfig["commands"];
    const ws = commandStudioTarget({ config: fakeConfig(commands) });
    const deps = depsFor({ getWorkspaces: () => [ws], onChanged: () => {} });
    await openCockpit(deps, { route: { kind: "studio-edit", studio: "command", wsHash: "ws-1", entityId: "flaky" } });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    const model0 = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "model") as { model: { studioMountNonce?: string } };
    sendStudioReady("studio-edit:command:ws-1:flaky", model0.model.studioMountNonce!);
    await flush();

    __createdPanels[0].webview.__receive({ type: "setSection", section: "fleet" });
    await flush();
    const checkpoint = checkpointMessages().at(-1)!;
    const patch = { ...blankCommandFields(), name: "flaky", cmd: "npm test --watch" };
    __createdPanels[0].webview.__receive({ type: "studioNavCheckpointAck", txnId: checkpoint.txnId, dirty: true, editRevision: 2, patch });
    await flush(); // cached against the CURRENT entity content

    // the underlying command changes elsewhere (another window, a direct tachyon.yml edit) before
    // the user returns — the draft's fingerprint no longer matches.
    (ws.config as unknown as { commands: Record<string, unknown> }).commands = { flaky: { cmd: "npm test --changed-elsewhere" } };
    await openCockpit(deps, { route: { kind: "studio-edit", studio: "command", wsHash: "ws-1", entityId: "flaky" } });
    await flush();
    const model1 = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model").at(-1) as { model: { studioMountNonce?: string } };
    sendStudioReady("studio-edit:command:ws-1:flaky", model1.model.studioMountNonce!);
    await flush();

    expect(studioMessages().filter((m) => (m as { type?: string }).type === "restore")).toHaveLength(0);
    const loaded = loadMessages().at(-1);
    expect((loaded as unknown as { entity: { fields: { cmd: string } } }).entity.fields.cmd).toBe("npm test --changed-elsewhere");
  });

  it("round-5: a stale patch/save from a TORN-DOWN mount never mutates the binding that replaced it", async () => {
    __setWarningMessageResult("Discard");
    const buildWs = commandStudioTarget({ config: fakeConfig({ build: { cmd: "npm run build" } } as unknown as TachyonConfig["commands"]) });
    const deps = depsFor({ getWorkspaces: () => [buildWs], onChanged: () => {} });
    await openCockpit(deps, { route: { kind: "studio-edit", studio: "command", wsHash: "ws-1", entityId: "build" } });
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    const model0 = __createdPanels[0].webview.posted.find((m) => (m as { type?: string }).type === "model") as { model: { studioMountNonce?: string } };
    const staleRouteKey = "studio-edit:command:ws-1:build";
    const staleMountNonce = model0.model.studioMountNonce!;
    sendStudioReady(staleRouteKey, staleMountNonce);
    await flush();

    // navigate away (clean form — no modal, but STILL a real checkpoint round-trip) to a DIFFERENT
    // entity. Forgetting this ack (as an earlier draft of this test did) leaves txnLock held
    // forever, which itself reproduces round-4's "busy" rejection for every later navigation — a
    // good reminder that "clean" only skips the MODAL, never the checkpoint itself.
    __createdPanels[0].webview.__receive({ type: "setSection", section: "fleet" });
    await flush();
    const leaveCheckpoint = checkpointMessages().at(-1)!;
    __createdPanels[0].webview.__receive({ type: "studioNavCheckpointAck", txnId: leaveCheckpoint.txnId, dirty: false, editRevision: 0, patch: undefined });
    await flush();
    await openCockpit(deps, { route: { kind: "studio-new", studio: "command", wsHash: "ws-1" } });
    await flush();
    const model1 = __createdPanels[0].webview.posted.filter((m) => (m as { type?: string }).type === "model").at(-1) as { model: { studioMountNonce?: string } };
    const freshRouteKey = "studio-new:command:ws-1";
    const freshMountNonce = model1.model.studioMountNonce!;
    sendStudioReady(freshRouteKey, freshMountNonce);
    await flush();

    let submitted: unknown;
    buildWs.studioSubmit = (submit) => { submitted = submit; return undefined; };

    // a message carrying the OLD (torn-down) mount's identity arrives late.
    __createdPanels[0].webview.__receive(scoped(staleRouteKey, staleMountNonce, { type: "patch", patch: { ...blankCommandFields(), name: "build", cmd: "rm -rf /" }, editRevision: 99 }));
    __createdPanels[0].webview.__receive(scoped(staleRouteKey, staleMountNonce, { type: "save" }));
    await flush();

    expect(submitted).toBeUndefined(); // the stale save never reached the CURRENT (studio-new) binding's adapter

    // the CURRENT binding's own (correctly-scoped) messages still work normally.
    __createdPanels[0].webview.__receive(scoped(freshRouteKey, freshMountNonce, { type: "patch", patch: { ...blankCommandFields(), name: "safe" }, editRevision: 1 }));
    __createdPanels[0].webview.__receive(scoped(freshRouteKey, freshMountNonce, { type: "save" }));
    await flush();
    expect(submitted).toEqual({ state: { ...blankCommandFields(), name: "safe" }, editingName: undefined });
  });

  it("no attached workspace leaves the route open but empty (no throw)", async () => {
    const deps = depsFor({ getWorkspaces: () => [], onChanged: () => {} });
    await expect(openCockpit(deps, { route: { kind: "studio-new", studio: "command", wsHash: "gone" } })).resolves.not.toThrow();
    __createdPanels[0].webview.__receive({ type: "ready" });
    await flush();
    expect(loadMessages()).toHaveLength(0);
  });
});
