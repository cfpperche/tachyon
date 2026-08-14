export interface MenuPlacementInput {
  anchorX: number;
  anchorY: number;
  viewportWidth: number;
  viewportHeight: number;
  menuWidth: number;
  menuHeight: number;
  margin?: number;
  anchorOffset?: number;
}

export interface MenuPlacement {
  left: number;
  top: number;
}

const DEFAULT_MARGIN = 6;
const DEFAULT_ANCHOR_OFFSET = 8;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export function placeMoreMenu({
  anchorX,
  anchorY,
  viewportWidth,
  viewportHeight,
  menuWidth,
  menuHeight,
  margin = DEFAULT_MARGIN,
  anchorOffset = DEFAULT_ANCHOR_OFFSET,
}: MenuPlacementInput): MenuPlacement {
  const maxLeft = Math.max(margin, viewportWidth - menuWidth - margin);
  const maxTop = Math.max(margin, viewportHeight - menuHeight - margin);

  const rightWouldOverflow = anchorX - anchorOffset + menuWidth + margin > viewportWidth;
  const belowWouldOverflow = anchorY + menuHeight + margin > viewportHeight;

  const preferredLeft = rightWouldOverflow ? anchorX - menuWidth + anchorOffset : anchorX - anchorOffset;
  const preferredTop = belowWouldOverflow ? anchorY - menuHeight + anchorOffset : anchorY;

  return {
    left: clamp(preferredLeft, margin, maxLeft),
    top: clamp(preferredTop, margin, maxTop),
  };
}
