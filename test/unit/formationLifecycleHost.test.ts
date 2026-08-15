import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  FormationAuthorityStore,
  type ResolvedFormationPayload,
} from "@tachyon/engine/agents/formation/authorityStore.js";
import {
  createFormationLifecycleHost,
  verifyLifecycleNativeSuppression,
} from "@tachyon/engine/agents/formation/lifecycleHost.js";
import {
  formationDigest,
  type FormationAuthorityVector,
  type FormationGenerationHeadV1,
  type ProfileActivationHeadV2,
} from "@tachyon/engine/agents/formation/domain.js";
import { isNativeSuppressionConfirmed } from "@tachyon/engine/runtime/nativeLaneSuppression.js";
import { makeTempDir } from "../helpers/tempDir.js";

const WORKSPACE_ID = "workspace-test";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const HEX_A = "a".repeat(64);
const HEX_B = "b".repeat(64);
const HEX_C = "c".repeat(64);
const human = { principal: "human-alice", kind: "human" as const };
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function host() {
  return createFormationLifecycleHost({
    hostRoot: makeTempDir("formation-lifecycle-host-"),
    agentIdOf: () => undefined,
  });
}

function profile(adapter: string): ProfileActivationHeadV2 {
  return {
    schemaVersion: 2,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    agentName: adapter,
    revision: 1,
    priorRevision: 0,
    canonicalSha256: HEX_A,
    effectiveSha256: HEX_B,
    runtimeInspector: { adapter, id: "inspector", version: "1", sha256: HEX_C },
    lanes: {
      instructions: {
        mode: "profile",
        required: true,
        selectorId: "sel-instructions",
        subjectId: "sub-instructions",
        path: "instructions.md",
        sourceSha256: HEX_A,
        rendererContract: "tachyon-persistent-instructions-v1",
        rendererSha256: HEX_B,
      },
      memory: { mode: "disabled" },
    },
  };
}

function vector(adapter: string): FormationAuthorityVector {
  const activeProfile = profile(adapter);
  const head: FormationGenerationHeadV1 = {
    schemaVersion: 1,
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    generation: 1,
    priorGeneration: 0,
    retired: false,
    profile: { revision: activeProfile.revision, digest: formationDigest(activeProfile) },
    rendererContractsSha256: HEX_C,
  };
  return { profile: activeProfile, generation: head };
}

function evidence(adapter: string, active: FormationAuthorityVector, operationId: string) {
  return {
    schemaVersion: 1 as const,
    operationId,
    sourceVectorSha256: formationDigest(active),
    runtimeAdapter: adapter,
    runtimeTrustClass: `${adapter}-v1`,
    lanes: ["instructions"] as Array<"instructions" | "memory">,
    issuedAt: "2026-07-22T12:00:00.000Z",
    mac: HEX_A,
  };
}

function publishingStore(adapter: string) {
  const root = fs.mkdtempSync(path.join(makeTempDir("formation-host-verify-"), "store-"));
  roots.push(root);
  const active = vector(adapter);
  let payload: Omit<ResolvedFormationPayload, "sourceVectorSha256" | "rendererContractsSha256"> = {
    startupPrompt: "startup",
    reanchorReminder: "reanchor",
    nativeSuppression: evidence(adapter, active, "fresh-one"),
  };
  const store = new FormationAuthorityStore(root, {
    now: () => "2026-07-22T12:00:00.000Z",
    leaseTtlMs: 60_000,
    authorizeLaunch: () => true,
    authorizeMutation: () => true,
    authorizeSelectorRevocation: () => true,
    authorizeSelectorRead: () => true,
    verifyNativeSuppression: verifyLifecycleNativeSuppression,
    resolvePayload: ({ vector: current }) => ({
      ...payload,
      sourceVectorSha256: formationDigest(current),
      rendererContractsSha256: current.generation.rendererContractsSha256,
    }),
  });
  store.replaceVector({ operationId: "generation-one", caller: human, mutation: "bootstrap", vector: active });
  return { store, active };
}

describe("t-4c3d90 — formation lifecycle host reads the production suppression registry", () => {
  it("confirms the same adapters the production registry confirms", () => {
    const port = host();
    for (const adapter of ["claude", "codex", "grok", "nope"] as const) {
      expect(port.nativeSuppressionConfirmed(adapter), adapter).toBe(isNativeSuppressionConfirmed(adapter));
    }
    expect(port.nativeSuppressionConfirmed("claude")).toBe(true);
    expect(port.nativeSuppressionConfirmed("codex")).toBe(true);
    expect(port.nativeSuppressionConfirmed("grok")).toBe(false);
    expect(port.nativeSuppressionConfirmed("nope")).toBe(false);
  });

  it("reports no suppression when the agent has no formation vector", () => {
    expect(host().suppressionRequired("nobody")).toBe(false);
  });

  it("lets a measured adapter commit profile formation and refuses an unverified one", () => {
    const claude = publishingStore("claude");
    expect(() => claude.store.prepareSnapshot({
      operationId: "fresh-one",
      caller: human,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      agentName: "claude",
      runtimeTrustClass: "claude-v1",
      expectedGenerationSha256: formationDigest(claude.active.generation),
    })).not.toThrow();

    const grok = publishingStore("grok");
    expect(() => grok.store.prepareSnapshot({
      operationId: "fresh-one",
      caller: human,
      workspaceId: WORKSPACE_ID,
      agentId: AGENT_ID,
      agentName: "grok",
      runtimeTrustClass: "grok-v1",
      expectedGenerationSha256: formationDigest(grok.active.generation),
    })).toThrow(/invalid at publication/);
  });

  it("does not hardcode the host verify callback to false", () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), "packages/engine/src/agents/formation/lifecycleHost.ts"),
      "utf8",
    );
    expect(src).toContain('from "../../runtime/nativeLaneSuppression.js"');
    expect(src).toContain("verifyNativeSuppression: verifyLifecycleNativeSuppression");
    expect(src).not.toMatch(/verifyNativeSuppression:\s*\(\)\s*=>\s*false/);
  });
});
