import { describe, expect, it } from "vitest";
import { IDE_BROWSER_INSTANCES_DIR_NAME } from "../../src/ide-browser/protocol.js";
import { isIdeBrowserBridgeAvailable } from "../../src/ide-browser/client.js";

describe("ide-browser protocol", () => {
  it("instances dir name is stable", () => {
    expect(IDE_BROWSER_INSTANCES_DIR_NAME).toBe("ide-browser-instances");
  });

  it("reports unavailable when no instance files", () => {
    // Unlikely a real instance points at this synthetic root
    expect(isIdeBrowserBridgeAvailable("/tmp/tachyon-no-such-workspace-ide-browser")).toBe(false);
  });
});
