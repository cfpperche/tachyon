import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "../vendor/popover";

// spec 342 T6 — thin re-exports under the `kit/` namespace (gate-passed in T3: opens auto-focusing its
// first focusable field, Esc closes + restores focus, outside-click dismisses, portal renders outside
// #root — see notes.md's gate-results table). No legacy fallback flag: same posture as KitDropdown — no
// pre-existing popover component exists in shared/ui/ to fall back to. No pilot adopts KitPopover yet; it
// ships as an available primitive for a future surface (batch-1 acceptance only requires the wrapper exist
// with its a11y contract checked, not that every wrapper be deployed — see test/browser/kitA11y.test.ts).
export const KitPopover = Popover;
export const KitPopoverTrigger = PopoverTrigger;
export const KitPopoverContent = PopoverContent;
export const KitPopoverAnchor = PopoverAnchor;
export const KitPopoverHeader = PopoverHeader;
export const KitPopoverTitle = PopoverTitle;
export const KitPopoverDescription = PopoverDescription;
