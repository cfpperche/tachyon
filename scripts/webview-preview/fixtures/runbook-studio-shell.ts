/**
 * Phase 4 — Runbook Studio (shell) preview fixtures: create, dense edit, and load-error states rendered
 * through the real studio-shell protocol for visual passes without an extension host.
 */

import type { RunbookStudioEntity, RunbookStudioReferenceData } from "../../../src/webview/runbook-studio-shell/domain";
import { blankRunbookFields } from "../../../src/webview/runbook-studio-shell/domain";
import type { Fixture, Route } from "../routes";

interface RunbookStudioShellFixtureVM {
  entity: RunbookStudioEntity;
  referenceData: RunbookStudioReferenceData;
  /**
   * t-f4e186 — the shape the HOST actually posts when a load fails, `source` included.
   * `SingleModeStudioPanelManager.postError` maps every failure through
   * `mapUnknownError("transport", …)`, so a real load error is `transport/unknown` from `transport` —
   * never `persistence/not-found`, which t-b643ac converted into a `tombstone` envelope.
   */
  loadError?: { code: string; message: string; source?: "validation" | "persistence" | "transport" };
}

const STUDIO_PROTOCOL_VERSION = 1;

function envelope<T extends { type: string }>(message: T) {
  return { ...message, studioProtocolVersion: STUDIO_PROTOCOL_VERSION };
}

export function runbookStudioShellMakeMessage(vm: RunbookStudioShellFixtureVM): unknown {
  if (vm.loadError) {
    return envelope({
      type: "error",
      code: vm.loadError.code,
      message: vm.loadError.message,
      ...(vm.loadError.source ? { source: vm.loadError.source } : {}),
      blocking: true,
    });
  }
  return envelope({ type: "load", entity: vm.entity, referenceData: vm.referenceData, concurrency: { kind: "none" } });
}

const referenceData: RunbookStudioReferenceData = {
  commandNames: ["lint", "test", "build-web", "deploy-preview"],
};

const newEntity: RunbookStudioEntity = {
  fields: blankRunbookFields(),
};

const denseEntity: RunbookStudioEntity = {
  name: "release-preview",
  fields: {
    ...blankRunbookFields(),
    name: "release-preview",
    steps: "lint\ntest\nbuild-web\n./scripts/publish-preview.sh --channel beta",
  },
};

export const runbookStudioShellFixtures: Record<string, Fixture<RunbookStudioShellFixtureVM>> = {
  new: { provenance: "synthetic-edge", vm: { entity: newEntity, referenceData } },
  "dense-edit": { provenance: "synthetic-edge", vm: { entity: denseEntity, referenceData } },
  /**
   * t-f4e186 — repointed onto the error production still sends. This adapter's `load` has no
   * `status: "error"` arm at all and its `not-found` became a `tombstone` in t-b643ac, so the ONE
   * door left to a bare `error` here is the manager's own "workspace is not attached" refusal
   * (`SingleModeStudioPanelManager.load`), posted through `mapUnknownError("transport", …)`.
   */
  "load-error": {
    provenance: "synthetic-edge",
    vm: {
      entity: newEntity,
      referenceData,
      loadError: { code: "transport/unknown", source: "transport", message: "workspace 8f3a12c4 is not attached" },
    },
  },
};

export type { RunbookStudioShellFixtureVM };
export type RunbookStudioShellRoute = Route<RunbookStudioShellFixtureVM>;
