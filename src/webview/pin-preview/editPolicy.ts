/**
 * Pins inherit D12's task-document draft policy verbatim: the draft belongs to the document, not the
 * visible read/edit mode. Keeping the implementation shared prevents two editing policies in one product.
 */
export { TaskDocumentEditPolicy as PinDocumentEditPolicy } from "../task-detail/editPolicy.js";
export type { TaskDocumentDraft as PinDocumentDraft } from "../task-detail/editPolicy.js";
