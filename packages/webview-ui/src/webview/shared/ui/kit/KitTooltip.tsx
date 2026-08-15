import { cloneElement, toChildArray, type ComponentChildren, type VNode } from "preact";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../vendor/tooltip";

// spec 342 T6 / t-c7e518 — house wrapper over the gate-fixed vendored Tooltip. The product job is to
// NAME an icon-only control (`label` becomes aria-label when the child has none). Composition pieces
// stay available for the same Trigger/Content shape as KitPopover.

export type KitTooltipSide = "top" | "right" | "bottom" | "left";

export interface KitTooltipProps {
  label: string;
  children: ComponentChildren;
  side?: KitTooltipSide;
  sideOffset?: number;
}

function namedTrigger(children: ComponentChildren, label: string): VNode {
  const [child] = toChildArray(children);
  if (typeof child === "object" && child !== null && "props" in child) {
    const vnode = child as VNode<Record<string, unknown>>;
    const existing = vnode.props["aria-label"] ?? vnode.props.title;
    return cloneElement(vnode, { "aria-label": existing ?? label });
  }
  return <span aria-label={label}>{children}</span>;
}

export function KitTooltip({ label, children, side = "top", sideOffset = 4 }: KitTooltipProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{namedTrigger(children, label)}</TooltipTrigger>
        <TooltipContent side={side} sideOffset={sideOffset}>
          {label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export const KitTooltipProvider = TooltipProvider;
export const KitTooltipRoot = Tooltip;
export const KitTooltipTrigger = TooltipTrigger;
export const KitTooltipContent = TooltipContent;
