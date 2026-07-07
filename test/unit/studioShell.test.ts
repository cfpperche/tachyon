import { describe, it, expect } from "vitest";
import {
  STUDIO_PROTOCOL_VERSION,
  CORE_MESSAGE_TYPES,
  isCoreMessageType,
  assertNoDomainNameCollision,
  decodeStudioMessage,
  envelope,
} from "../../src/webview/shared/studio/protocol.js";
import { hasBlockingErrors, mapUnknownError, NO_VALIDATION_ERRORS, type StudioError } from "../../src/webview/shared/studio/errorTaxonomy.js";
import { canSave, requiresDiscardConfirmation } from "../../src/webview/shared/studio/dirtyGating.js";
import { decideRestore } from "../../src/webview/shared/studio/restoreDecisions.js";

// spec 350 T1 — the shell's pure decision modules: versioned protocol with a disciplined domain slot,
// error taxonomy (unknown = blocking), save gating, and restore decisions. DOM-free by design (dueto F1/F2).

describe("protocol: versioned envelope + fail-closed decoding", () => {
  it("core message names are exactly the nine reserved lifecycle names", () => {
    expect([...CORE_MESSAGE_TYPES].sort()).toEqual(["cancel", "dirty", "error", "load", "patch", "ready", "referenceData", "restore", "save"]);
    expect(isCoreMessageType("save")).toBe(true);
    expect(isCoreMessageType("frobnicate")).toBe(false);
  });

  it("a registered domain name colliding with a core name throws (the lint-style guard)", () => {
    expect(() => assertNoDomainNameCollision(["quickAddDetected", "save"])).toThrow(/collides/);
    expect(() => assertNoDomainNameCollision(["quickAddDetected", "roleChanged"])).not.toThrow();
  });

  it("envelope() stamps the current protocol version", () => {
    expect(envelope({ type: "ready" })).toEqual({ type: "ready", studioProtocolVersion: STUDIO_PROTOCOL_VERSION });
  });

  it("decodes a well-formed core message", () => {
    const raw = envelope({ type: "save" });
    const result = decodeStudioMessage(raw, []);
    expect(result).toEqual({ ok: true, message: raw });
  });

  it("decodes a registered domain message", () => {
    const raw = envelope({ type: "quickAddDetected", cli: "claude" });
    expect(decodeStudioMessage(raw, ["quickAddDetected"])).toMatchObject({ ok: true });
  });

  it("fails closed on an unrecognized protocol version", () => {
    const raw = { type: "save", studioProtocolVersion: 999 };
    expect(decodeStudioMessage(raw, [])).toEqual({ ok: false, reason: "unknown-protocol-version" });
  });

  it("fails closed on an unregistered message type", () => {
    const raw = envelope({ type: "notARealMessage" });
    expect(decodeStudioMessage(raw, ["quickAddDetected"])).toEqual({ ok: false, reason: "unknown-message-type" });
  });

  it("fails closed on malformed input", () => {
    expect(decodeStudioMessage(null, []).ok).toBe(false);
    expect(decodeStudioMessage("save", []).ok).toBe(false);
    expect(decodeStudioMessage({ studioProtocolVersion: STUDIO_PROTOCOL_VERSION }, []).ok).toBe(false);
  });
});

describe("error taxonomy: unknown sources default to blocking", () => {
  it("no errors means nothing blocks", () => {
    expect(hasBlockingErrors(NO_VALIDATION_ERRORS)).toBe(false);
  });

  it("a persistence failure maps to a blocking error with no adapter opt-out", () => {
    const err = mapUnknownError("persistence", new Error("disk full"));
    expect(err).toMatchObject({ source: "persistence", blocking: true, message: "disk full" });
  });

  it("a transport failure maps to a blocking error even for a non-Error throw", () => {
    const err = mapUnknownError("transport", "socket reset");
    expect(err).toMatchObject({ source: "transport", blocking: true, message: "socket reset" });
  });

  it("hasBlockingErrors reads only the blocking bucket — nonBlocking never gates save", () => {
    const nonBlockingOnly: StudioError[] = [{ code: "v/soft", message: "heads up", source: "validation", blocking: false }];
    expect(hasBlockingErrors({ blocking: [], nonBlocking: nonBlockingOnly })).toBe(false);
    expect(hasBlockingErrors({ blocking: [{ code: "v/hard", message: "nope", source: "validation", blocking: true }], nonBlocking: [] })).toBe(true);
  });
});

