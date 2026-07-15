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

export function applySidebarMutation(
  source: DomainActionSource,
  rawInput: unknown,
  onChanged: DomainChanged,
): SidebarMutationResult {
  const input = parseSidebarMutationInputV1(rawInput);
  const deps = { onChanged };
  const changed = input.action === "pin.toggle" ? togglePinDone(source, input.id, input.done, deps)
    : input.action === "pin.delete" ? deletePin(source, input.id, deps)
      : input.action === "schedule.toggle-pause" ? toggleSchedulePause(source, input.id, deps)
        : input.action === "schedule.delete" ? deleteSchedule(source, input.id, deps)
          : input.action === "proposal.approve" ? approveProposal(source, input.id, deps)
            : rejectProposal(source, input.id, deps);
  return { action: input.action, id: input.id, changed };
}
