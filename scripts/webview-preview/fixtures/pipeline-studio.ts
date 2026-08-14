/**
 * spec 350 T4/T7 — Pipeline Studio (Fake 1) preview fixtures: every stateful scenario the dueto's F13
 * required (clean, dirty, validation-blocked, save-pending, stale/conflict, load-error, domain-action).
 * `dirty`/`validation-blocked` are reached through the REAL `restore` protocol message (an unsaved patch
 * snapshot) rather than a synthetic bypass — restore is exactly "come back with an unsaved patch" per T2's
 * decideRestore, so it's the honest way to seed a dirty state without live user interaction. `save-pending`
 * and `stale/conflict` ARE synthetic-edge: the live Fake-1 adapter never produces them (concurrency: none,
 * saveInFlight resolves fast), but the shell's protocol shapes support them and the visual pass needs to see
 * the banners render.
 */

import type { PipelineEntity, PipelineFields } from "@tachyon/webview-ui/webview/pipeline-studio/domain";
import type { Fixture, Route } from "../routes";

interface PipelineFixtureVM {
  entity: PipelineEntity;
  concurrency: { kind: "none" } | { kind: "cas"; expected?: string; stale?: boolean };
  saveInFlight?: boolean;
  restorePatch?: PipelineFields;
  loadError?: { code: string; message: string };
  domainReplyStages?: PipelineEntity["stages"];
}

const STUDIO_PROTOCOL_VERSION = 1;

function envelope<T extends { type: string }>(message: T) {
  return { ...message, studioProtocolVersion: STUDIO_PROTOCOL_VERSION };
}

export function pipelineStudioMakeMessage(vm: PipelineFixtureVM): unknown[] {
  if (vm.loadError) {
    return [envelope({ type: "error", code: vm.loadError.code, message: vm.loadError.message, blocking: true })];
  }
  const messages: unknown[] = [envelope({ type: "load", entity: vm.entity, concurrency: vm.concurrency, saveInFlight: !!vm.saveInFlight })];
  if (vm.restorePatch) {
    messages.push(
      envelope({
        type: "restore",
        snapshot: { schemaVersion: 1, entityType: "pipeline", mode: vm.entity.id === "new" ? "new" : "edit", entityId: vm.entity.id === "new" ? undefined : vm.entity.id, patch: vm.restorePatch },
      }),
    );
  }
  if (vm.domainReplyStages) {
    messages.push(envelope({ type: "stagesImported", stages: vm.domainReplyStages }));
  }
  return messages;
}

const cleanEntity: PipelineEntity = { id: "new", title: "", stages: [] };
const savedEntity: PipelineEntity = { id: "pl-9f2a", title: "Nightly release", stages: [{ id: "s1", name: "build" }, { id: "s2", name: "test" }, { id: "s3", name: "deploy" }] };

export const pipelineStudioFixtures: Record<string, Fixture<PipelineFixtureVM>> = {
  clean: { provenance: "synthetic-edge", vm: { entity: cleanEntity, concurrency: { kind: "none" } } },
  dirty: {
    provenance: "synthetic-edge",
    vm: { entity: savedEntity, concurrency: { kind: "none" }, restorePatch: { title: "Nightly release (renamed)", stages: savedEntity.stages } },
  },
  "validation-blocked": {
    provenance: "synthetic-edge",
    vm: { entity: savedEntity, concurrency: { kind: "none" }, restorePatch: { title: "", stages: savedEntity.stages } },
  },
  "save-pending": { provenance: "synthetic-edge", vm: { entity: savedEntity, concurrency: { kind: "none" }, saveInFlight: true } },
  "stale-conflict": { provenance: "synthetic-edge", vm: { entity: savedEntity, concurrency: { kind: "cas", expected: "rev-1", stale: true } } },
  "load-error": { provenance: "synthetic-edge", vm: { entity: cleanEntity, concurrency: { kind: "none" }, loadError: { code: "persistence/not-found", message: "This pipeline no longer exists." } } },
  "domain-action": {
    provenance: "synthetic-edge",
    vm: { entity: cleanEntity, concurrency: { kind: "none" }, domainReplyStages: [{ id: "stage-1", name: "lint" }, { id: "stage-2", name: "test" }, { id: "stage-3", name: "package" }] },
  },
};

export type { PipelineFixtureVM };
export type PipelineStudioRoute = Route<PipelineFixtureVM>;
