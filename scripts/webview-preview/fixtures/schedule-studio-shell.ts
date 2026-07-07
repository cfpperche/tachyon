/**
 * Phase 4 — Schedule Studio (shell) preview fixtures: create, dense edit, and load-error states rendered
 * through the real studio-shell protocol for visual passes without an extension host.
 */

import type { ScheduleStudioEntity, ScheduleStudioReferenceData } from "../../../src/webview/schedule-studio-shell/domain";
import { blankScheduleFields } from "../../../src/webview/schedule-studio-shell/domain";
import type { Fixture, Route } from "../routes";

interface ScheduleStudioShellFixtureVM {
  entity: ScheduleStudioEntity;
  referenceData: ScheduleStudioReferenceData;
  loadError?: { code: string; message: string };
}

const STUDIO_PROTOCOL_VERSION = 1;

function envelope<T extends { type: string }>(message: T) {
  return { ...message, studioProtocolVersion: STUDIO_PROTOCOL_VERSION };
}

export function scheduleStudioShellMakeMessage(vm: ScheduleStudioShellFixtureVM): unknown {
  if (vm.loadError) {
    return envelope({ type: "error", code: vm.loadError.code, message: vm.loadError.message, blocking: true });
  }
  return envelope({ type: "load", entity: vm.entity, referenceData: vm.referenceData, concurrency: { kind: "none" } });
}

const referenceData: ScheduleStudioReferenceData = {
  commandNames: ["lint", "test", "build-web"],
  runbookNames: ["release-preview", "nightly-maintenance"],
  agentNames: ["claude", "codex", "reviewer"],
};

const newEntity: ScheduleStudioEntity = {
  fields: blankScheduleFields(),
};

const denseEntity: ScheduleStudioEntity = {
  name: "nightly-release-check",
  fields: {
    ...blankScheduleFields(),
    name: "nightly-release-check",
    schedTiming: "at",
    schedAt: "21:30",
    schedAction: "run",
    schedTarget: "release-preview",
    catchUp: true,
  },
};

export const scheduleStudioShellFixtures: Record<string, Fixture<ScheduleStudioShellFixtureVM>> = {
  new: { provenance: "synthetic-edge", vm: { entity: newEntity, referenceData } },
  "dense-edit": { provenance: "synthetic-edge", vm: { entity: denseEntity, referenceData } },
  "load-error": { provenance: "synthetic-edge", vm: { entity: newEntity, referenceData, loadError: { code: "persistence/not-found", message: "This schedule no longer exists." } } },
};

export type { ScheduleStudioShellFixtureVM };
export type ScheduleStudioShellRoute = Route<ScheduleStudioShellFixtureVM>;
