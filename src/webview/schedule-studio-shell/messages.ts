import { envelope } from "../shared/studio/protocol";
import type { ScheduleStudioPatch } from "./domain";

/** t-610705 (Phase D, D1a) — routeKey/mountNonce identify WHICH Control-hosted binding this ready is
 *  for (studioHost.ts's mount handshake, round-2 F3); undefined off the Control host. */
export const readyMessage = (mount?: { routeKey: string; mountNonce: string }) =>
  envelope({ type: "ready" as const, ...(mount ? { routeKey: mount.routeKey, mountNonce: mount.mountNonce } : {}) });
export const patchMessage = (patch: ScheduleStudioPatch, editRevision?: number) =>
  envelope({ type: "patch" as const, patch, ...(editRevision !== undefined ? { editRevision } : {}) });
export const dirtyMessage = (dirty: boolean) => envelope({ type: "dirty" as const, dirty });
export const saveMessage = () => envelope({ type: "save" as const });
export const cancelMessage = () => envelope({ type: "cancel" as const });
