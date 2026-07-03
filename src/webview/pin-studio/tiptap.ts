/** spec 339 — moved to `../rich-doc/tiptap.ts` (entity-neutral); re-exported here (with the historical
 * `createPinEditor`/`PinImage`/`PinSketch` names) so existing pin-studio imports keep resolving unchanged. */
export {
  createRichDocEditor,
  createRichDocEditor as createPinEditor,
  RichDocImage,
  RichDocImage as PinImage,
  RichDocSketch,
  RichDocSketch as PinSketch,
} from "../rich-doc/tiptap.js";
