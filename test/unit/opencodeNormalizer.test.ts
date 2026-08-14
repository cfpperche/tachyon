import { describe, it, expect } from "vitest";
import { normalizeOpencode, type OpencodeTurnRecord } from "@tachyon/engine/activity/opencodeNormalizer.js";

const turn = (o: Partial<OpencodeTurnRecord["message"]>, parts: OpencodeTurnRecord["parts"] = []): OpencodeTurnRecord => ({
  message: { sessionID: "s1", role: "assistant", ...o },
  parts,
});

describe("opencode activity normalizer", () => {
  it("emits the assistant turn's provider/model via `model`, not `runtimeVersion` (spec 378)", () => {
    const rec = turn(
      { role: "assistant", model: { providerID: "anthropic", modelID: "claude-sonnet-5" } },
      [{ type: "text", text: "hi" }],
    );
    const events = normalizeOpencode([rec]);
    const e = events.find((ev) => ev.type === "assistant.message.completed");
    expect(e?.model).toBe("anthropic/claude-sonnet-5");
    expect(e?.runtimeVersion).toBeUndefined();
  });

  it("a user turn (no model on the record) carries no model field", () => {
    const rec = turn({ role: "user" }, [{ type: "text", text: "do the thing" }]);
    const events = normalizeOpencode([rec]);
    const e = events.find((ev) => ev.type === "user.message.completed");
    expect(e?.payload).toEqual({ text: "do the thing" });
    expect(e?.model).toBeUndefined();
  });

  it("a turn with no model metadata omits the field entirely (never a stray empty string)", () => {
    const rec = turn({ role: "assistant" }, [{ type: "text", text: "no model recorded" }]);
    const events = normalizeOpencode([rec]);
    const e = events.find((ev) => ev.type === "assistant.message.completed");
    expect(e && "model" in e).toBe(false);
  });
});
