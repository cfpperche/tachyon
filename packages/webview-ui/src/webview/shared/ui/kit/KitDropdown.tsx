import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../vendor/dropdown-menu";

// spec 342 T4 — thin re-exports under the `kit/` namespace (gate-passed in T3; see notes.md's gate-results
// table). No legacy fallback flag: unlike Select, there is no pre-existing dropdown-menu component in
// shared/ui/ to fall back to — DropdownMenu is a wholly NEW capability here, same posture as the excluded
// Dialog, just on the passing side of the gate. If a future Radix bump regresses this component, there is
// no fallback to flip to yet; that would need building at that time.
export const KitDropdown = DropdownMenu;
export const KitDropdownTrigger = DropdownMenuTrigger;
export const KitDropdownContent = DropdownMenuContent;
export const KitDropdownItem = DropdownMenuItem;
export const KitDropdownSeparator = DropdownMenuSeparator;
