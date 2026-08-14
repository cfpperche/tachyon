import type { HumanInboxCounts, HumanInboxItem } from "../../humanInbox/model.js";
import type { InboxArtifactPreview, InboxArtifactSummary } from "../../humanInbox/artifacts.js";
export interface HumanInboxViewModel {
  folder: string;
  wsHash: string;
  items: HumanInboxItem[];
  counts: HumanInboxCounts;
}

/**
 * One item, opened. `artifacts` is what the route previews inline; `artifactSummary` is the line
 * above them. An item with nothing attached has `artifacts: []` and a zeroed summary — the renderer
 * says "nothing attached", and there is no field here it could read as "evidence checked".
 */
export interface HumanInboxItemViewModel {
  folder: string;
  wsHash: string;
  item: HumanInboxItem;
  artifacts: InboxArtifactPreview[];
  artifactSummary: InboxArtifactSummary;
}
