import type { ConsentVM } from "../../plugins/consentViewModel";

export interface ViewConsentRow {
  id: string;
  title: string;
  surface: string;
  entry: string;
  disclosure: string;
  actions: Array<{ name: string; disclosure: string }>;
}

export interface ViewAckRequirement {
  key: string;
  label: string;
}

export interface ConsentAckState {
  noRuntimeSelected?: boolean;
  anyReplace?: boolean;
  replaceAck?: boolean;
  mcpAck?: boolean;
  gitHookAck?: boolean;
  toolAck?: boolean;
  dataAck?: boolean;
  viewAck?: boolean;
  fleetReadAck?: boolean;
  actionAck?: Record<string, boolean>;
}

export function viewConsentRows(vm: ConsentVM): ViewConsentRow[] {
  return (vm.views ?? []).map((v) => ({
    id: v.id,
    title: v.title,
    surface: v.surface,
    entry: v.entry,
    disclosure: v.disclosure,
    actions: v.actions,
  }));
}

export function viewAckRequirements(vm: ConsentVM): ViewAckRequirement[] {
  const out: ViewAckRequirement[] = [];
  if (vm.requiresViewConfirm) out.push({ key: "view", label: "views" });
  if (vm.requiresFleetReadConfirm) out.push({ key: "fleetRead", label: "fleet summary" });
  for (const [key, label] of Object.entries(vm.requiresActionConfirm ?? {})) out.push({ key, label });
  return out;
}

export function isConsentBlocked(vm: ConsentVM, ack: ConsentAckState): boolean {
  const requiredActionConfirm = vm.requiresActionConfirm ?? {};
  const missingActionAck = Object.keys(requiredActionConfirm).some((k) => ack.actionAck?.[k] !== true);
  return (vm.errors?.length ?? 0) > 0
    || ack.noRuntimeSelected === true
    || (ack.anyReplace === true && ack.replaceAck !== true)
    || (vm.requiresMcpConfirm === true && ack.mcpAck !== true)
    || (vm.requiresGitHookConfirm === true && ack.gitHookAck !== true)
    || (vm.requiresViewConfirm === true && ack.viewAck !== true)
    || (vm.requiresFleetReadConfirm === true && ack.fleetReadAck !== true)
    || missingActionAck
    || (vm.requiresToolConfirm === true && ack.toolAck !== true)
    || (vm.requiresDataConfirm === true && ack.dataAck !== true);
}
