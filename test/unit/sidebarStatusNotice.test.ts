/**
 * t-72e93a / SDD 512 fatia 1 — the current action-less notice is projected state.
 *
 * Not the Human Inbox (`notices[]`). Last write wins, no timer, level is a field.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildSidebarFleet, type SidebarFleetSource } from "@tachyon/engine/sidebar/sidebarFleetService.js";
import { StatusNoticeStore, type StatusNotice } from "@tachyon/engine/sidebar/statusNotice.js";
import { parseSidebarViewV1, projectSidebarView } from "@tachyon/engine/runtime-api/sidebarProjection.js";

function source(notice?: () => StatusNotice | undefined): SidebarFleetSource {
  return {
    workspaceRoot: "/workspace",
    wsHash: "ws",
    folderName: "workspace",
    bridge: { port: 4317, url: "http://127.0.0.1:4317" },
    manager: {
      listAgents: async () => [],
      listTerminals: async () => [],
      defOf: () => ({ cmd: "claude", kind: "agent" }),
      resumeReadiness: async () => true,
      session: (name: string) => `tachyon-ws-${name}`,
    },
    ledger: { all: () => new Map(), get: () => undefined },
    tmux: { panePid: async () => { throw new Error("no pane"); } },
    worktrees: { currentBranch: async () => "main" },
    config: undefined,
    configFailure: undefined,
    handoffStore: { snapshot: () => ({ exists: false, staleness: "fresh", pendingCount: 0 }) },
    pinStore: { list: () => [] },
    proposals: { list: () => [] },
    scheduler: { list: () => [] },
    pipelines: { allRuns: () => [] },
    listPipelines: () => [],
    lastActivityAt: () => null,
    attentionOf: () => undefined,
    persistenceHookHealth: () => undefined,
    evidenceHandoff: async () => undefined,
    readConfigLkg: () => null,
    ...(notice ? { statusNotice: notice } : {}),
  } as unknown as SidebarFleetSource;
}

function minimalView(statusNotice?: { message: string; level: string; at: string }) {
  return {
    schemaVersion: 1 as const,
    fleet: {
      folder: { hash: "h1", name: "demo" },
      bridge: { port: "1234", connected: true },
      agents: [],
      terminals: [],
      pipelines: [],
      schedules: [],
      pins: [],
      notices: [],
      proposals: [],
      handoff: { exists: false, staleness: "fresh" as const, pendingCount: 0 },
      ...(statusNotice ? { statusNotice } : {}),
    },
  };
}

describe("t-72e93a — current status notice is projected state", () => {
  it("omits the field when the source has never set a notice", async () => {
    const fleet = await buildSidebarFleet(source());
    expect(fleet.statusNotice).toBeUndefined();
    expect(fleet.notices).toEqual([]);
  });

  it("replaces the previous message — last write wins, no queue", async () => {
    const store = new StatusNoticeStore();
    store.set({ message: "Nothing to review", level: "info" }, () => new Date("2026-08-17T12:00:00.000Z"));
    expect((await buildSidebarFleet(source(() => store.get()))).statusNotice).toEqual({
      message: "Nothing to review",
      level: "info",
      at: "2026-08-17T12:00:00.000Z",
    });

    store.set(
      { message: "run grok login first", level: "warn" },
      () => new Date("2026-08-17T12:01:00.000Z"),
    );
    const fleet = await buildSidebarFleet(source(() => store.get()));
    expect(fleet.statusNotice).toEqual({
      message: "run grok login first",
      level: "warn",
      at: "2026-08-17T12:01:00.000Z",
    });
    expect(fleet.notices).toEqual([]);
  });

  it("keeps the last notice after more than eight seconds — there is no timer", async () => {
    const store = new StatusNoticeStore();
    store.set(
      { message: "run grok login first", level: "error" },
      () => new Date("2026-08-17T12:00:00.000Z"),
    );
    const nineSecondsLater = () => new Date("2026-08-17T12:00:09.000Z");
    const fleet = await buildSidebarFleet(source(() => store.get()), { now: () => nineSecondsLater().getTime() });
    expect(fleet.statusNotice).toEqual({
      message: "run grok login first",
      level: "error",
      at: "2026-08-17T12:00:00.000Z",
    });
    expect(store.get()?.at).toBe("2026-08-17T12:00:00.000Z");
  });

  it("carries level as a field, never inferred from the message text", async () => {
    const store = new StatusNoticeStore();
    store.set(
      { message: "error: something failed", level: "info" },
      () => new Date("2026-08-17T12:00:00.000Z"),
    );
    const cheerfulError = await buildSidebarFleet(source(() => store.get()));
    expect(cheerfulError.statusNotice?.level).toBe("info");
    expect(cheerfulError.statusNotice?.message).toBe("error: something failed");

    store.set(
      { message: "all good", level: "error" },
      () => new Date("2026-08-17T12:00:01.000Z"),
    );
    const quietError = await buildSidebarFleet(source(() => store.get()));
    expect(quietError.statusNotice?.level).toBe("error");
    expect(quietError.statusNotice?.message).toBe("all good");
  });

  it("clears the field when the notice is dismissed", async () => {
    const store = new StatusNoticeStore();
    store.set({ message: "Nothing to review", level: "info" });
    store.dismiss();
    expect((await buildSidebarFleet(source(() => store.get()))).statusNotice).toBeUndefined();
  });

  it("survives projectSidebarView — the versioned contract keeps level as data", async () => {
    const store = new StatusNoticeStore();
    store.set(
      { message: "run grok login first", level: "error" },
      () => new Date("2026-08-17T12:00:00.000Z"),
    );
    const view = await projectSidebarView(source(() => store.get()));
    expect(view.schemaVersion).toBe(1);
    expect(view.fleet.statusNotice).toEqual({
      message: "run grok login first",
      level: "error",
      at: "2026-08-17T12:00:00.000Z",
    });
  });

  it("parseSidebarViewV1 accepts the field and refuses a notice without a level", () => {
    const view = parseSidebarViewV1(minimalView({
      message: "error: looks like an error",
      level: "info",
      at: "2026-08-17T12:00:00.000Z",
    }));
    expect(view.fleet.statusNotice).toEqual({
      message: "error: looks like an error",
      level: "info",
      at: "2026-08-17T12:00:00.000Z",
    });

    const missingLevel = minimalView({
      message: "missing level",
      level: "info",
      at: "2026-08-17T12:00:00.000Z",
    });
    delete (missingLevel.fleet.statusNotice as { level?: string }).level;
    expect(() => parseSidebarViewV1(missingLevel)).toThrow();
    expect(() => parseSidebarViewV1({
      ...minimalView({
        message: "ok",
        level: "info",
        at: "2026-08-17T12:00:00.000Z",
      }),
      fleet: {
        ...minimalView({
          message: "ok",
          level: "info",
          at: "2026-08-17T12:00:00.000Z",
        }).fleet,
        statusNotice: {
          message: "ok",
          level: "info",
          at: "2026-08-17T12:00:00.000Z",
          expiresAt: "2026-08-17T12:00:08.000Z",
        },
      },
    })).toThrow();
  });

  it("the store and projector have no timer primitives", () => {
    const root = path.join(__dirname, "../..");
    for (const relative of [
      "packages/engine/src/sidebar/statusNotice.ts",
      "packages/engine/src/sidebar/sidebarFleetService.ts",
    ]) {
      const body = readFileSync(path.join(root, relative), "utf8");
      expect(body, relative).not.toMatch(/setTimeout|setInterval|expiresAt|\bttl\b|8_000|8000/);
    }
  });
});
