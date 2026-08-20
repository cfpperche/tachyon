import type { ExtensionQueryV1, JsonValue } from "@tachyon/engine/runtime-api/extensionOperations.js";

/**
 * t-0ba30f — Control's Integrated Browser toggle reads this helper, never companion.status.
 *
 * Actor × trigger for the enabled bit shown in Settings:
 * - Interface / collect / engine answers config.ideBrowser.enabled → engine-loaded gate
 * - Interface / collect / engine refuses the query (older) or is offline → shell-loaded tachyon.yml
 * - Interface / collect / companion.status errors or is absent → does not change this bit
 * - Agent cannot reach extension.query; Tachyon itself has no second collect of this gate
 */
export async function readIdeBrowserEnabled(opts: {
  query: (input: ExtensionQueryV1) => Promise<JsonValue>;
  shellEnabled: boolean;
}): Promise<{ enabled: boolean }> {
  try {
    const raw = await opts.query({ action: "config.ideBrowser.enabled" });
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const enabled = (raw as { enabled?: unknown }).enabled;
      if (typeof enabled === "boolean") return { enabled: enabled === true };
    }
  } catch {
    /* older engine without the query, or offline — shell config remains */
  }
  return { enabled: opts.shellEnabled === true };
}
