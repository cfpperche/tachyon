import { describe, expect, it } from "vitest";
import { CompanionTabChannel } from "../../src/companion/CompanionTabChannel.js";
import { envelopeFromTabResult } from "../../src/companion/tabEnvelope.js";
import { COMPANION_PROTOCOL_VERSION } from "../../src/companion/protocol.js";

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
});
