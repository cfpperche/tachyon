import { FieldRow } from "../Field";

// spec 342 T4 — a thin re-export, not a reimplementation. The row-rhythm problem (spec's motivating dogfood:
// "same field-row rebuilt per surface with drifting heights/margins") is ALREADY solved by the existing
// `.ds-field-row` rhythm (design-system.css); the fix new surfaces need is importing it from the `kit/`
// namespace (so it can never be import-confused with anything legacy) alongside KitSelect/KitLabeledInput,
// not a second layout implementation. No legacy-fallback flag: there is only one implementation.
export const KitFieldRow = FieldRow;