describe("save gating: an adapter can never leave save enabled through an error", () => {
  it("enables save only when dirty, unblocked, idle, and fresh", () => {
    expect(canSave({ dirty: true, blockingErrorCount: 0, saveInFlight: false, concurrencyStale: false })).toBe(true);
  });

  it("blocks save when clean (nothing to save)", () => {
    expect(canSave({ dirty: false, blockingErrorCount: 0, saveInFlight: false, concurrencyStale: false })).toBe(false);
  });

  it("blocks save when any blocking error is showing", () => {
    expect(canSave({ dirty: true, blockingErrorCount: 1, saveInFlight: false, concurrencyStale: false })).toBe(false);
  });

  it("blocks save while a save is already in flight", () => {
    expect(canSave({ dirty: true, blockingErrorCount: 0, saveInFlight: true, concurrencyStale: false })).toBe(false);
  });

  it("blocks save when concurrency is stale (fail-closed CAS)", () => {
    expect(canSave({ dirty: true, blockingErrorCount: 0, saveInFlight: false, concurrencyStale: true })).toBe(false);
  });
});

describe("discard confirmation", () => {
  it("requires confirmation when dirty and the adapter says fields aren't discardable", () => {
    expect(requiresDiscardConfirmation({ dirty: true, canDiscard: false })).toBe(true);
  });

  it("skips confirmation when clean", () => {
    expect(requiresDiscardConfirmation({ dirty: false, canDiscard: false })).toBe(false);
  });

  it("skips confirmation when the adapter says the fields already match the loaded snapshot", () => {
    expect(requiresDiscardConfirmation({ dirty: true, canDiscard: true })).toBe(false);
  });
});

describe("restore decisions: restore LESS when in doubt", () => {
  it("discards when there is no snapshot", () => {
    expect(decideRestore({ allowPatchRestore: true, snapshot: null, currentLoadFailed: false })).toBe("discard");
    expect(decideRestore({ allowPatchRestore: true, snapshot: undefined, currentLoadFailed: false })).toBe("discard");
  });

  it("discards when the current load failed, even with a patch snapshot in hand", () => {
    const snapshot = { schemaVersion: 1 as const, entityType: "pipeline", mode: "edit" as const, entityId: "p1", patch: { title: "draft" } };
    expect(decideRestore({ allowPatchRestore: true, snapshot, currentLoadFailed: true })).toBe("discard");
  });

  it("restores the patch when the adapter permits it, a patch is present, and load succeeded", () => {
    const snapshot = { schemaVersion: 1 as const, entityType: "pipeline", mode: "edit" as const, entityId: "p1", patch: { title: "draft" } };
    expect(decideRestore({ allowPatchRestore: true, snapshot, currentLoadFailed: false })).toBe("restore-patch");
  });

  it("restores clean (no patch) when the adapter forbids patch restore", () => {
    const snapshot = { schemaVersion: 1 as const, entityType: "pipeline", mode: "edit" as const, entityId: "p1", patch: { title: "draft" } };
    expect(decideRestore({ allowPatchRestore: false, snapshot, currentLoadFailed: false })).toBe("restore-clean");
  });

  it("restores clean for a new-entity snapshot with no patch captured yet", () => {
    const snapshot = { schemaVersion: 1 as const, entityType: "pipeline", mode: "new" as const };
    expect(decideRestore({ allowPatchRestore: true, snapshot, currentLoadFailed: false })).toBe("restore-clean");
  });
});
