# Spec 259 — Sidebar tab scroll — notes

_Created 2026-06-24._

## Design decisions

### 2026-06-24 — parent — Panel owns vertical scrolling

The sidebar root is now a fixed-height flex column. The active tab panel is the only flex child with vertical overflow; the search bar, tabs, section header, and Bridge footer stay outside that scroll container.

## Deviations

## Tradeoffs

### 2026-06-24 — parent — Footer in flex flow instead of fixed overlay

The previous fixed footer required JavaScript to add body padding and still let the body own scrolling. Keeping the footer as a normal flex child removes the overlay and makes the layout measurable without a runtime padding adjustment.

## Open questions
