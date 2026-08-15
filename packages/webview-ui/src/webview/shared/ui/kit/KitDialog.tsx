import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
} from "../vendor/dialog";

// spec 342 T6 / t-c7e518 — thin re-exports under the `kit/` namespace (gate-fixed in T3: one host
// node around Overlay+Content so Presence does not call getComputedStyle on a Preact instance).
// Same posture as KitPopover — no pre-existing dialog primitive to fall back to.

export const KitDialog = Dialog;
export const KitDialogTrigger = DialogTrigger;
export const KitDialogContent = DialogContent;
export const KitDialogClose = DialogClose;
export const KitDialogHeader = DialogHeader;
export const KitDialogFooter = DialogFooter;
export const KitDialogTitle = DialogTitle;
export const KitDialogDescription = DialogDescription;
export const KitDialogOverlay = DialogOverlay;
export const KitDialogPortal = DialogPortal;
