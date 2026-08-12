import type { ViewKind } from "./EngineHost.js";

export type DomainChanged = (view: ViewKind) => void;

export interface DomainActionSource {
  pinStore: {
    list(): Array<{ id: string }>;
    setDone(id: string, done: boolean): Promise<unknown>;
    remove(id: string): Promise<unknown>;
  };
  toggleSchedulePause(name: string): unknown;
  deleteScheduleEntry(name: string): unknown;
  approveProposal(id: string): boolean;
  rejectProposal(id: string): unknown;
  listNoticeInbox?(): Array<{ id: string }>;
  markNoticeRead?(id: string): boolean;
  markAllNoticesRead?(): boolean;
  invokeNoticeInboxAction?(noticeId: string, actionId: string): Promise<boolean>;
  /** t-a39c7d — human focused agent pane; clear done(unseen). */
  markAgentPaneSeen?(agent: string): void;
  /**
   * t-7d6013 — the human dismissed the config-discard banner. Takes the SIGNATURE that was on
   * screen and reports whether it still matched, so a stale click hides nothing.
   */
  dismissConfigDiscards?(signature: string): boolean;
}

export interface DomainActionDeps {
  onChanged: DomainChanged;
}

function pinExists(ws: DomainActionSource, pinId: string): boolean {
  return ws.pinStore.list().some((p) => p.id === pinId);
}

export async function togglePinDone(ws: DomainActionSource, pinId: string, done: boolean, deps: DomainActionDeps): Promise<boolean> {
  if (!pinExists(ws, pinId)) return false;
  await ws.pinStore.setDone(pinId, done);
  deps.onChanged("pins");
  return true;
}

export async function deletePin(ws: DomainActionSource, pinId: string, deps: DomainActionDeps): Promise<boolean> {
  if (!pinExists(ws, pinId)) return false;
  await ws.pinStore.remove(pinId);
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
