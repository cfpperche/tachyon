/**
 * Phase 4 — Schedule Studio (shell) preview fixtures: create, dense edit, and load-error states rendered
 * through the real studio-shell protocol for visual passes without an extension host.
 */

import type { ScheduleStudioEntity, ScheduleStudioReferenceData } from "@tachyon/webview-ui/webview/schedule-studio-shell/domain";
import { blankScheduleFields } from "@tachyon/webview-ui/webview/schedule-studio-shell/domain";
import type { Fixture, Route } from "../routes";

interface ScheduleStudioShellFixtureVM {
  entity: ScheduleStudioEntity;
  referenceData: ScheduleStudioReferenceData;
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

export function scheduleStudioShellMakeMessage(vm: ScheduleStudioShellFixtureVM): unknown {
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

export type { ScheduleStudioShellFixtureVM };
export type ScheduleStudioShellRoute = Route<ScheduleStudioShellFixtureVM>;
