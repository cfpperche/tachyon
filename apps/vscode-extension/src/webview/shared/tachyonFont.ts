import { sharedGlobalSettings } from "@tachyon/engine/config/globalSettings.js";

/** Current personal mono family. Default (tachyon) is absence — do not pass this to Agent Pane. */
export function shellTachyonFont(): { tachyonFont: "departure" } | Record<string, never> {
  return sharedGlobalSettings().current().fontMono === "departure" ? { tachyonFont: "departure" } : {};
}
