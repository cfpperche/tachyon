import {
  approveProposal,
  deletePin,
  deleteSchedule,
  rejectProposal,
  togglePinDone,
  toggleSchedulePause,
  type DomainActionSource,
  type DomainChanged,
} from "../workspace/domainActions.js";
import {
  parseSidebarMutationInputV1,
  type SidebarMutationInputV1,
} from "../runtime-api/sidebarCommands.js";

export interface SidebarMutationResult {
  action: SidebarMutationInputV1["action"];
  id: string;
  changed: boolean;
}

export async function applySidebarMutation(
  source: DomainActionSource,
  rawInput: unknown,
  onChanged: DomainChanged,
): Promise<SidebarMutationResult> {
  const input = parseSidebarMutationInputV1(rawInput);
  const deps = { onChanged };
  if (input.action === "notice.markRead") {
    const changed = source.markNoticeRead?.(input.id) ?? false;
    return { action: input.action, id: input.id, changed };
  }
  if (input.action === "notice.markAllRead") {
    const changed = source.markAllNoticesRead?.() ?? false;
    return { action: input.action, id: "all", changed };
  }
  if (input.action === "notice.invoke") {
    const changed = (await source.invokeNoticeInboxAction?.(input.id, input.actionId)) ?? false;
    return { action: input.action, id: input.id, changed };
  }
  if (input.action === "config.dismissDiscards") {
    // t-7d6013 — the human read the discard banner and took it off the screen. `changed: false` when
    // the signature no longer matches (a reload landed between render and click), which leaves the
    // current set on screen rather than hiding one nobody has read.
    const changed = source.dismissConfigDiscards?.(input.id) ?? false;
    if (changed) onChanged("agents");
    return { action: input.action, id: input.id, changed };
  }
  if (input.action === "agent.markSeen") {
    source.markAgentPaneSeen?.(input.id);
    onChanged("agents");
    return { action: input.action, id: input.id, changed: true };
  }
  const changed = input.action === "pin.toggle" ? await togglePinDone(source, input.id, input.done, deps)
    : input.action === "pin.delete" ? await deletePin(source, input.id, deps)
      : input.action === "schedule.toggle-pause" ? toggleSchedulePause(source, input.id, deps)
        : input.action === "schedule.delete" ? deleteSchedule(source, input.id, deps)
          : input.action === "proposal.approve" ? approveProposal(source, input.id, deps)
            : rejectProposal(source, input.id, deps);
  return { action: input.action, id: input.id, changed };
}
