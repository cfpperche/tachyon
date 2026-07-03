/**
 * spec 339 (F8) — the thin per-entity seam the rich-doc editor stack is consumed through: entity type +
 * the editor-tab labeling. Pin Studio and Task Studio each build their own adapter value; neither app
 * imports the other entity's stores/paths directly.
 */
export interface StudioAdapter {
  readonly entityType: "pin" | "task";
  newLabel(): string;
  editLabel(entityId: string): string;
}

export function createPinStudioAdapter(): StudioAdapter {
  return {
    entityType: "pin",
    newLabel: () => "New pin",
    editLabel: (pinId) => `Editing ${pinId}`,
  };
}
