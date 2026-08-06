/**
 * t-41117e — destination picker for "Continue task in…".
 * One implementation for the Fleet tab and the sidebar Agents roster.
 */
import type { AgentVM } from "../../../sidebar/types";
import { QuickPicker, type QuickPickerItem } from "../ui";
import { continueTaskCandidates, destinationBusy } from "./continueTaskCandidates";

export interface ContinuePickerStrings {
  continueTaskPickTitle: string;
  continueTaskPickSubtitle: string;
  continueTaskPickPlaceholder: string;
  continueTaskPickEmpty: string;
  continueTaskDestStopped: string;
  continueTaskDestRunning: string;
  continueTaskDestDetail: string;
}

export const defaultContinuePickerStrings: ContinuePickerStrings = {
  continueTaskPickTitle: "Continue {0} task in…",
  continueTaskPickSubtitle: "Choose a stopped Saved Agent.",
  continueTaskPickPlaceholder: "Select an agent",
  continueTaskPickEmpty: "No eligible destination agents.",
  continueTaskDestStopped: "Stopped — available",
  continueTaskDestRunning: "Running — stop it first",
  continueTaskDestDetail: "Continue the unfinished task from {0}",
};

export { continueTaskCandidates, destinationBusy };

export function ContinuePicker({
  agents,
  fromName,
  strings: s = defaultContinuePickerStrings,
  onClose,
  onSelect,
}: {
  agents: readonly AgentVM[];
  fromName: string;
  strings?: ContinuePickerStrings;
  onClose: () => void;
  onSelect: (toName: string) => void;
}) {
  const candidates = continueTaskCandidates(agents, fromName);
  const items: QuickPickerItem[] = candidates.map((row) => {
    const busy = destinationBusy(row);
    return {
      id: row.name,
      label: row.name,
      description: busy ? s.continueTaskDestRunning : s.continueTaskDestStopped,
      detail: busy ? s.continueTaskDestRunning : s.continueTaskDestDetail.replace("{0}", fromName),
      disabled: busy,
      disabledReason: s.continueTaskDestRunning,
    };
  });
  return (
    <QuickPicker
      open
      data-testid="fleet-continue-picker"
      title={s.continueTaskPickTitle.replace("{0}", fromName)}
      subtitle={s.continueTaskPickSubtitle}
      placeholder={s.continueTaskPickPlaceholder}
      emptyText={s.continueTaskPickEmpty}
      items={items}
      onClose={onClose}
      onSelect={(item) => {
        onClose();
        onSelect(item.label);
      }}
    />
  );
}
