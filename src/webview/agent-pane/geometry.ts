/**
 * Pure grid math for layer-2 agent pane.
 * Contract: PTY cols×rows must equal what xterm displays for full-screen TUI apps.
 */

export interface CellSize {
  cellWidth: number;
  cellHeight: number;
}

export interface GridSize {
  cols: number;
  rows: number;
}

/** Minimum viable TUI geometry (xterm + most full-screen apps). */
export const MIN_COLS = 2;
export const MIN_ROWS = 1;

/**
 * Compute character grid from container pixels and measured cell size.
 * Floors so we never claim more cells than fit (status bar stays on-screen).
 */
export function computeGrid(
  containerWidth: number,
  containerHeight: number,
  cell: CellSize,
): GridSize {
  const cw = Math.max(1, cell.cellWidth);
  const ch = Math.max(1, cell.cellHeight);
  const w = Math.max(0, Math.floor(containerWidth));
  const h = Math.max(0, Math.floor(containerHeight));
  return {
    cols: Math.max(MIN_COLS, Math.floor(w / cw)),
    rows: Math.max(MIN_ROWS, Math.floor(h / ch)),
  };
}

/** True when the grid changed enough to warrant a PTY resize. */
export function gridChanged(a: GridSize, b: GridSize): boolean {
  return a.cols !== b.cols || a.rows !== b.rows;
}

/**
 * Clamp typography that breaks full-screen TUI layout when mis-copied from settings.
 *
 * letterSpacing MUST stay 0: xterm's DOM renderer pads each glyph with CSS letter-spacing
 * so the glyph advance fills the cell; any extra option letterSpacing widens cells.
 * Font stacks must include real mono fallbacks (see agentPaneFont.ensureMonoFontStack) —
 * a proportional substitute sizes cells to 'W' and letter-spaces every other character.
 */
export function sanitizeFontMetrics(input: {
  fontFamily: string;
  fontSize: number;
  fontWeight: string | number;
  fontWeightBold: string | number;
  lineHeight: number;
  letterSpacing: number;
}): typeof input {
  const fontSize = Number.isFinite(input.fontSize) && input.fontSize > 0 ? Math.min(72, Math.max(8, input.fontSize)) : 14;
  const family = input.fontFamily.trim()
    || "DejaVu Sans Mono, Liberation Mono, Menlo, Monaco, Consolas, 'Courier New', monospace";
  return {
    fontFamily: family,
    fontSize,
    fontWeight: input.fontWeight,
    fontWeightBold: input.fontWeightBold,
    // Full-screen TUI packing only.
    lineHeight: 1,
    letterSpacing: 0,
  };
}
