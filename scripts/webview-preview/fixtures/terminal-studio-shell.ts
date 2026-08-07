/**
 * Phase 4 — Terminal Studio (shell) preview fixtures: create, dense edit, and load-error states rendered
 * through the real studio-shell protocol for visual passes without an extension host.
 */

import type { TerminalStudioEntity, TerminalStudioReferenceData } from "../../../src/webview/terminal-studio-shell/domain";
import { blankTerminalFields } from "../../../src/webview/terminal-studio-shell/domain";
import type { Fixture, Route } from "../routes";

interface TerminalStudioShellFixtureVM {
  entity: TerminalStudioEntity;
  referenceData: TerminalStudioReferenceData;
  loadError?: { code: string; message: string };
}

const STUDIO_PROTOCOL_VERSION = 1;

function envelope<T extends { type: string }>(message: T) {
  return { ...message, studioProtocolVersion: STUDIO_PROTOCOL_VERSION };
}

export function terminalStudioShellMakeMessage(vm: TerminalStudioShellFixtureVM): unknown {
  if (vm.loadError) {
    return envelope({ type: "error", code: vm.loadError.code, message: vm.loadError.message, blocking: true });
  }
  return envelope({ type: "load", entity: vm.entity, referenceData: vm.referenceData, concurrency: { kind: "none" } });
}

const referenceData: TerminalStudioReferenceData = {
  flagMap: {
    npm: ["-- --host 0.0.0.0", "-- --clearScreen false"],
    docker: ["compose", "--profile dev", "--watch"],
    bash: ["-lc"],
  },
  defaultCwd: "/home/dev/project",
};

const newEntity: TerminalStudioEntity = {
  fields: blankTerminalFields(),
};

const denseEntity: TerminalStudioEntity = {
  name: "dev-server",
  fields: {
    ...blankTerminalFields(),
    name: "dev-server",
    cmd: "npm run dev -- --host 0.0.0.0",
    watch: "src/**, package.json, vite.config.ts",
    cwd: "apps/web",
    autostart: true,
    restartOnCrash: true,
    attention: true,
    // t-b54ead — worktree/branch/worktreeSetup/verify stay at their blank defaults on purpose: the
    // Terminal Studio has no controls for them (they are agent-only, and the loader refuses all four
    // under `terminals:`). A fixture that set them would render nothing and prove nothing.
  },
};

export const terminalStudioShellFixtures: Record<string, Fixture<TerminalStudioShellFixtureVM>> = {
  new: { provenance: "synthetic-edge", vm: { entity: newEntity, referenceData } },
  "dense-edit": { provenance: "synthetic-edge", vm: { entity: denseEntity, referenceData } },
  "load-error": { provenance: "synthetic-edge", vm: { entity: newEntity, referenceData, loadError: { code: "persistence/not-found", message: "This terminal no longer exists." } } },
};

export type { TerminalStudioShellFixtureVM };
export type TerminalStudioShellRoute = Route<TerminalStudioShellFixtureVM>;
