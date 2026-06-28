import { describe, it, expect } from "vitest";
import {
  INIT, MODEL, CAPTURE, initMessage, modelMessage, captureMessage,
  refreshAction, openAction, killAction, reapDeadAction, reapOrphansAction, captureAction,
} from "../../src/webview/inspector/messages.js";
import type { InspectorModel } from "../../src/inspector/model.js";

// spec 279 — locks the Inspector's BOTH-DIRECTIONS envelope (the contract that used to hide in the inline
// <script>). The host (ServerInspector), the webview (inspector/main.tsx + App), and the harness all build
// messages through these constructors, so a type-string or shape drift breaks the build, not a screenshot.

const model: InspectorModel = { groups: [], totalSessions: 0, liveSessions: 0, deadSessions: 0, orphanSessions: 0 };

describe("inspector host→webview envelope", () => {
  it("init carries the strings, model carries the model, capture carries session+text", () => {
    const strings = { title: "T" } as never;
    expect(initMessage(strings)).toEqual({ type: INIT, strings });
    expect(modelMessage(model)).toEqual({ type: MODEL, model });
    expect(captureMessage("tachyon:build", "out")).toEqual({ type: CAPTURE, session: "tachyon:build", text: "out" });
  });
});

describe("inspector webview→host actions", () => {
  it("each inbound action builds its typed message (with the session where applicable)", () => {
    expect(refreshAction()).toEqual({ type: "refresh" });
    expect(reapDeadAction()).toEqual({ type: "reapDead" });
    expect(reapOrphansAction()).toEqual({ type: "reapOrphans" });
    expect(openAction("s")).toEqual({ type: "open", session: "s" });
    expect(killAction("s")).toEqual({ type: "kill", session: "s" });
    expect(captureAction("s")).toEqual({ type: "capture", session: "s" });
  });
});
