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

export function terminalStudioShellMakeMessage(vm: TerminalStudioShellFixtureVM): unknown {
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
    // t-b54ead — worktree/branch/worktreeSetup stay at their blank defaults on purpose: the
    // Terminal Studio has no controls for them (they are agent-only, and the loader refuses all three
    // under `terminals:`). A fixture that set them would render nothing and prove nothing.
  },
};

export const terminalStudioShellFixtures: Record<string, Fixture<TerminalStudioShellFixtureVM>> = {
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

export type { TerminalStudioShellFixtureVM };
export type TerminalStudioShellRoute = Route<TerminalStudioShellFixtureVM>;
