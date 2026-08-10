/**
 * Phase 4 — Command Studio (shell) preview fixtures: create, dense edit, and load-error states rendered
 * through the real studio-shell protocol for visual passes without an extension host.
 */

import type { CommandStudioEntity, CommandStudioReferenceData } from "../../../src/webview/command-studio-shell/domain";
import { blankCommandFields } from "../../../src/webview/command-studio-shell/domain";
import type { Fixture, Route } from "../routes";

interface CommandStudioShellFixtureVM {
  entity: CommandStudioEntity;
  referenceData: CommandStudioReferenceData;
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

export function commandStudioShellMakeMessage(vm: CommandStudioShellFixtureVM): unknown {
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

const referenceData: CommandStudioReferenceData = {
  flagMap: {
    npm: ["-- --runInBand", "-- --watch=false", "-- --coverage"],
    pnpm: ["--filter web", "--filter extension", "--recursive"],
    bash: ["-lc", "-euxo pipefail"],
  },
  defaultCwd: "/home/dev/project",
};

const newEntity: CommandStudioEntity = {
  fields: blankCommandFields(),
};

const denseEntity: CommandStudioEntity = {
  name: "verify-ui",
  fields: {
    ...blankCommandFields(),
    name: "verify-ui",
    cmd: "pnpm --filter web test -- --runInBand",
    cwd: "apps/web",
  },
};

export const commandStudioShellFixtures: Record<string, Fixture<CommandStudioShellFixtureVM>> = {
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

export type { CommandStudioShellFixtureVM };
export type CommandStudioShellRoute = Route<CommandStudioShellFixtureVM>;
