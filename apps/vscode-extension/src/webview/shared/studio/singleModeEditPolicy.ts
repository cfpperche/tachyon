/**
 * D13 reuses D12's close-with-pending-edit policy verbatim. These studios have ONE mode (edit), so
 * they never call `switchMode`; only the draft lifecycle is shared. Keeping one implementation is
 * the product guarantee that closing any document editor retains its dirty patch for this host process.
 */
export { TaskDocumentEditPolicy as SingleModeStudioEditPolicy } from "../../task-detail/editPolicy.js";
export type { TaskDocumentDraft as SingleModeStudioDraft } from "../../task-detail/editPolicy.js";
