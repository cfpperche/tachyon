import type { ViewKind } from "./EngineHost.js";
import type { Workspace } from "./Workspace.js";

export type DomainChanged = (view: ViewKind) => void;

export interface DomainActionDeps {
  onChanged: DomainChanged;
}

function pinExists(ws: Workspace, pinId: string): boolean {
  return ws.pinStore.list().some((p) => p.id === pinId);
}

export function togglePinDone(ws: Workspace, pinId: string, done: boolean, deps: DomainActionDeps): boolean {
  if (!pinExists(ws, pinId)) return false;
  ws.pinStore.setDone(pinId, done);
  deps.onChanged("pins");
  return true;
}

export function deletePin(ws: Workspace, pinId: string, deps: DomainActionDeps): boolean {
  if (!pinExists(ws, pinId)) return false;
  ws.pinStore.remove(pinId);
  deps.onChanged("pins");
  return true;
}

export function toggleSchedulePause(ws: Workspace, scheduleName: string, _deps: DomainActionDeps): boolean {
  ws.toggleSchedulePause(scheduleName);
  return true;
}

export function deleteSchedule(ws: Workspace, scheduleName: string, _deps: DomainActionDeps): boolean {
  ws.deleteScheduleEntry(scheduleName);
  return true;
}

export function approveProposal(ws: Workspace, proposalId: string, _deps: DomainActionDeps): boolean {
  return ws.approveProposal(proposalId);
}

export function rejectProposal(ws: Workspace, proposalId: string, _deps: DomainActionDeps): boolean {
  ws.rejectProposal(proposalId);
  return true;
}
