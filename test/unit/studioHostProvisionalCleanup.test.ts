import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { __resetVscodeMock, __setWarningMessageResult } from "../mocks/vscode.js";
import {
  ensureStudioBinding,
  handleStudioMessage,
  handleStudioNavCheckpointAck,
  sendStudioLoad,
  beginStudioNavTransaction,
  reconcileStudioTeardown,
  stopStudioBinding,
  currentStudioBindingFor,
  __resetStudioHostForTests,
  type StudioRoute,
  type StudioHostIO,
} from "../../src/cockpit/studioHost.js";
import { envelope } from "../../src/webview/shared/studio/protocol.js";
import type { StudioHostAdapter, StudioLoadResult, StudioSaveResult } from "../../src/webview/shared/studio/adapter.js";

/**
 * t-610705 (Phase D, D2) — `abandonProvisionalIfNeeded` (studioHost.ts) is the ONE place
 * `adapter.onCancel` is called from every real abandonment path (explicit Cancel, the nav-
 * transaction's Discard choice, and binding teardown). It's gated on `Binding.persisted`, NOT
 * `mode` — Task Studio's staged-create pattern opens a pre-minted, not-yet-saved id directly in
 * "edit" mode, which is exactly the case a naive `mode === "new"` guard would miss (a REDESIGN-
 * verdict adversarial probe caught this before any Task Studio code existed). These tests exercise
 * the mechanism directly against a hand-rolled fake adapter — adapter-agnostic by construction, so
 * they don't need Task Studio itself to exist yet.
 */

