import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "./lib/utils";

// spec 342 — vendored from shadcn/ui (registry: new-york-v4, component: tooltip). Adaptations from upstream:
// dropped the Next.js "use client" directive; `radix-ui` meta-package import → the project's exact-pinned
// `@radix-ui/react-tooltip`; `@/lib/utils` → `./lib/utils`. Plus the preact/compat open-bridge below —
// see VENDORED.md.

type TooltipOpenBridge = (open: boolean) => void;
const TooltipOpenBridgeContext = React.createContext<TooltipOpenBridge | null>(null);

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

function Tooltip({
  open: openProp,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  // t-c7e518 — Radix's uncontrolled trigger machine never flips `open` under preact/compat
  // (focusin/pointermove listeners fire; useControllableState stays false). Owning `open` here
  // and driving it from Trigger is the measured fix; portal/Presence/aria-describedby already work
  // once `open` is true. Popover/Dropdown/Select do not need this — they open on click.
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolledOpen;
  const setOpen = React.useCallback<TooltipOpenBridge>(
    (next) => {
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );
  return (
    <TooltipOpenBridgeContext.Provider value={setOpen}>
      <TooltipPrimitive.Root data-slot="tooltip" open={open} onOpenChange={setOpen} {...props} />
    </TooltipOpenBridgeContext.Provider>
  );
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  const setOpen = React.useContext(TooltipOpenBridgeContext);
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      onFocus={(event) => {
        setOpen?.(true);
        props.onFocus?.(event);
      }}
      onPointerMove={(event) => {
        if (event.pointerType !== "touch") setOpen?.(true);
        props.onPointerMove?.(event);
      }}
    />
  );
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 w-fit origin-(--radix-tooltip-content-transform-origin) animate-in rounded-md bg-foreground px-3 py-1.5 text-xs text-balance text-background fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className,
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] bg-foreground fill-foreground" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
