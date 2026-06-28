import { describe, it, expect } from "vitest";
import {
  INIT, KIND_INFERRED, CWD, ERRORS, initMessage, kindInferredMessage, cwdMessage, errorsMessage,
  tabAction, inferKindAction, browseAction, submitAction, cancelAction, type InitPayload,
} from "../../src/webview/agent-studio/messages.js";
import type { FormState } from "../../src/webview/formLogic.js";

// spec 279 — locks the Agent Studio's BOTH-DIRECTIONS envelope (the contract that used to hide in the
// ~500-line inline <script>). Host, webview, and harness build messages through these, so a drift breaks
// the build. The form VALIDATION/entry-building stays in formLogic.ts (separately unit-tested).

const form = { name: "x", cmd: "claude", kind: "agent" } as FormState;

describe("agent-studio host→webview envelope", () => {
  it("init carries the full payload; kindInferred/cwd/errors carry their fields", () => {
    const payload = { strings: {} as never, chips: [], flagMap: {}, taken: [], commandNames: [], verifyCandidates: [], defaultCwd: "/" } as InitPayload;
    expect(initMessage(payload)).toEqual({ type: INIT, ...payload });
    expect(kindInferredMessage("terminal")).toEqual({ type: KIND_INFERRED, kind: "terminal" });
    expect(cwdMessage("/p")).toEqual({ type: CWD, value: "/p" });
    expect(errorsMessage(["bad"])).toEqual({ type: ERRORS, errors: ["bad"] });
  });
});

describe("agent-studio webview→host actions", () => {
  it("each inbound action builds its typed message", () => {
    expect(tabAction("runbook")).toEqual({ type: "tab", kind: "runbook" });
    expect(inferKindAction("claude")).toEqual({ type: "inferKind", cmd: "claude" });
    expect(browseAction()).toEqual({ type: "browse" });
    expect(submitAction(form)).toEqual({ type: "submit", state: form });
    expect(cancelAction()).toEqual({ type: "cancel" });
  });
});
