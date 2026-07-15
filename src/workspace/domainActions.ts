import type { ViewKind } from "./EngineHost.js";

export type DomainChanged = (view: ViewKind) => void;

export interface DomainActionSource {
  pinStore: {
    list(): Array<{ id: string }>;
    setDone(id: string, done: boolean): unknown;
    remove(id: string): unknown;
  };
  toggleSchedulePause(name: string): unknown;
  deleteScheduleEntry(name: string): unknown;
  approveProposal(id: string): boolean;
  rejectProposal(id: string): unknown;
}

export interface DomainActionDeps {
  onChanged: DomainChanged;
}

function pinExists(ws: DomainActionSource, pinId: string): boolean {
  return ws.pinStore.list().some((p) => p.id === pinId);
}

export function togglePinDone(ws: DomainActionSource, pinId: string, done: boolean, deps: DomainActionDeps): boolean {
  if (!pinExists(ws, pinId)) return false;
  ws.pinStore.setDone(pinId, done);
  deps.onChanged("pins");
  return true;
}

export function deletePin(ws: DomainActionSource, pinId: string, deps: DomainActionDeps): boolean {
  if (!pinExists(ws, pinId)) return false;
  ws.pinStore.remove(pinId);
  deps.onChanged("pins");
  return true;
}

export function toggleSchedulePause(ws: DomainActionSource, scheduleName: string, _deps: DomainActionDeps): boolean {
  ws.toggleSchedulePause(scheduleName);
  return true;
}

export function deleteSchedule(ws: DomainActionSource, scheduleName: string, _deps: DomainActionDeps): boolean {
  ws.deleteScheduleEntry(scheduleName);
  return true;
}

export function approveProposal(ws: DomainActionSource, proposalId: string, _deps: DomainActionDeps): boolean {
  return ws.approveProposal(proposalId);
}

export function rejectProposal(ws: DomainActionSource, proposalId: string, _deps: DomainActionDeps): boolean {
  ws.rejectProposal(proposalId);
  return true;
}
