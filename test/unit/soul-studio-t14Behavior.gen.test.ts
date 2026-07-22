import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/loadConfig.js";
import { blankAgentFields, computeAgentDirty, createAgentEvolutionLabels, serializeAgentPatch } from "../../src/webview/agent-studio-shell/domain.js";
import { fromDef, toEntry, validateForm, type FormState } from "../../src/webview/formLogic.js";

describe("spec 377 T14 soul enablement in Agent Studio", () => {
  it("defaults off and round-trips only soul: true through the authoritative form/save shape", () => {
    const blank = blankAgentFields();
    expect(blank.soul).toBe(false);
    expect(toEntry(blank).soul).toBeUndefined();
    expect(toEntry({ ...blank, name: "reviewer", cmd: "codex", soul: true })).toMatchObject({ cmd: "codex", soul: true });

    const parsed = parseConfig("agents:\n  enabled:\n    cmd: codex\n    soul: true\n  disabled:\n    cmd: codex\n    soul: false\n");
    const enabled = fromDef("enabled", parsed.config!.agents.enabled);
    const disabled = fromDef("disabled", parsed.config!.agents.disabled);
    expect(enabled.soul).toBe(true);
    expect(disabled.soul).toBe(false);
    expect(toEntry(enabled).soul).toBe(true);
    expect(toEntry(disabled).soul).toBeUndefined();

    expect(computeAgentDirty({ fields: enabled, chips: [], flagMap: {}, defaultCwd: "", verifyCandidates: [], persistentInstructionsHelp: "", evolutionLabels: createAgentEvolutionLabels() }, { ...enabled, soul: false })).toBe(true);
    expect(serializeAgentPatch({ ...enabled, soul: false }, true)?.soul).toBe(false);
  });

  it("reports a stable blocking error when soul delivery is unsupported", () => {
    const state = { ...blankAgentFields(), name: "wrapped", cmd: "bash -lc codex", soul: true };
    expect(validateForm(state, [])).toContainEqual({ code: "soul-runtime-unsupported", blocking: true, param: "bash" });
    expect(validateForm({ ...state, cmd: "hermes" }, [])).toContainEqual({ code: "soul-runtime-unsupported", blocking: true, param: "hermes" });
    expect(validateForm({ ...state, cmd: "opencode" }, []).some((issue) => issue.code === "soul-runtime-unsupported")).toBe(false);
    expect(validateForm({ ...state, soul: false }, []).some((issue) => issue.code === "soul-runtime-unsupported")).toBe(false);
  });

  it("rejects an untrusted non-boolean host patch without serializing truthy values", () => {
    const state = { ...blankAgentFields(), name: "invalid", cmd: "codex", soul: "true" } as unknown as FormState;
    expect(validateForm(state, [])).toContainEqual({ code: "soul-invalid", blocking: true });
    expect(toEntry(state).soul).toBeUndefined();
  });

  it("accepts a legacy restored patch with no soul field as disabled", () => {
    const { soul: _soul, ...legacy } = blankAgentFields();
    const state = legacy as FormState;
    expect(validateForm({ ...state, name: "legacy", cmd: "codex" }, []).some((issue) => issue.code === "soul-invalid")).toBe(false);
    expect(toEntry({ ...state, name: "legacy", cmd: "codex" }).soul).toBeUndefined();
  });

  it("renders the smallest two-state control before Role and labels the text area Persistent instructions", () => {
    const source = fs.readFileSync(path.resolve("src/webview/agent-studio-shell/App.tsx"), "utf8");
    const soul = source.indexOf("Enable Soul");
    const role = source.indexOf("Role template");
    expect(soul).toBeGreaterThan(-1);
    expect(role).toBeGreaterThan(soul);
    expect(source).toContain("Persistent instructions");
  });
});