beforeEach(() => __resetVscodeMock());
afterEach(() => {
  vi.useRealTimers();
  __resetStudioHostForTests();
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface FakeEntity { name: string }
interface FakeFields { name: string }

function fakeAdapter(overrides: { persisted?: boolean; onCancel?: (entityId: string | undefined) => void; domainMessageNames?: readonly string[] } = {}): StudioHostAdapter<FakeEntity, FakeFields, FakeFields> {
  return {
    entityType: "fake",
    domainMessageNames: overrides.domainMessageNames ?? [],
    concurrency: { kind: "none" },
    allowPatchRestore: true,
    dirty: {
      computeDirty: () => true,
      serializePatch: (fields) => fields,
      canDiscard: () => true,
    },
    titleFor: () => "Fake",
    load: (entityId): StudioLoadResult<FakeEntity> => ({
      status: "ok",
      entity: { name: entityId ?? "" },
      ...(overrides.persisted !== undefined ? { persisted: overrides.persisted } : {}),
    }),
    validate: () => ({ blocking: [], nonBlocking: [] }),
    save: (): StudioSaveResult => ({ status: "ok" }),
    onCancel: overrides.onCancel,
  };
}

function makeIo(): StudioHostIO & { posted: unknown[] } {
  const posted: unknown[] = [];
  return { post: (m) => posted.push(m), isCurrent: () => true, posted };
}

const route: StudioRoute = { kind: "studio-edit", studio: "command", wsHash: "ws-1", entityId: "provisional-1", returnRoute: null };

async function openAndLoad(adapter: StudioHostAdapter<FakeEntity, FakeFields, FakeFields>): Promise<{ io: ReturnType<typeof makeIo>; mountNonce: string }> {
  const io = makeIo();
  ensureStudioBinding(route, () => adapter as unknown as StudioHostAdapter<unknown, unknown, unknown>);
  await sendStudioLoad(io);
  const mountNonce = currentStudioBindingFor(route)!.mountNonce;
  return { io, mountNonce };
}

function scoped(mountNonce: string, msg: { type: string } & Record<string, unknown>) {
  return envelope({ ...msg, routeKey: "studio-edit:command:ws-1:provisional-1", mountNonce });
}

describe("abandonProvisionalIfNeeded (t-610705, D2)", () => {
  it("decodes adapter-declared domain messages instead of a host hardcoded subset", async () => {
    const { io, mountNonce } = await openAndLoad(fakeAdapter({ domainMessageNames: ["canonicalAction"] }));
    const received: string[] = [];
    await expect(handleStudioMessage(io, scoped(mountNonce, { type: "canonicalAction" }), {
      onChanged: () => {},
      notify: () => {},
      onCancelled: () => {},
      handleDomainMessage: (_ctx, message) => received.push(message.type),
    })).resolves.toBe(true);
    expect(received).toEqual(["canonicalAction"]);
  });
  it("cancel calls onCancel for a provisional (not-yet-persisted) binding", async () => {
    const onCancel = vi.fn();
    const adapter = fakeAdapter({ persisted: false, onCancel });
    const { io, mountNonce } = await openAndLoad(adapter);

    // t-c3c819 — onCancelled must receive the PRE-cleanup persisted value (false here), even though
    // abandonProvisionalIfNeeded (called just before it) unconditionally flips b.persisted to true as
    // part of its own idempotency guard — the client's "where does Cancel go" decision (task-detail
    // vs the studio's own section, for a still-unsaved task) depends on the value BEFORE that flip.
    const onCancelled = vi.fn();
    await handleStudioMessage(io, scoped(mountNonce, { type: "cancel" }), { onChanged: () => {}, notify: () => {}, onCancelled });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledWith("provisional-1");
    expect(onCancelled).toHaveBeenCalledWith(false);
  });

  it("cancel does NOT call onCancel for an already-persisted (real, existing) binding", async () => {
    const onCancel = vi.fn();
    const adapter = fakeAdapter({ persisted: true, onCancel });
    const { io, mountNonce } = await openAndLoad(adapter);

    const onCancelled = vi.fn();
    await handleStudioMessage(io, scoped(mountNonce, { type: "cancel" }), { onChanged: () => {}, notify: () => {}, onCancelled });

    expect(onCancel).not.toHaveBeenCalled();
    expect(onCancelled).toHaveBeenCalledWith(true);
  });

  it("a successful save flips persisted, so a LATER cancel/teardown no longer cleans up", async () => {
    const onCancel = vi.fn();
    const adapter = fakeAdapter({ persisted: false, onCancel });
    const { io, mountNonce } = await openAndLoad(adapter);

    await handleStudioMessage(io, scoped(mountNonce, { type: "patch", patch: { name: "x" }, editRevision: 1 }), { onChanged: () => {}, notify: () => {}, onCancelled: () => {} });
    await handleStudioMessage(io, scoped(mountNonce, { type: "save" }), { onChanged: () => {}, notify: () => {}, onCancelled: () => {} });

    reconcileStudioTeardown({ kind: "section", section: "overview" });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("reconcileStudioTeardown cleans up an abandoned provisional binding exactly once", async () => {
    const onCancel = vi.fn();
    const adapter = fakeAdapter({ persisted: false, onCancel });
    await openAndLoad(adapter);

    reconcileStudioTeardown({ kind: "section", section: "overview" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("stopStudioBinding cleans up an abandoned provisional binding", async () => {
    const onCancel = vi.fn();
    const adapter = fakeAdapter({ persisted: false, onCancel });
    await openAndLoad(adapter);

    stopStudioBinding();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("cancel followed by teardown of the SAME binding only fires onCancel once (idempotent)", async () => {
    const onCancel = vi.fn();
    const adapter = fakeAdapter({ persisted: false, onCancel });
    const { io, mountNonce } = await openAndLoad(adapter);

    await handleStudioMessage(io, scoped(mountNonce, { type: "cancel" }), { onChanged: () => {}, notify: () => {}, onCancelled: () => {} });
    reconcileStudioTeardown({ kind: "section", section: "overview" });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("the nav-transaction's Discard choice cleans up a provisional binding", async () => {
    const onCancel = vi.fn();
    const adapter = fakeAdapter({ persisted: false, onCancel });
    const { io, mountNonce } = await openAndLoad(adapter);
    __setWarningMessageResult("Discard");

    await handleStudioMessage(io, scoped(mountNonce, { type: "patch", patch: { name: "x" }, editRevision: 1 }), { onChanged: () => {}, notify: () => {}, onCancelled: () => {} });

    const outcomePromise = beginStudioNavTransaction(io, () => {});
    await flush();
    const checkpoint = io.posted.find((m) => (m as { type?: string }).type === "studioNavCheckpoint") as { txnId: string };
    handleStudioNavCheckpointAck({ txnId: checkpoint.txnId, dirty: true, editRevision: 1, patch: { name: "x" } });
    await outcomePromise;

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("the nav-transaction's Save choice does NOT call onCancel — persisted flips true instead", async () => {
    const onCancel = vi.fn();
    const adapter = fakeAdapter({ persisted: false, onCancel });
    const { io, mountNonce } = await openAndLoad(adapter);
    __setWarningMessageResult("Save");

    await handleStudioMessage(io, scoped(mountNonce, { type: "patch", patch: { name: "x" }, editRevision: 1 }), { onChanged: () => {}, notify: () => {}, onCancelled: () => {} });

    const outcomePromise = beginStudioNavTransaction(io, () => {});
    await flush();
    const checkpoint = io.posted.find((m) => (m as { type?: string }).type === "studioNavCheckpoint") as { txnId: string };
    handleStudioNavCheckpointAck({ txnId: checkpoint.txnId, dirty: true, editRevision: 1, patch: { name: "x" } });
    await outcomePromise;

    expect(onCancel).not.toHaveBeenCalled();
    // and a subsequent teardown confirms persisted really did flip, not just "save happened to not trigger cleanup this once"
    reconcileStudioTeardown({ kind: "section", section: "overview" });
    expect(onCancel).not.toHaveBeenCalled();
  });
});
