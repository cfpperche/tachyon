import { describe, it, expect } from "vitest";
import { ATTESTED_RUNTIMES, isAttestedRuntime, type AttestedRuntime } from "../../src/runtime/attestedRuntimes.js";
import { RESUME_RUNTIMES, adapterForRuntime, runtimeOf, type ResumeRuntime } from "../../src/resume/adapters.js";
import { KNOWN_AI_CLIS, inferKind } from "../../src/config/loadConfig.js";
import { profileRuntimeInspectorFor } from "../../src/config/agentProfileProjection.js";

/**
 * SDD 478 M1 — `AttestedRuntime` is the single answer to "which runtimes may operate an Agent".
 * These assertions exist so that adding a runtime to ONE list without the others FAILS, which is
 * the property the three pre-M1 lists lacked: `KNOWN_AI_CLIS` (15), `ResumeRuntime` (10) and the
 * attested literal set (4) disagreed by construction, so an entry could be both "an agent" and
 * "not attestable as an agent".
 */
describe("AttestedRuntime — the single runtime list (SDD 478 M1)", () => {
  it("is a subset of the resumable runtimes, at the type level and against the real adapter registry", () => {
    // Compile-time half: ResumeRuntime is DEFINED as AttestedRuntime | …, so this assignment is
    // only well-typed while the subset relation holds. Widening AttestedRuntime widens ResumeRuntime.
    const attestedIsResumable: ResumeRuntime = "codex" satisfies AttestedRuntime;
    expect(attestedIsResumable).toBe("codex");

    // Runtime half: the type union says nothing about ADAPTERS actually covering each member.
    for (const runtime of ATTESTED_RUNTIMES) {
      expect(RESUME_RUNTIMES, `${runtime} is attested but has no resume adapter`).toContain(runtime);
      expect(adapterForRuntime(runtime), `${runtime} is attested but adapterForRuntime is empty`).toBeDefined();
    }
  });

  it("keeps resumable-but-unattested runtimes out of the attested set", () => {
    // The exact runtimes the inventory named: agents to KNOWN_AI_CLIS, resumable to ResumeRuntime,
    // and refused by the canonical attestation.
    for (const runtime of ["opencode", "gemini", "qwen", "antigravity", "continue", "hermes"] as const) {
      expect(RESUME_RUNTIMES, `${runtime} should still be resumable`).toContain(runtime);
      expect(isAttestedRuntime(runtime), `${runtime} must not be attested`).toBe(false);
    }
  });

  it("names binaries: an attested runtime resolves from its own name", () => {
    // A canonical agent requires `executable === adapter`, so the attested names must also be the
    // binaries the resume registry recognizes.
    for (const runtime of ATTESTED_RUNTIMES) {
      expect(runtimeOf(runtime), `${runtime} is attested but is not a known runtime binary`).toBe(runtime);
    }
  });

  it("has a measured private-home inspector for every attested runtime, and only for those", () => {
    for (const runtime of ATTESTED_RUNTIMES) {
      expect(profileRuntimeInspectorFor(runtime)?.adapter, `${runtime} has no registered inspector`).toBe(runtime);
    }
    expect(profileRuntimeInspectorFor("opencode")).toBeUndefined();
    expect(profileRuntimeInspectorFor("sh")).toBeUndefined();
  });

  it("cannot be omitted from the authoring suggestions, which stay a superset", () => {
    for (const runtime of ATTESTED_RUNTIMES) {
      expect(KNOWN_AI_CLIS, `${runtime} is attested but absent from KNOWN_AI_CLIS`).toContain(runtime);
      expect(inferKind(runtime)).toBe("agent");
    }
    // The suggestion list stays wider than the attested set — being suggested is not being attested.
    expect(KNOWN_AI_CLIS.length).toBeGreaterThan(ATTESTED_RUNTIMES.length);
    expect(KNOWN_AI_CLIS).toContain("opencode");
    expect(isAttestedRuntime("opencode")).toBe(false);
  });

  it("refuses anything that is not a runtime name", () => {
    for (const value of ["sh", "bash", "npm run dev", "", "CLAUDE", null, undefined]) {
      expect(isAttestedRuntime(value)).toBe(false);
    }
  });
});
