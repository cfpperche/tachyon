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
  loadError?: { code: string; message: string };
}

const STUDIO_PROTOCOL_VERSION = 1;

function envelope<T extends { type: string }>(message: T) {
  return { ...message, studioProtocolVersion: STUDIO_PROTOCOL_VERSION };
}

export function commandStudioShellMakeMessage(vm: CommandStudioShellFixtureVM): unknown {
  if (vm.loadError) {
    return envelope({ type: "error", code: vm.loadError.code, message: vm.loadError.message, blocking: true });
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
  verifyCandidates: ["npm test", "npm run lint", "npm run typecheck"],
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
  "load-error": { provenance: "synthetic-edge", vm: { entity: newEntity, referenceData, loadError: { code: "persistence/not-found", message: "This command no longer exists." } } },
};

export type { CommandStudioShellFixtureVM };
export type CommandStudioShellRoute = Route<CommandStudioShellFixtureVM>;
