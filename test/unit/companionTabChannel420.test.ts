import { describe, expect, it } from "vitest";
import { CompanionTabChannel } from "@tachyon/engine/companion/CompanionTabChannel.js";
import { envelopeFromTabResult } from "@tachyon/engine/companion/tabEnvelope.js";
import { COMPANION_PROTOCOL_VERSION } from "@tachyon/engine/companion/protocol.js";

describe("SDD 420 CompanionTabChannel", () => {
  it("requires tabId on snapshot", () => {
    const ch = new CompanionTabChannel({ push: () => {} });
    expect(() => ch.requestSnapshot({ tabId: "  " })).toThrow(/tabId is required/);
  });

  it("pushes tabs_list and tab-scoped snapshot commands", async () => {
    const pushed: unknown[] = [];
    const ch = new CompanionTabChannel({
      push: (_ev, data) => {
        pushed.push(data);
      },
    });
    const pList = ch.requestTabsList(50);
    const pSnap = ch.requestSnapshot({ tabId: "ctab_abc" }, 50);
    expect(pushed).toHaveLength(2);
    expect(pushed[0]).toMatchObject({ kind: "tabs_list" });
    expect(pushed[1]).toMatchObject({ kind: "snapshot", tabId: "ctab_abc" });
    // fulfill
    const listCmd = pushed[0] as { id: string };
    ch.submitResult({
      ok: true,
      id: listCmd.id,
      kind: "tabs_list",
      tabs: [{ tabId: "ctab_abc", title: "T", url: "https://x.test/", active: true, documentToken: "d1" }],
    });
    const snapCmd = pushed[1] as { id: string };
    ch.submitResult({
      ok: true,
      id: snapCmd.id,
      kind: "snapshot",
      tabId: "ctab_abc",
      documentToken: "d1",
      url: "https://x.test/",
      title: "T",
      capturedAt: new Date().toISOString(),
      outline: "@e1 button Submit",
      refs: [{ ref: "@e1", selector: "button", tag: "BUTTON" }],
      stats: { nodes: 1, truncated: false, outlineChars: 20 },
    });
    const list = await pList;
    const snap = await pSnap;
    expect(list).toMatchObject({ ok: true, kind: "tabs_list" });
    expect(snap).toMatchObject({ ok: true, kind: "snapshot", tabId: "ctab_abc" });
  });

  it("envelope maps stale_tab to not_applied retrySafe false", () => {
    const env = envelopeFromTabResult({
      tool: "user_browser_click",
      tabId: "ctab_x",
      raw: { ok: false, id: "1", code: "stale_tab", message: "gone" },
    });
    expect(env.status).toBe("not_applied");
    expect(env.retrySafe).toBe(false);
    expect(env.protocolVersion).toBe(COMPANION_PROTOCOL_VERSION);
  });

  it("P1 residual: drag / upload / download / network / frames / dialog", async () => {
    const pushed: unknown[] = [];
    const ch = new CompanionTabChannel({
      push: (_ev, data) => {
        pushed.push(data);
      },
    });
    const target = { tabId: "ctab_r" };
    const pending = [
      ch.requestDrag(target, { sourceRef: "@e1", targetRef: "@e2", timeoutMs: 50 }),
      ch.requestUpload(target, {
        ref: "@e3",
        files: [{ name: "a.txt", mimeType: "text/plain", base64: "YQ==" }],
        timeoutMs: 50,
      }),
      ch.requestDownload(target, { ref: "@e4", timeoutMs: 50 }),
      ch.requestNetwork(target, { limit: 5, timeoutMs: 50 }),
      ch.requestListFrames(target, 50),
      ch.requestDialog(target, { action: "read", timeoutMs: 50 }),
    ];
    expect(pushed.map((p) => (p as { kind: string }).kind)).toEqual([
      "drag",
      "upload",
      "download",
      "network",
      "list_frames",
      "dialog",
    ]);
    for (const cmd of pushed as Array<{ id: string; kind: string }>) {
      if (cmd.kind === "download") {
        ch.submitResult({
          ok: true,
          id: cmd.id,
          kind: "download",
          tabId: "ctab_r",
          filename: "f.bin",
          path: "/tmp/f.bin",
          state: "complete",
        });
      } else if (cmd.kind === "network") {
        ch.submitResult({
          ok: true,
          id: cmd.id,
          kind: "network",
          tabId: "ctab_r",
          entries: [{ url: "https://x.test/a", method: "GET", statusCode: 200, at: new Date().toISOString() }],
        });
      } else if (cmd.kind === "list_frames") {
        ch.submitResult({
          ok: true,
          id: cmd.id,
          kind: "list_frames",
          tabId: "ctab_r",
          frames: [{ frameId: 0, parentFrameId: -1, url: "https://x.test/" }],
        });
      } else {
        ch.submitResult({
          ok: true,
          id: cmd.id,
          kind: cmd.kind as "drag",
          tabId: "ctab_r",
          detail: cmd.kind,
        });
      }
    }
    const results = await Promise.all(pending);
    expect(results.every((r) => r.ok === true)).toBe(true);
  });

  it("P1: get / find / hover / select_option / check round-trip", async () => {
    const pushed: unknown[] = [];
    const ch = new CompanionTabChannel({
      push: (_ev, data) => {
        pushed.push(data);
      },
    });
    const target = { tabId: "ctab_p1" };
    const pending = [
      ch.requestGet(target, { what: "text", ref: "@e1", timeoutMs: 50 }),
      ch.requestFind(target, { text: "Submit", timeoutMs: 50 }),
      ch.requestHover(target, { ref: "@e1", timeoutMs: 50 }),
      ch.requestSelectOption(target, { ref: "@e2", value: "a", timeoutMs: 50 }),
      ch.requestCheck(target, { ref: "@e3", checked: true, timeoutMs: 50 }),
    ];
    expect(pushed.map((p) => (p as { kind: string }).kind)).toEqual([
      "get",
      "find",
      "hover",
      "select_option",
      "check",
    ]);
    for (const cmd of pushed as Array<{ id: string; kind: string }>) {
      if (cmd.kind === "get") {
        ch.submitResult({
          ok: true,
          id: cmd.id,
          kind: "get",
          tabId: "ctab_p1",
          what: "text",
          data: "hello",
        });
      } else if (cmd.kind === "find") {
        ch.submitResult({
          ok: true,
          id: cmd.id,
          kind: "find",
          tabId: "ctab_p1",
          matches: [{ text: "Submit", ref: "@e1", tag: "button" }],
        });
      } else {
        ch.submitResult({
          ok: true,
          id: cmd.id,
          kind: cmd.kind as "hover",
          tabId: "ctab_p1",
          detail: cmd.kind,
        });
      }
    }
    const results = await Promise.all(pending);
    expect(results.every((r) => r.ok === true)).toBe(true);
  });

  it("P0: navigate / scroll / press_key / wait_for / tab lifecycle round-trip", async () => {
    const pushed: unknown[] = [];
    const ch = new CompanionTabChannel({
      push: (_ev, data) => {
        pushed.push(data);
      },
    });
    const target = { tabId: "ctab_p0" };
    const pending = [
      ch.requestNavigate(target, "goto", { url: "https://example.test/", timeoutMs: 50 }),
      ch.requestScroll(target, { direction: "down", pixels: 100, timeoutMs: 50 }),
      ch.requestPressKey(target, { key: "Escape", timeoutMs: 50 }),
      ch.requestWaitFor(target, { what: "load", timeoutMs: 50 }),
      ch.requestTabOpen({ url: "https://example.test/new", timeoutMs: 50 }),
      ch.requestTabActivate(target, 50),
      ch.requestTabClose(target, 50),
    ];
    expect(pushed.map((p) => (p as { kind: string }).kind)).toEqual([
      "navigate",
      "scroll",
      "press_key",
      "wait_for",
      "tab_open",
      "tab_activate",
      "tab_close",
    ]);
    for (const cmd of pushed as Array<{ id: string; kind: string }>) {
      if (cmd.kind === "tab_open") {
        ch.submitResult({
          ok: true,
          id: cmd.id,
          kind: "tab_open",
          tabId: "ctab_new",
          documentToken: "d2",
          url: "https://example.test/new",
          title: "New",
        });
      } else {
        ch.submitResult({
          ok: true,
          id: cmd.id,
          kind: cmd.kind as "navigate",
          tabId: "ctab_p0",
          detail: cmd.kind,
        });
      }
    }
    const results = await Promise.all(pending);
    expect(results.every((r) => r.ok === true)).toBe(true);
  });
});
