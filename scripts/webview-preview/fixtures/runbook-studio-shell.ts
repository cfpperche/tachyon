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
  loadError?: { code: string; message: string };
}

const STUDIO_PROTOCOL_VERSION = 1;

function envelope<T extends { type: string }>(message: T) {
  return { ...message, studioProtocolVersion: STUDIO_PROTOCOL_VERSION };
}

export function runbookStudioShellMakeMessage(vm: RunbookStudioShellFixtureVM): unknown {
  if (vm.loadError) {
    return envelope({ type: "error", code: vm.loadError.code, message: vm.loadError.message, blocking: true });
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
  "load-error": { provenance: "synthetic-edge", vm: { entity: newEntity, referenceData, loadError: { code: "persistence/not-found", message: "This runbook no longer exists." } } },
};

export type { RunbookStudioShellFixtureVM };
export type RunbookStudioShellRoute = Route<RunbookStudioShellFixtureVM>;
