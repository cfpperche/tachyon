import type { ConsentVM } from "../../plugins/consentViewModel";

export interface ConsentAckState {
  noRuntimeSelected?: boolean;
  anyReplace?: boolean;
  replaceAck?: boolean;
  mcpAck?: boolean;
  gitHookAck?: boolean;
  toolAck?: boolean;
  dataAck?: boolean;
}

export function isConsentBlocked(vm: ConsentVM, ack: ConsentAckState): boolean {
  return (vm.errors?.length ?? 0) > 0
    || ack.noRuntimeSelected === true
    || (ack.anyReplace === true && ack.replaceAck !== true)
    || (vm.requiresMcpConfirm === true && ack.mcpAck !== true)
    || (vm.requiresGitHookConfirm === true && ack.gitHookAck !== true)
    || (vm.requiresToolConfirm === true && ack.toolAck !== true)
    || (vm.requiresDataConfirm === true && ack.dataAck !== true);
}
