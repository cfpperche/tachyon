import { describe, expect, it } from "vitest";
import { RUNTIME_OPS_PROVIDERS_V2 } from "@tachyon/engine/runtimeOps/types.js";
import {
  isRuntimeOpsSetProviderObservationAction,
  runtimeOpsSetProviderObservationAction,
} from "@tachyon/webview-ui/webview/runtime-ops/messages.js";

describe("runtime ops provider observation messages", () => {
  it.each(RUNTIME_OPS_PROVIDERS_V2)("accepts the observation action for %s", (provider) => {
    expect(isRuntimeOpsSetProviderObservationAction(
      runtimeOpsSetProviderObservationAction(provider, true),
    )).toBe(true);
  });
});
